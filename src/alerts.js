// ─────────────────────────────────────────────
// alerts.js — chequeo liviano que corre cada hora (workflow alerts.yml).
//
// Para cada cliente con `alerts` en clients.json trae, directo de las APIs,
// el estado de las cuentas y el gasto/leads diarios del mes, y manda un mail
// si algo se sale de lo normal:
//   • cuenta frenada (Meta account_status ≠ activa, Google customer ≠ ENABLED,
//     o una cuenta que ayer gastó y hoy al mediodía no gastó nada) + aviso
//     cuando vuelve
//   • presupuesto: gasto del mes > presupuestoMensual, proyección de cierre de
//     mes > presupuestoMensual × 1,1, o gasto de ayer > gastoDiarioMax
//   • CPL de los últimos 3 días completos > cplMax
//   • leads de ayer < leadsMinDia, leads de los últimos 7 días < leadsMinSemana
//
// Cada alerta se manda UNA vez por período (día/semana/mes) para no spamear.
// El estado se guarda en ALERTS_STATE_PATH (default ~/.zimba-alerts/state.json,
// fuera del repo: el runner es el droplet propio y ese archivo persiste).
//
// Mail por SMTP (Brevo): SMTP_USER, SMTP_PASS, MAIL_FROM (opcional SMTP_HOST,
// SMTP_PORT). Sin esas variables corre en seco: loguea lo que mandaría.
//
// Uso:  node src/alerts.js            → chequeo normal
//       node src/alerts.js --test     → manda un mail de prueba a cada cliente
//       node src/alerts.js --dry      → no manda ni guarda estado, solo loguea
// ─────────────────────────────────────────────

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { pickLeads } from "./fetchers/meta.js";
import { creds, getAccessToken, runQuery } from "./fetchers/google.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "America/Argentina/Buenos_Aires";
const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry");
const TEST = ARGS.has("--test");
const STATE_PATH = process.env.ALERTS_STATE_PATH || join(homedir(), ".zimba-alerts", "state.json");
const REPORT_BASE = "https://reportes.zimba.com.ar";

// ── Fechas en hora Argentina ────────────────────────────────────────────────
const ymdTZ = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
const horaTZ = (d) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d));
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasDelMes = (ymd) => { const [y, m] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
function semanaISO(ymd) {
  const d = new Date(ymd + "T12:00:00Z"); const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia + 3);
  const y = d.getUTCFullYear(); const ene4 = new Date(Date.UTC(y, 0, 4));
  return `${y}-W${String(1 + Math.round(((d - ene4) / 864e5 - 3 + ((ene4.getUTCDay() + 6) % 7)) / 7)).padStart(2, "0")}`;
}

const AHORA = new Date();
const HOY = ymdTZ(AHORA);
const HORA = horaTZ(AHORA);
const AYER = addDays(HOY, -1);
const MES = HOY.slice(0, 7);
const DESDE = [addDays(HOY, -8), `${MES}-01`].sort()[0];

// ── Meta ────────────────────────────────────────────────────────────────────
const META_STATUS = {
  1: "activa", 2: "deshabilitada", 3: "con pago pendiente (Payment Needed)", 7: "en revisión de riesgo",
  8: "pendiente de liquidación", 9: "en período de gracia", 100: "pendiente de cierre", 101: "cerrada",
};
async function metaGet(path, params) {
  const token = process.env.META_ACCESS_TOKEN;
  const version = process.env.META_API_VERSION || "v25.0";
  if (!token) throw new Error("Falta META_ACCESS_TOKEN");
  const u = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) u.searchParams.set(k, v);
  for (let i = 0; i < 3; i++) {
    const res = await fetch(u, { signal: AbortSignal.timeout(60000) });
    const body = await res.json();
    if (!body.error) return body;
    if (![1, 2, 4, 17].includes(body.error.code) || i === 2) throw new Error(`Meta: ${body.error.message} (code ${body.error.code})`);
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
  }
}
async function leerMeta(acc) {
  const info = await metaGet(acc.id, { fields: "name,account_status,disable_reason,currency" });
  const ins = await metaGet(`${acc.id}/insights`, {
    level: "account", time_increment: "1", fields: "spend,actions",
    time_range: JSON.stringify({ since: DESDE, until: HOY }), limit: "100",
  });
  const dias = {};
  for (const r of ins.data || []) dias[r.date_start] = { spend: Number(r.spend) || 0, leads: pickLeads(r.actions, acc.leadTypes) };
  const st = Number(info.account_status);
  return {
    plataforma: "Meta", label: acc.label, id: acc.id, moneda: info.currency || acc.currency || "USD",
    activa: st === 1, estado: META_STATUS[st] || `estado ${st}`, dias,
  };
}

// ── Google ──────────────────────────────────────────────────────────────────
let googleSesion;
async function leerGoogle(g) {
  const cid = String(g.customerId).replace(/-/g, "");
  if (!googleSesion) { const c = creds(); googleSesion = { c, token: await getAccessToken(c) }; }
  const { c, token } = googleSesion;
  const [cust] = await runQuery(c, token, cid, "SELECT customer.status, customer.currency_code, customer.descriptive_name FROM customer");
  const filas = await runQuery(c, token, cid, `
    SELECT segments.date, metrics.cost_micros, metrics.conversions
    FROM customer WHERE segments.date BETWEEN '${DESDE}' AND '${HOY}'`);
  const dias = {};
  for (const r of filas) {
    const d = r.segments?.date; if (!d) continue;
    dias[d] = { spend: (Number(r.metrics?.costMicros) || 0) / 1e6, leads: Number(r.metrics?.conversions) || 0 };
  }
  const st = cust?.customer?.status || "DESCONOCIDO";
  return {
    plataforma: "Google", label: g.label || "Google", id: cid, moneda: cust?.customer?.currencyCode || "ARS",
    activa: st === "ENABLED", estado: st === "ENABLED" ? "activa" : st.toLowerCase(), dias,
  };
}

// ── Evaluación ──────────────────────────────────────────────────────────────
const fmt = (n, mon) => `${mon === "USD" ? "US$" : "$"}${n.toLocaleString("es-AR", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;

function evaluar(client, cuentas) {
  const a = client.alerts;
  const mon = a.moneda || client.defaultCurrency || "USD";
  const rate = Number(client.usdRate) || 1;
  // Pasa un monto de la moneda de la cuenta a la moneda de las alertas.
  const conv = (v, de) => (de === mon ? v : de === "USD" ? v * rate : mon === "USD" ? v / rate : v);
  const gasto = (fechas) => cuentas.reduce((s, cta) => s + fechas.reduce((t, f) => t + conv(cta.dias[f]?.spend || 0, cta.moneda), 0), 0);
  const leads = (fechas) => cuentas.reduce((s, cta) => s + fechas.reduce((t, f) => t + (cta.dias[f]?.leads || 0), 0), 0);
  const detalle = (fechas) => cuentas.map((cta) => {
    const g = fechas.reduce((t, f) => t + conv(cta.dias[f]?.spend || 0, cta.moneda), 0);
    const l = fechas.reduce((t, f) => t + (cta.dias[f]?.leads || 0), 0);
    return `${cta.plataforma} · ${cta.label}: gasto ${fmt(g, mon)}, ${Math.round(l)} leads${l ? `, CPL ${fmt(g / l, mon)}` : ""}`;
  }).join("\n");

  const rango = (desde, hasta) => { const out = []; for (let d = desde; d <= hasta; d = addDays(d, 1)) out.push(d); return out; };
  const mesHastaHoy = rango(`${MES}-01`, HOY);
  const ult3 = rango(addDays(HOY, -3), AYER);
  const ult7 = rango(addDays(HOY, -7), AYER);
  const alertas = []; // {key, asunto, cuerpo}
  const resueltas = []; // keys de "cuenta frenada" que volvieron

  // 1) Cuentas frenadas
  for (const cta of cuentas) {
    const kEstado = `estado:${cta.plataforma}:${cta.id}`;
    if (!cta.activa) {
      alertas.push({ key: kEstado, sticky: true, asunto: `🔴 ${cta.plataforma} ${cta.label} frenada: ${cta.estado}`,
        cuerpo: `La cuenta ${cta.plataforma} "${cta.label}" (${cta.id}) figura ${cta.estado}. Los anuncios no están saliendo.\n\nRevisar facturación / medio de pago en la plataforma.` });
    } else resueltas.push({ key: kEstado, asunto: `🟢 ${cta.plataforma} ${cta.label} volvió a estar activa`,
      cuerpo: `La cuenta ${cta.plataforma} "${cta.label}" (${cta.id}) vuelve a figurar activa.` });

    const ayerG = cta.dias[AYER]?.spend || 0, hoyG = cta.dias[HOY]?.spend || 0;
    if (cta.activa && HORA >= 12 && ayerG > 0 && hoyG === 0) {
      alertas.push({ key: `singasto:${cta.id}:${HOY}`, asunto: `🔴 ${cta.plataforma} ${cta.label} no gastó nada hoy`,
        cuerpo: `Son las ${HORA} hs y la cuenta ${cta.plataforma} "${cta.label}" no registra gasto hoy (ayer gastó ${fmt(conv(ayerG, cta.moneda), mon)}).\n\nPuede ser campañas pausadas, anuncios rechazados, presupuesto agotado o un problema de pago. Ojo: las plataformas reportan con algunas horas de demora.` });
    }
  }

  // 2) Presupuesto
  if (a.presupuestoMensual) {
    const gMes = gasto(mesHastaHoy);
    const diasCorridos = Number(HOY.slice(8)) - 1 + Math.max(HORA, 1) / 24;
    const proy = gMes / diasCorridos * diasDelMes(HOY);
    if (gMes > a.presupuestoMensual) {
      alertas.push({ key: `presu-pasado:${MES}`, asunto: `🔴 Nos pasamos del presupuesto del mes`,
        cuerpo: `Gasto del mes: ${fmt(gMes, mon)} contra un presupuesto de ${fmt(a.presupuestoMensual, mon)}.\n\n${detalle(mesHastaHoy)}` });
    } else if (Number(HOY.slice(8)) >= 4 && proy > a.presupuestoMensual * 1.1) {
      alertas.push({ key: `presu-ritmo:${semanaISO(HOY)}`, asunto: `🟠 Al ritmo actual nos pasamos del presupuesto`,
        cuerpo: `Llevamos ${fmt(gMes, mon)} y al ritmo actual cerramos el mes en ~${fmt(proy, mon)} (presupuesto ${fmt(a.presupuestoMensual, mon)}).\n\n${detalle(mesHastaHoy)}` });
    }
  }
  if (a.gastoDiarioMax) {
    const gAyer = gasto([AYER]);
    if (gAyer > a.gastoDiarioMax) alertas.push({ key: `diario:${AYER}`, asunto: `🟠 Ayer gastamos ${fmt(gAyer, mon)} (tope ${fmt(a.gastoDiarioMax, mon)})`,
      cuerpo: `Gasto de ayer (${AYER}): ${fmt(gAyer, mon)}, por encima del tope diario de ${fmt(a.gastoDiarioMax, mon)}.\n\n${detalle([AYER])}` });
  }

  // 3) CPL (3 días completos, para que un día flojo no dispare)
  if (a.cplMax) {
    const g = gasto(ult3), l = leads(ult3);
    const cpl = l ? g / l : Infinity;
    if (g > 0 && cpl > a.cplMax) alertas.push({ key: `cpl:${HOY}`, asunto: `🟠 CPL alto: ${l ? fmt(cpl, mon) : "sin leads"} (últimos 3 días)`,
      cuerpo: `CPL de los últimos 3 días (${ult3[0]} a ${AYER}): ${l ? fmt(cpl, mon) : "sin leads"}, tope ${fmt(a.cplMax, mon)}.\nGasto ${fmt(g, mon)}, ${Math.round(l)} leads.\n\n${detalle(ult3)}` });
  }

  // 4) Leads
  if (a.leadsMinDia != null && HORA >= 8) {
    const l = leads([AYER]);
    if (l < a.leadsMinDia) alertas.push({ key: `leads-dia:${AYER}`, asunto: `🟠 Ayer entraron solo ${Math.round(l)} leads (mínimo ${a.leadsMinDia})`,
      cuerpo: `Leads de ayer (${AYER}): ${Math.round(l)}, mínimo esperado ${a.leadsMinDia}.\n\n${detalle([AYER])}` });
  }
  if (a.leadsMinSemana != null) {
    const l = leads(ult7);
    if (l < a.leadsMinSemana) alertas.push({ key: `leads-semana:${semanaISO(HOY)}`, asunto: `🟠 Últimos 7 días: ${Math.round(l)} leads (mínimo ${a.leadsMinSemana})`,
      cuerpo: `Leads de los últimos 7 días (${ult7[0]} a ${AYER}): ${Math.round(l)}, mínimo esperado ${a.leadsMinSemana}.\n\n${detalle(ult7)}` });
  }
  return { alertas, resueltas };
}

// ── Mail ────────────────────────────────────────────────────────────────────
let transport;
async function mandar(client, asunto, cuerpo) {
  const to = client.alerts.to;
  const full = `${cuerpo}\n\n—\nReporte: ${REPORT_BASE}/${client.slug}.html\nAlerta automática de Zimba Reports (${HOY} ${HORA} hs ARG).`;
  const subject = `[${client.name}] ${asunto}`;
  const { SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
  if (DRY || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
    console.log(`  ✉ (seco) → ${to.join(", ")}\n    ${subject}\n    ${full.replace(/\n/g, "\n    ")}`);
    return false;
  }
  if (!transport) {
    const nm = (await import("nodemailer")).default;
    transport = nm.createTransport({ host: process.env.SMTP_HOST || "smtp-relay.brevo.com", port: Number(process.env.SMTP_PORT || 587),
      secure: false, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  }
  await transport.sendMail({ from: MAIL_FROM, to, subject, text: full });
  console.log(`  ✉ enviado → ${to.join(", ")}: ${subject}`);
  return true;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const clients = JSON.parse(await readFile(join(ROOT, "clients.json"), "utf8")).filter((c) => c.alerts?.to?.length);
  let state = {};
  try { state = JSON.parse(await readFile(STATE_PATH, "utf8")); } catch {}
  let fallos = 0;

  for (const client of clients) {
    console.log(`▶ ${client.name}`);
    if (TEST) { await mandar(client, "Prueba de alertas", "Si te llegó este mail, las alertas están andando."); continue; }
    const st = (state[client.slug] ||= {});
    const cuentas = [];
    const errores = [];
    for (const acc of client.sources.meta?.accounts || []) {
      try { cuentas.push(await leerMeta(acc)); } catch (e) { errores.push(`Meta ${acc.label}: ${e.message}`); }
    }
    const goog = client.sources.google;
    for (const g of (Array.isArray(goog) ? goog : goog ? [goog] : []).filter((g) => g.enabled && g.customerId)) {
      try { cuentas.push(await leerGoogle(g)); } catch (e) { errores.push(`Google ${g.label}: ${e.message}`); }
    }
    for (const cta of cuentas) console.log(`  ${cta.plataforma} ${cta.label}: ${cta.estado}, hoy ${(cta.dias[HOY]?.spend || 0).toFixed(2)} ${cta.moneda}, ayer ${(cta.dias[AYER]?.spend || 0).toFixed(2)} / ${cta.dias[AYER]?.leads || 0} leads`);
    errores.forEach((e) => console.log(`  ⚠ ${e}`));

    // Si una API falla 3 corridas seguidas avisamos (si no, una cuenta caída para la API pasa desapercibida).
    st._fallos = errores.length ? (st._fallos || 0) + 1 : 0;
    const { alertas, resueltas } = evaluar(client, cuentas);
    if (st._fallos >= 3) alertas.push({ key: `apifalla:${HOY}`, asunto: "⚠ No se pudieron leer algunas cuentas",
      cuerpo: `Las alertas no pudieron leer estas cuentas en las últimas ${st._fallos} corridas:\n${errores.join("\n")}` });

    for (const al of alertas) {
      if (st[al.key]) continue; // ya avisada en este período
      try { if (await mandar(client, al.asunto, al.cuerpo)) st[al.key] = HOY; }
      catch (e) { fallos++; console.log(`  ✖ mail: ${e.message}`); }
    }
    for (const r of resueltas) {
      if (!st[r.key]) continue;
      try { if (await mandar(client, r.asunto, r.cuerpo)) delete st[r.key]; }
      catch (e) { fallos++; console.log(`  ✖ mail: ${e.message}`); }
    }
    // Limpieza: claves con fecha de hace más de 40 días.
    for (const [k, v] of Object.entries(st)) if (typeof v === "string" && v < addDays(HOY, -40)) delete st[k];
  }

  if (!DRY && !TEST) { await mkdir(dirname(STATE_PATH), { recursive: true }); await writeFile(STATE_PATH, JSON.stringify(state, null, 1)); }
  if (fallos) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

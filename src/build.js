// ─────────────────────────────────────────────
// build.js — corre en GitHub Actions (3×/día) y en cada push.
//
// Trae los insights diarios de Meta (campaña y ad) de un rango que cubre todas
// las vistas, y vuelca las FILAS CRUDAS al JSON. Todo el cálculo (períodos,
// cuenta, campaña, KPIs, gráficos, creatives) lo hace el dashboard en el cliente.
// Así el filtro por campaña y los períodos salen sin recompilar nada.
// ─────────────────────────────────────────────

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto as crypto } from "node:crypto";
import { fetchMetaCampaignDaily, fetchMetaAdDaily, fetchMetaDemographics, fetchMetaDevices, fetchMetaThumbnails } from "./fetchers/meta.js";
import { fetchGoogleAll } from "./fetchers/google.js";
import { fetchTiktokCampaignDaily } from "./fetchers/tiktok.js";
import { fetchTiendanube } from "./fetchers/tiendanube.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
const ymd = (d) => d.toISOString().slice(0, 10);

// Traemos desde el 1 del mes de hace 2 meses: cubre todas las vistas y sus
// períodos anteriores comparables (mes pasado vs antemes, últimos 30 vs 30 previos).
function fetchWindow() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return { since: ymd(start), until: ymd(now) };
}

async function buildClient(client) {
  const meta = client.sources.meta;
  if (!meta?.accounts?.length) return null;
  const { since, until } = fetchWindow();

  const campaignRows = []; // {account, date, campaign_name, ...}
  const adRows = [];        // {account, date, campaign_name, adset_name, ad_name, ...}
  const demoRows = [];      // {account, date, age, gender, ...}
  const deviceRows = [];    // {account, date, device, ...}
  let thumbnails = {};      // { ad_name: thumbnail_url }
  const accounts = meta.accounts.map((a) => a.label);
  const accountModes = Object.fromEntries(meta.accounts.map((a) => [a.label, a.mode || "sales"]));

  for (const acc of meta.accounts) {
    const camps = await fetchMetaCampaignDaily({ adAccountId: acc.id }, since, until);
    const ads = await fetchMetaAdDaily({ adAccountId: acc.id }, since, until);
    for (const r of camps) campaignRows.push({ account: acc.label, ...r });
    for (const r of ads) adRows.push({ account: acc.label, ...r });

    // Breakdowns (best-effort: si alguno falla, seguimos sin romper el build)
    try {
      const demo = await fetchMetaDemographics({ adAccountId: acc.id }, since, until);
      for (const r of demo) demoRows.push({ account: acc.label, ...r });
    } catch (e) { console.warn(`  demografía ${acc.label}: ${e.message}`); }
    try {
      const dev = await fetchMetaDevices({ adAccountId: acc.id }, since, until);
      for (const r of dev) deviceRows.push({ account: acc.label, ...r });
    } catch (e) { console.warn(`  dispositivo ${acc.label}: ${e.message}`); }
    try {
      const adNames = ads.map((r) => r.ad_name);
      const th = await fetchMetaThumbnails({ adAccountId: acc.id }, adNames);
      thumbnails = { ...thumbnails, ...th };
    } catch (e) { console.warn(`  thumbnails ${acc.label}: ${e.message}`); }

    console.log(`  ${client.slug}/${acc.label}: ${camps.length} campaña, ${ads.length} ad, ${demoRows.length} demo, ${deviceRows.length} device`);
  }

  // ── Google Ads (opcional; solo si está habilitado en clients.json) ──
  let googleAdGroups = [];
  let googleKeywords = [];
  let googleByType = [];
  const g = client.sources.google;
  if (g?.enabled && g.customerId) {
    const label = g.label || "Google";
    try {
      const { campaigns, adGroups, keywords } = await fetchGoogleAll({ customerId: g.customerId }, since, until);
      for (const r of campaigns) campaignRows.push({ account: label, ...r });
      googleAdGroups = adGroups.map((r) => ({ account: label, ...r }));
      googleKeywords = keywords.map((r) => ({ account: label, ...r }));
      accounts.push(label);
      accountModes[label] = g.mode || "sales";
      console.log(`  ${client.slug}/${label}: ${campaigns.length} campaña, ${adGroups.length} adgroup, ${keywords.length} keyword (Google Ads)`);
    } catch (e) {
      console.warn(`  Google Ads ${label}: ${e.message}`);
    }
  }

  // ── TikTok Ads (opcional; solo si está habilitado en clients.json) ──
  const tk = client.sources.tiktok;
  if (tk?.enabled && tk.advertiserId) {
    const label = tk.label || "TikTok";
    try {
      const camps = await fetchTiktokCampaignDaily({ advertiserId: tk.advertiserId }, since, until);
      for (const r of camps) campaignRows.push({ account: label, ...r });
      accounts.push(label);
      accountModes[label] = tk.mode || "sales";
      console.log(`  ${client.slug}/${label}: ${camps.length} campaña (TikTok Ads)`);
    } catch (e) {
      console.warn(`  TikTok Ads ${label}: ${e.message}`);
    }
  }

  // ── Tienda Nube (opcional): ventas REALES del ecommerce ──
  let tienda = null;
  const tn = client.sources.tiendanube;
  if (tn?.enabled && tn.storeId) {
    try {
      tienda = await fetchTiendanube({ storeId: tn.storeId, tokenEnv: tn.tokenEnv }, since, until);
      const tot = tienda.daily.reduce((a, r) => a + r.orders, 0);
      const lost = tienda.lost.reduce((a, r) => a + r.orders, 0);
      console.log(`  ${client.slug}/TiendaNube: ${tot} órdenes pagadas, ${lost} perdidas, ${tienda.products.length} productos`);
    } catch (e) {
      console.warn(`  Tienda Nube: ${e.message}`);
    }
  }

  return {
    slug: client.slug,
    client: client.name,
    updatedAt: new Date().toISOString(),
    accounts,
    accountModes,
    campaignRows,
    adRows,
    demoRows,
    deviceRows,
    thumbnails,
    googleAdGroups,
    googleKeywords,
    tienda,
  };
}

// Resumen para el panel de agencia: filas diarias por plataforma (solo cuentas
// modo 'sales', que son las comparables por ROAS). Meta = todo lo que no sea
// Google/TikTok/Pinterest.
function agencyDaily(report) {
  const platOf = (a) => (a === "Google" ? "Google" : a === "TikTok" ? "TikTok" : a === "Pinterest" ? "Pinterest" : "Meta");
  const salesAccts = report.accounts.filter((a) => (report.accountModes[a] || "sales") === "sales");
  const daily = {};
  for (const r of report.campaignRows) {
    if (!salesAccts.includes(r.account)) continue;
    const plat = platOf(r.account);
    const k = `${r.date}|${plat}`;
    if (!daily[k]) daily[k] = { date: r.date, platform: plat, spend: 0, purchases: 0, revenue: 0 };
    daily[k].spend += r.spend; daily[k].purchases += r.purchases; daily[k].revenue += r.revenue;
  }
  return Object.values(daily);
}

// Encripta un texto con AES-GCM derivando la clave de la password (PBKDF2).
// Compatible con Web Crypto en el navegador (agencia.html desencripta igual).
async function encryptJSON(obj, password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  return { salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function main() {
  const clients = JSON.parse(await readFile(join(ROOT, "clients.json"), "utf8"));
  await mkdir(join(OUT, "data"), { recursive: true });

  const built = [];
  const agency = [];
  for (const client of clients) {
    console.log(`\n${client.name} (${client.slug})`);
    try {
      const report = await buildClient(client);
      if (!report) continue;
      await writeFile(join(OUT, "data", `${client.slug}.json`), JSON.stringify(report), "utf8");
      await copyFile(join(ROOT, "src", "dashboard.html"), join(OUT, `${client.slug}.html`));
      built.push({ slug: client.slug, name: client.name });
      agency.push({ slug: client.slug, name: client.name, objetivoMensual: client.objetivoMensual || 0, daily: agencyDaily(report) });
      console.log(`  ✓ ${client.slug} generado`);
    } catch (err) {
      console.error(`  ✗ ${client.slug}: ${err.message}`);
    }
  }

  // Panel de agencia (encriptado). Solo si hay contraseña configurada.
  const agencyPass = process.env.AGENCIA_PASSWORD;
  if (agencyPass) {
    const payload = { updatedAt: new Date().toISOString(), clients: agency };
    const enc = await encryptJSON(payload, agencyPass);
    await writeFile(join(OUT, "data", "agencia.enc.json"), JSON.stringify(enc), "utf8");
    await copyFile(join(ROOT, "src", "agencia.html"), join(OUT, "agencia.html"));
    console.log(`\n  ✓ panel de agencia generado (encriptado, ${agency.length} clientes)`);
  } else {
    console.log(`\n  · panel de agencia omitido (falta AGENCIA_PASSWORD)`);
  }

  const items = built.map((b) => `<li><a href="./${b.slug}.html">${b.name}</a></li>`).join("");
  await writeFile(join(OUT, "index.html"),
    `<!doctype html><meta charset="utf8"><title>Zimba · Reportes</title>` +
    `<body style="font-family:system-ui;background:#f6f7f9;color:#1a1d23;padding:40px">` +
    `<h1>Zimba · Reportes</h1><ul>${items || "<li>Sin reportes.</li>"}</ul>`, "utf8");

  console.log(`\n✔ Build listo. ${built.length} cliente(s).`);
}

main().catch((err) => { console.error("Build falló:", err); process.exit(1); });

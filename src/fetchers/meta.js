// Meta Ads — insights diarios (time_increment=1) a nivel campaña y a nivel ad.
// MANTENIMIENTO: Meta rota la versión ~cada 3 meses. Cambiá META_API_VERSION.

const PURCHASE_TYPES = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];
// Mayorista: no hay compras. Leads = conversión custom; Mensajes = conversaciones iniciadas.
const LEAD_TYPE = "offsite_conversion.custom.787145440823288";
const MSG_TYPE = "onsite_conversion.messaging_conversation_started_7d";

// ── Reintentos ──────────────────────────────────────────────────────────────
// Meta se cae sola cada tanto con errores opacos y transitorios. Sin reintentos,
// un parpadeo de 2 segundos deja al cliente sin esa cuenta hasta el próximo build.
// Códigos transitorios conocidos:
//   1   unknown error            2   service temporarily unavailable
//   4   application request limit reached
//   17  user request limit reached
//   32  page request limit       613 calls per hour exceeded
const TRANSIENT = new Set([1, 2, 4, 17, 32, 613]);

// PERO: hay dos subcódigos que vienen disfrazados de "transitorio" y no lo son.
// 1504043 y 1504044 significan "esta consulta pide demasiada data para responder
// sincrónicamente". Reintentarla es tiempo perdido — la misma consulta va a
// fallar siempre. Verificado el 19/8 en el Graph API Explorer: la cuenta
// Minorista de Chill Out a nivel ad con actions/action_values falla igual a 3
// meses que a 1 mes, mientras que sin esos dos campos responde en 3 segundos.
// Los marcamos como permanentes para cortar rápido y caer al async job.
const DEMASIADA_DATA = new Set([1504043, 1504044]);

const BACKOFF_MS = [3000, 8000, 20000, 45000]; // 4 reintentos, esperas crecientes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pide una URL y devuelve el JSON. Reintenta ante errores transitorios de Meta
// o caídas de red. Los errores permanentes (token inválido, permisos, y los
// subcódigos de "demasiada data") explotan en el acto.
async function fetchJSON(url, opciones = {}) {
  let lastErr;
  for (let intento = 0; intento <= BACKOFF_MS.length; intento++) {
    if (intento > 0) {
      const espera = BACKOFF_MS[intento - 1];
      console.warn(`    Meta reintento ${intento}/${BACKOFF_MS.length} en ${espera / 1000}s (${lastErr.message})`);
      await sleep(espera);
    }
    try {
      const res = await fetch(url, opciones);
      const body = await res.json();
      if (body.error) {
        const err = new Error(`Meta API: ${body.error.message} (code ${body.error.code}${body.error.error_subcode ? `/${body.error.error_subcode}` : ""})`);
        err.code = body.error.code;
        err.subcode = body.error.error_subcode;
        if (DEMASIADA_DATA.has(Number(err.subcode))) throw err;      // async job
        if (!TRANSIENT.has(Number(body.error.code))) throw err;      // permanente
        lastErr = err;
        continue;
      }
      return body;
    } catch (e) {
      if (DEMASIADA_DATA.has(Number(e.subcode))) throw e;
      if (e.code !== undefined && !TRANSIENT.has(Number(e.code))) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

const esDemasiadaData = (e) => DEMASIADA_DATA.has(Number(e?.subcode));

function pickAction(arr, type) {
  if (!Array.isArray(arr)) return 0;
  const h = arr.find((a) => a.action_type === type);
  return h ? Number(h.value) || 0 : 0;
}
function pickPurchase(arr) {
  if (!Array.isArray(arr)) return 0;
  for (const t of PURCHASE_TYPES) { const h = arr.find((a) => a.action_type === t); if (h) return Number(h.value) || 0; }
  return 0;
}
function base(adAccountId) {
  const token = process.env.META_ACCESS_TOKEN;
  const version = process.env.META_API_VERSION || "v25.0";
  if (!token) throw new Error("Falta META_ACCESS_TOKEN");
  if (!adAccountId) throw new Error("Falta adAccountId");
  return { token, version };
}
async function fetchAll(url) {
  const out = []; let next = url, guard = 0;
  while (next && guard < 200) {
    const body = await fetchJSON(next);
    if (!Array.isArray(body.data)) throw new Error("Meta API: sin 'data'");
    out.push(...body.data); next = body.paging?.next || null; guard++;
  }
  return out;
}

// ── Async insights job ──────────────────────────────────────────────────────
// El camino que Meta documenta para consultas que no entran sincrónicamente:
// 1) POST al mismo endpoint /insights → devuelve un report_run_id
// 2) se consulta ese id hasta que async_status sea "Job Completed"
// 3) se leen los resultados en /{report_run_id}/insights, paginando normal
// Tarda más que una consulta directa, pero no tiene el límite de tiempo de
// respuesta que es justo lo que nos está matando en Minorista.
const POLL_MS = 5000;          // cada cuánto preguntamos si terminó
const POLL_MAX = 120;          // 120 × 5s = 10 minutos de techo

async function insightsAsync(params, { token, version, adAccountId }) {
  const url = new URL(`https://graph.facebook.com/${version}/${adAccountId}/insights`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const inicio = await fetchJSON(url.toString(), { method: "POST" });
  const runId = inicio.report_run_id;
  if (!runId) throw new Error("Meta API: el async job no devolvió report_run_id");
  console.log(`    Meta: async job ${runId} lanzado (la consulta no entra sincrónica)`);

  const estadoUrl = new URL(`https://graph.facebook.com/${version}/${runId}`);
  estadoUrl.searchParams.set("access_token", token);
  estadoUrl.searchParams.set("fields", "async_status,async_percent_completion");

  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(POLL_MS);
    const estado = await fetchJSON(estadoUrl.toString());
    const status = estado.async_status;
    if (status === "Job Completed") {
      const res = new URL(`https://graph.facebook.com/${version}/${runId}/insights`);
      res.searchParams.set("access_token", token);
      res.searchParams.set("limit", "500");
      const filas = await fetchAll(res.toString());
      console.log(`    Meta: async job ${runId} listo (${filas.length} filas)`);
      return filas;
    }
    if (status === "Job Failed" || status === "Job Skipped") {
      throw new Error(`Meta API: async job ${runId} terminó en "${status}"`);
    }
  }
  throw new Error(`Meta API: async job ${runId} no terminó en ${(POLL_MS * POLL_MAX) / 60000} minutos`);
}

// Trae insights: primero por la vía rápida y, si Meta dice que la consulta es
// demasiado grande, por el async job. Las cuentas que hoy andan bien (Bacan,
// Mayorista) nunca llegan al segundo camino.
async function insights(params, ctx) {
  const url = new URL(`https://graph.facebook.com/${ctx.version}/${ctx.adAccountId}/insights`);
  url.searchParams.set("access_token", ctx.token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    return await fetchAll(url.toString());
  } catch (e) {
    if (!esDemasiadaData(e)) throw e;
    return await insightsAsync(params, ctx);
  }
}

export async function fetchMetaCampaignDaily({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const rows = await insights({
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: "campaign_name,spend,impressions,clicks,actions,action_values",
    limit: "500",
  }, { token, version, adAccountId });
  return rows.map((r) => ({
    date: r.date_start, campaign_name: r.campaign_name,
    spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    purchases: pickPurchase(r.actions), revenue: pickPurchase(r.action_values),
    leads: pickAction(r.actions, LEAD_TYPE), messages: pickAction(r.actions, MSG_TYPE),
  }));
}

export async function fetchMetaAdDaily({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const rows = await insights({
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: "ad_name,adset_name,campaign_name,spend,impressions,clicks,actions,action_values",
    limit: "500",
  }, { token, version, adAccountId });
  return rows.map((r) => ({
    date: r.date_start, ad_name: r.ad_name, adset_name: r.adset_name || "", campaign_name: r.campaign_name || "",
    spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    purchases: pickPurchase(r.actions), revenue: pickPurchase(r.action_values),
    leads: pickAction(r.actions, LEAD_TYPE), messages: pickAction(r.actions, MSG_TYPE),
  }));
}

// Demografía: breakdown age,gender (a nivel cuenta, agregado del período).
export async function fetchMetaDemographics({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const rows = await insights({
    level: "account",
    breakdowns: "age,gender",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: "impressions,clicks,spend,actions,action_values",
    limit: "500",
  }, { token, version, adAccountId });
  return rows.map((r) => ({
    date: r.date_start, age: r.age, gender: r.gender,
    impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    spend: Number(r.spend) || 0, purchases: pickPurchase(r.actions), revenue: pickPurchase(r.action_values),
    leads: pickAction(r.actions, LEAD_TYPE), messages: pickAction(r.actions, MSG_TYPE),
  }));
}

// Dispositivo: breakdown impression_device (a nivel cuenta, agregado del período).
export async function fetchMetaDevices({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const rows = await insights({
    level: "account",
    breakdowns: "impression_device",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: "impressions,clicks,spend,actions,action_values",
    limit: "500",
  }, { token, version, adAccountId });
  return rows.map((r) => ({
    date: r.date_start, device: r.impression_device,
    impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    spend: Number(r.spend) || 0, purchases: pickPurchase(r.actions), revenue: pickPurchase(r.action_values),
    leads: pickAction(r.actions, LEAD_TYPE), messages: pickAction(r.actions, MSG_TYPE),
  }));
}

// Thumbnails: en cuentas grandes, pedir TODOS los ads con su creativo satura la
// API ("reduce the amount of data"). En vez de eso, traemos el thumbnail solo de
// los ads que tuvieron actividad en el período (los que la tabla puede mostrar).
// adNames: lista de ad_name que aparecen en insights.
export async function fetchMetaThumbnails({ adAccountId }, adNames = []) {
  const { token, version } = base(adAccountId);
  const wanted = new Set(adNames);
  const map = {};
  // Recorremos los ads de la cuenta en páginas chicas y nos quedamos solo con los
  // que están en la lista de activos. Cortamos cuando ya los encontramos a todos.
  const url = new URL(`https://graph.facebook.com/${version}/${adAccountId}/ads`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("fields", "name,creative{thumbnail_url}");
  url.searchParams.set("limit", "25");
  url.searchParams.set("effective_status", JSON.stringify(["ACTIVE", "PAUSED"]));
  let next = url.toString(), guard = 0;
  while (next && guard < 400) {
    let body;
    try {
      body = await fetchJSON(next); // con reintentos
    } catch (e) { console.warn(`    thumbnails aviso: ${e.message}`); break; }
    for (const ad of body.data || []) {
      if (ad.name && ad.creative?.thumbnail_url && (wanted.size === 0 || wanted.has(ad.name))) {
        map[ad.name] = ad.creative.thumbnail_url;
      }
    }
    if (wanted.size > 0 && Object.keys(map).length >= wanted.size) break; // ya están todos
    next = body.paging?.next || null; guard++;
  }
  console.log(`    thumbnails: ${Object.keys(map).length}/${wanted.size || "?"} con miniatura`);
  return map;
}

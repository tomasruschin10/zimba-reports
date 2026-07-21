// Meta Ads — insights diarios (time_increment=1) a nivel campaña y a nivel ad.
// MANTENIMIENTO: Meta rota la versión ~cada 3 meses. Cambiá META_API_VERSION.

const PURCHASE_TYPES = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];
// Mayorista: no hay compras. Leads = conversión custom; Mensajes = conversaciones iniciadas.
const LEAD_TYPE = "offsite_conversion.custom.787145440823288";
const MSG_TYPE = "onsite_conversion.messaging_conversation_started_7d";

// ── Reintentos ──────────────────────────────────────────────────────────────
// Meta se cae sola cada tanto con errores opacos y transitorios (sobre todo en
// cuentas grandes, donde la consulta es más pesada). Sin reintentos, un parpadeo
// de 2 segundos deja al cliente sin esa cuenta hasta el próximo build.
// Códigos transitorios conocidos:
//   1   unknown error            2   service temporarily unavailable
//   4   application request limit reached
//   17  user request limit reached
//   32  page request limit       613 calls per hour exceeded
const TRANSIENT = new Set([1, 2, 4, 17, 32, 613]);
const BACKOFF_MS = [3000, 8000, 20000, 45000]; // 4 reintentos, esperas crecientes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pide una URL y devuelve el JSON. Reintenta ante errores transitorios de Meta
// o caídas de red. Los errores permanentes (token inválido, permisos) explotan
// en el acto: reintentarlos no sirve de nada.
async function fetchJSON(url) {
  let lastErr;
  for (let intento = 0; intento <= BACKOFF_MS.length; intento++) {
    if (intento > 0) {
      const espera = BACKOFF_MS[intento - 1];
      console.warn(`    Meta reintento ${intento}/${BACKOFF_MS.length} en ${espera / 1000}s (${lastErr.message})`);
      await sleep(espera);
    }
    try {
      const res = await fetch(url);
      const body = await res.json();
      if (body.error) {
        const err = new Error(`Meta API: ${body.error.message} (code ${body.error.code})`);
        err.code = body.error.code;
        if (!TRANSIENT.has(Number(body.error.code))) throw err; // permanente: cortamos
        lastErr = err;
        continue;
      }
      return body;
    } catch (e) {
      // Error de red / JSON roto: también vale reintentar.
      if (e.code !== undefined && !TRANSIENT.has(Number(e.code))) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

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
  const version = process.env.META_API_VERSION || "v21.0";
  if (!token) throw new Error("Falta META_ACCESS_TOKEN");
  if (!adAccountId) throw new Error("Falta adAccountId");
  return { token, version };
}
async function fetchAll(url) {
  const out = []; let next = url, guard = 0;
  while (next && guard < 80) {
    const body = await fetchJSON(next);
    if (!Array.isArray(body.data)) throw new Error("Meta API: sin 'data'");
    out.push(...body.data); next = body.paging?.next || null; guard++;
  }
  return out;
}
export async function fetchMetaCampaignDaily({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const url = new URL(`https://graph.facebook.com/${version}/${adAccountId}/insights`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("level", "campaign");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("fields", "campaign_name,spend,impressions,clicks,actions,action_values");
  url.searchParams.set("limit", "500");
  const rows = await fetchAll(url.toString());
  return rows.map((r) => ({
    date: r.date_start, campaign_name: r.campaign_name,
    spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    purchases: pickPurchase(r.actions), revenue: pickPurchase(r.action_values),
    leads: pickAction(r.actions, LEAD_TYPE), messages: pickAction(r.actions, MSG_TYPE),
  }));
}
export async function fetchMetaAdDaily({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const url = new URL(`https://graph.facebook.com/${version}/${adAccountId}/insights`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("level", "ad");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("fields", "ad_name,adset_name,campaign_name,spend,impressions,clicks,actions,action_values");
  url.searchParams.set("limit", "500");
  const rows = await fetchAll(url.toString());
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
  const url = new URL(`https://graph.facebook.com/${version}/${adAccountId}/insights`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("level", "account");
  url.searchParams.set("breakdowns", "age,gender");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("fields", "impressions,clicks,spend,actions,action_values");
  url.searchParams.set("limit", "500");
  const rows = await fetchAll(url.toString());
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
  const url = new URL(`https://graph.facebook.com/${version}/${adAccountId}/insights`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("level", "account");
  url.searchParams.set("breakdowns", "impression_device");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("fields", "impressions,clicks,spend,actions,action_values");
  url.searchParams.set("limit", "500");
  const rows = await fetchAll(url.toString());
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

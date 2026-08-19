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

// ── Ventanas de tiempo ──────────────────────────────────────────────────────
// Los reintentos solos no alcanzan: si Meta corta la consulta por PESADA (code 1
// o 2 en cuentas grandes), reintentar manda exactamente la misma consulta y
// vuelve a fallar. La cuenta Minorista de Chill Out (~621 campañas / 2377 ads)
// cruza ese umbral; Bacan (206 / 973) no. Por eso siempre cae la misma.
// La salida es pedir menos por vez: partimos el rango en ventanas y, si una
// ventana igual falla, la partimos al medio y reintentamos cada mitad, hasta
// llegar a un solo día. Así se adapta sola al tamaño de cada cuenta.
const VENTANA_CAMPAÑA = 30; // días por request a nivel campaña / demo / device
const VENTANA_AD = 14;      // nivel ad es mucho más pesado: ventanas más chicas

const aFecha = (iso) => new Date(`${iso}T00:00:00Z`);
const aISO = (d) => d.toISOString().slice(0, 10);
function sumarDias(iso, n) {
  const d = aFecha(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return aISO(d);
}
function diasEntre(desde, hasta) {
  return Math.round((aFecha(hasta) - aFecha(desde)) / 86400000);
}
// Corta [since, until] en tramos de a lo sumo `dias`.
function partirRango(since, until, dias) {
  const tramos = [];
  let ini = since;
  while (diasEntre(ini, until) >= 0) {
    const fin = sumarDias(ini, dias - 1);
    tramos.push([ini, diasEntre(fin, until) > 0 ? until : fin]);
    ini = sumarDias(fin, 1);
  }
  return tramos;
}

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

// Trae una ventana. Si falla igual (después de los reintentos), la parte al
// medio y reintenta cada mitad. Corta cuando la ventana ya es de un solo día:
// si un día suelto no entra, el problema no es el tamaño y hay que enterarse.
async function traerVentana(armarUrl, since, until) {
  try {
    return await fetchAll(armarUrl(since, until));
  } catch (e) {
    if (since === until) throw e;
    const mitad = sumarDias(since, Math.floor(diasEntre(since, until) / 2));
    console.warn(`    Meta: ventana ${since}→${until} no entró (${e.message}); la parto en dos`);
    const a = await traerVentana(armarUrl, since, mitad);
    const b = await traerVentana(armarUrl, sumarDias(mitad, 1), until);
    return [...a, ...b];
  }
}

// Recorre todo el rango en ventanas y junta las filas. Como time_increment=1 y
// las ventanas no se pisan, concatenar alcanza: no hay filas duplicadas.
async function traerRango(armarUrl, since, until, dias) {
  const filas = [];
  for (const [ini, fin] of partirRango(since, until, dias)) {
    filas.push(...await traerVentana(armarUrl, ini, fin));
  }
  return filas;
}

// Arma la URL de insights con los parámetros comunes.
function urlInsights({ token, version, adAccountId, level, fields, breakdowns }) {
  return (since, until) => {
    const url = new URL(`https://graph.facebook.com/${version}/${adAccountId}/insights`);
    url.searchParams.set("access_token", token);
    url.searchParams.set("level", level);
    url.searchParams.set("time_increment", "1");
    url.searchParams.set("time_range", JSON.stringify({ since, until }));
    url.searchParams.set("fields", fields);
    if (breakdowns) url.searchParams.set("breakdowns", breakdowns);
    url.searchParams.set("limit", "500");
    return url.toString();
  };
}

export async function fetchMetaCampaignDaily({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const armarUrl = urlInsights({
    token, version, adAccountId, level: "campaign",
    fields: "campaign_name,spend,impressions,clicks,actions,action_values",
  });
  const rows = await traerRango(armarUrl, since, until, VENTANA_CAMPAÑA);
  return rows.map((r) => ({
    date: r.date_start, campaign_name: r.campaign_name,
    spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    purchases: pickPurchase(r.actions), revenue: pickPurchase(r.action_values),
    leads: pickAction(r.actions, LEAD_TYPE), messages: pickAction(r.actions, MSG_TYPE),
  }));
}

export async function fetchMetaAdDaily({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const armarUrl = urlInsights({
    token, version, adAccountId, level: "ad",
    fields: "ad_name,adset_name,campaign_name,spend,impressions,clicks,actions,action_values",
  });
  const rows = await traerRango(armarUrl, since, until, VENTANA_AD);
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
  const armarUrl = urlInsights({
    token, version, adAccountId, level: "account", breakdowns: "age,gender",
    fields: "impressions,clicks,spend,actions,action_values",
  });
  const rows = await traerRango(armarUrl, since, until, VENTANA_CAMPAÑA);
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
  const armarUrl = urlInsights({
    token, version, adAccountId, level: "account", breakdowns: "impression_device",
    fields: "impressions,clicks,spend,actions,action_values",
  });
  const rows = await traerRango(armarUrl, since, until, VENTANA_CAMPAÑA);
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

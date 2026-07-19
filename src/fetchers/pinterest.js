// ─────────────────────────────────────────────
// Pinterest Ads — reporte diario por campaña (Pinterest API v5).
//
// Credenciales (env / secrets de GitHub):
//   PINTEREST_ACCESS_TOKEN — token OAuth con scope `ads:read`.
//                            ⚠️ El refresh token de Pinterest vence cada 60 días:
//                            hay que renovarlo (ver nota al pie).
//
// El adAccountId de cada cliente va en clients.json → sources.pinterest.adAccountId.
//
// Particularidades de la API de Pinterest (verificadas en la doc v5):
//   - El endpoint de analytics de campañas EXIGE `campaign_ids`: primero hay que
//     listar las campañas de la cuenta y pasar sus IDs (de a tandas).
//   - Solo permite 90 días de historia y máx 90 días por request → recortamos.
//   - Los importes vienen en MICRO unidades de la moneda (dividir por 1.000.000).
//   - Analytics no devuelve el nombre de campaña: lo cruzamos por CAMPAIGN_ID.
//
// ⚠️ ESCRITO SIN PROBAR (la app está en "Trial access pending"). Al primer test
// real revisar sobre todo los nombres de las métricas de conversión: si alguna
// es inválida, la API tira 400 y el fetcher reintenta solo con las básicas —
// el warning del log te va a decir cuál falló.
// ─────────────────────────────────────────────
const BASE = "https://api.pinterest.com/v5";
const MAX_DAYS = 90;        // límite duro de la API
const IDS_PER_CALL = 50;    // campaign_ids por request

// Métricas base (seguras) y de conversión (las candidatas a ajustar).
const BASE_METRICS = ["SPEND_IN_DOLLAR", "PAID_IMPRESSION", "TOTAL_CLICKTHROUGH"];
const CONV_METRICS = ["TOTAL_CHECKOUT", "TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR"];

function token() {
  const t = process.env.PINTEREST_ACCESS_TOKEN;
  if (!t) throw new Error("Falta PINTEREST_ACCESS_TOKEN");
  return t;
}

async function api(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token()}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.message || body.error_description || `HTTP ${res.status}`;
    const err = new Error(`Pinterest API: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const ymd = (d) => d.toISOString().slice(0, 10);
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// Pinterest solo sirve 90 días hacia atrás: recortamos el `since` si hace falta.
function clampSince(since) {
  const floor = addDays(ymd(new Date()), -(MAX_DAYS - 1));
  return since < floor ? floor : since;
}
const micro = (v) => (Number(v) || 0) / 1e6;

// Lista todas las campañas de la cuenta (paginado por bookmark) → {id: nombre}
async function fetchCampaignNames(adAccountId) {
  const names = {};
  let bookmark = null, guard = 0;
  do {
    const p = { page_size: "100" };
    if (bookmark) p.bookmark = bookmark;
    const body = await api(`/ad_accounts/${adAccountId}/campaigns`, p);
    for (const it of body.items || []) names[String(it.id)] = it.name || "(sin nombre)";
    bookmark = body.bookmark || null;
  } while (bookmark && ++guard < 20);
  return names;
}

// Trae analytics de una tanda de campañas. Si la API rechaza las métricas de
// conversión (400), reintenta solo con las básicas para no perder todo.
async function fetchChunk(adAccountId, ids, since, until, warn) {
  const call = (cols) => api(`/ad_accounts/${adAccountId}/campaigns/analytics`, {
    campaign_ids: ids.join(","),
    start_date: since,
    end_date: until,
    columns: cols.join(","),
    granularity: "DAY",
  });
  try {
    return await call([...BASE_METRICS, ...CONV_METRICS]);
  } catch (e) {
    if (e.status === 400) {
      warn(`métricas de conversión rechazadas (${e.message}); sigo solo con inversión/clicks`);
      return await call(BASE_METRICS);
    }
    throw e;
  }
}

// config: { adAccountId }. since/until: 'YYYY-MM-DD'.
export async function fetchPinterestCampaignDaily(config, since, until) {
  const adAccountId = String(config.adAccountId || "").trim();
  if (!adAccountId) throw new Error("Falta sources.pinterest.adAccountId en clients.json");
  const warn = (m) => console.warn(`    Pinterest: ${m}`);

  const names = await fetchCampaignNames(adAccountId);
  const ids = Object.keys(names);
  if (!ids.length) return [];

  const from = clampSince(since);
  const rows = [];
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) {
    const chunk = ids.slice(i, i + IDS_PER_CALL);
    const body = await fetchChunk(adAccountId, chunk, from, until, warn);
    const list = Array.isArray(body) ? body : (body.items || body.data || []);
    for (const it of list) {
      const cid = String(it.CAMPAIGN_ID ?? it.campaign_id ?? "");
      rows.push({
        date: String(it.DATE || it.date || "").slice(0, 10),
        campaign_name: names[cid] || "(sin nombre)",
        spend: Number(it.SPEND_IN_DOLLAR) || 0,
        impressions: Number(it.PAID_IMPRESSION) || 0,
        clicks: Number(it.TOTAL_CLICKTHROUGH) || 0,
        purchases: Number(it.TOTAL_CHECKOUT) || 0,
        revenue: micro(it.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR),
      });
    }
  }
  return rows.filter((r) => r.date);
}

// NOTA sobre el token: Pinterest da access_token (corto) + refresh_token (60 días).
// Como el build corre en GitHub Actions sin intervención, lo más simple es guardar
// un access_token de larga duración y renovarlo cuando venza. Si más adelante
// molesta, se puede guardar el refresh_token como secret y canjearlo en cada build.

// ─────────────────────────────────────────────
// TikTok Ads — reporte diario por campaña (Reporting API v1.3).
//
// Credenciales (env / secrets de GitHub):
//   TIKTOK_ACCESS_TOKEN   — token de larga duración (para Marketing API no expira).
//   TIKTOK_API_VERSION    — opcional; default v1.3.
//
// El advertiser_id de cada cliente va en clients.json → sources.tiktok.advertiserId.
//
// Facturación: revenue = spend * complete_payment_roas (TikTok no tiene campo
// de valor de compra estable).
// Límite API: con stat_time_day, máx 30 días por request → partimos en ventanas.
// ─────────────────────────────────────────────
const BASE = "https://business-api.tiktok.com/open_api";
const PURCHASE_METRIC = "complete_payment";        // nº de compras (pago completado)
const ROAS_METRIC = "complete_payment_roas";       // ROAS de compras → revenue = spend * roas
const METRICS = ["campaign_name", "spend", "impressions", "clicks", PURCHASE_METRIC, ROAS_METRIC];
const MAX_DAYS = 30;

function creds() {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) throw new Error("Falta TIKTOK_ACCESS_TOKEN");
  return { token, version: process.env.TIKTOK_API_VERSION || "v1.3" };
}

// Suma días a 'YYYY-MM-DD' (en UTC, para no correrse por zona horaria).
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Trae una ventana (<=30 días) con paginado, empujando filas a `rows`.
async function fetchWindowInto(rows, ctx, since, until) {
  const { advertiserId, token, version } = ctx;
  let page = 1, totalPages = 1;
  do {
    const url = new URL(`${BASE}/${version}/report/integrated/get/`);
    url.searchParams.set("advertiser_id", advertiserId);
    url.searchParams.set("report_type", "BASIC");
    url.searchParams.set("data_level", "AUCTION_CAMPAIGN");
    url.searchParams.set("dimensions", JSON.stringify(["stat_time_day", "campaign_id"]));
    url.searchParams.set("metrics", JSON.stringify(METRICS));
    url.searchParams.set("start_date", since);
    url.searchParams.set("end_date", until);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "1000");
    const res = await fetch(url.toString(), { headers: { "Access-Token": token } });
    const body = await res.json();
    if (body.code !== 0) {
      throw new Error(`TikTok API (code ${body.code}): ${body.message}`);
    }
    const list = body.data?.list || [];
    for (const item of list) {
      const d = item.dimensions || {};
      const m = item.metrics || {};
      const rawDate = d.stat_time_day || "";
      const spend = Number(m.spend) || 0;
      const roas = Number(m[ROAS_METRIC]) || 0;
      rows.push({
        date: rawDate.slice(0, 10),
        campaign_name: m.campaign_name || "(sin nombre)",
        spend: spend,
        impressions: Number(m.impressions) || 0,
        clicks: Number(m.clicks) || 0,
        purchases: Number(m[PURCHASE_METRIC]) || 0,
        revenue: spend * roas,
      });
    }
    totalPages = body.data?.page_info?.total_page || 1;
    page++;
  } while (page <= totalPages && page < 50);
}

// config: { advertiserId }. since/until: 'YYYY-MM-DD'.
export async function fetchTiktokCampaignDaily(config, since, until) {
  const advertiserId = String(config.advertiserId || "").trim();
  if (!advertiserId) throw new Error("Falta sources.tiktok.advertiserId en clients.json");
  const { token, version } = creds();
  const ctx = { advertiserId, token, version };

  const rows = [];
  // Partimos [since, until] en ventanas de <=30 días (límite de TikTok con stat_time_day).
  let winStart = since;
  while (winStart <= until) {
    let winEnd = addDays(winStart, MAX_DAYS - 1);
    if (winEnd > until) winEnd = until;
    await fetchWindowInto(rows, ctx, winStart, winEnd);
    winStart = addDays(winEnd, 1);
  }
  return rows;
}

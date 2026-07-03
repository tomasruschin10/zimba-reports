// ─────────────────────────────────────────────
// TikTok Ads — reporte diario por campaña (Reporting API v1.3).
//
// Credenciales (env / secrets de GitHub):
//   TIKTOK_ACCESS_TOKEN   — token de larga duración (generado al autorizar la
//                           cuenta; para Marketing API no expira / dura mucho).
//   TIKTOK_API_VERSION    — opcional; default v1.3.
//
// El advertiser_id de cada cliente (la cuenta de TikTok Ads a leer) va en
// clients.json, en sources.tiktok.advertiserId.
//
// ⚠️ ESCRITO A CIEGAS (sin poder probar hasta que TikTok apruebe la app).
// Al primer test real, revisar sobre todo:
//   - Nombres de métricas de valor/conversión (REVENUE_METRIC, PURCHASE_METRIC).
//     TikTok tiene muchas variantes (complete_payment, total_complete_payment,
//     onsite_shopping, etc.) según cómo mida Chill Out las compras.
//   - Formato de stat_time_day (suele venir "YYYY-MM-DD 00:00:00").
//   - Estructura de la respuesta (data.list, dimensions{}, metrics{}).
// ─────────────────────────────────────────────

const BASE = "https://business-api.tiktok.com/open_api";

// Métricas que pedimos. campaign_name viene como "metric" en TikTok (raro pero así es).
// PURCHASE_METRIC y REVENUE_METRIC son los candidatos a ajustar tras el primer test.
const PURCHASE_METRIC = "conversion";              // nº de conversiones
const REVENUE_METRIC = "total_complete_payment";   // valor de compras (AJUSTAR si Chill Out usa otra)
const METRICS = ["campaign_name", "spend", "impressions", "clicks", PURCHASE_METRIC, REVENUE_METRIC];

function creds() {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) throw new Error("Falta TIKTOK_ACCESS_TOKEN");
  return { token, version: process.env.TIKTOK_API_VERSION || "v1.3" };
}

// config: { advertiserId }. since/until: 'YYYY-MM-DD'.
export async function fetchTiktokCampaignDaily(config, since, until) {
  const advertiserId = String(config.advertiserId || "").trim();
  if (!advertiserId) throw new Error("Falta sources.tiktok.advertiserId en clients.json");
  const { token, version } = creds();

  const rows = [];
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
      rows.push({
        date: rawDate.slice(0, 10), // "YYYY-MM-DD 00:00:00" → "YYYY-MM-DD"
        campaign_name: m.campaign_name || "(sin nombre)",
        spend: Number(m.spend) || 0,
        impressions: Number(m.impressions) || 0,
        clicks: Number(m.clicks) || 0,
        purchases: Number(m[PURCHASE_METRIC]) || 0,
        revenue: Number(m[REVENUE_METRIC]) || 0,
      });
    }

    totalPages = body.data?.page_info?.total_page || 1;
    page++;
  } while (page <= totalPages && page < 50);

  return rows;
}

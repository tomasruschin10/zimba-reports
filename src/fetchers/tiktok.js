// ─────────────────────────────────────────────
// TikTok Ads — reporte diario (Reporting API v1.3).
//   fetchTiktokCampaignDaily → nivel campaña (para KPIs y tabla por campaña).
//   fetchTiktokAdDaily       → nivel anuncio (para "Best creatives"), con thumbnail.
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
// Métricas a nivel campaña. campaign_name viene como "metric" (raro pero así es).
const METRICS = ["campaign_name", "spend", "impressions", "clicks", PURCHASE_METRIC, ROAS_METRIC];
// Métricas a nivel anuncio. Igual que arriba pero pedimos ad_name en vez de campaign_name.
const AD_METRICS = ["ad_name", "campaign_name", "spend", "impressions", "clicks", PURCHASE_METRIC, ROAS_METRIC];
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

// Llama al endpoint de report integrado, con paginado, y empuja las filas
// crudas (dimensions+metrics) a `out` vía el callback `push`.
async function fetchReportInto(out, ctx, opts, push) {
  const { advertiserId, token, version } = ctx;
  let page = 1, totalPages = 1;
  do {
    const url = new URL(`${BASE}/${version}/report/integrated/get/`);
    url.searchParams.set("advertiser_id", advertiserId);
    url.searchParams.set("report_type", "BASIC");
    url.searchParams.set("data_level", opts.dataLevel);
    url.searchParams.set("dimensions", JSON.stringify(opts.dimensions));
    url.searchParams.set("metrics", JSON.stringify(opts.metrics));
    url.searchParams.set("start_date", opts.since);
    url.searchParams.set("end_date", opts.until);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "1000");
    const res = await fetch(url.toString(), { headers: { "Access-Token": token } });
    const body = await res.json();
    if (body.code !== 0) {
      throw new Error(`TikTok API (code ${body.code}): ${body.message}`);
    }
    const list = body.data?.list || [];
    for (const item of list) push(out, item.dimensions || {}, item.metrics || {});
    totalPages = body.data?.page_info?.total_page || 1;
    page++;
  } while (page <= totalPages && page < 50);
}

// Recorre [since, until] en ventanas de <=30 días (límite de TikTok con stat_time_day).
async function forEachWindow(ctx, since, until, run) {
  let winStart = since;
  while (winStart <= until) {
    let winEnd = addDays(winStart, MAX_DAYS - 1);
    if (winEnd > until) winEnd = until;
    await run(winStart, winEnd);
    winStart = addDays(winEnd, 1);
  }
}

// ── Nivel campaña (sin cambios respecto de la versión anterior) ──
// config: { advertiserId }. since/until: 'YYYY-MM-DD'.
export async function fetchTiktokCampaignDaily(config, since, until) {
  const advertiserId = String(config.advertiserId || "").trim();
  if (!advertiserId) throw new Error("Falta sources.tiktok.advertiserId en clients.json");
  const { token, version } = creds();
  const ctx = { advertiserId, token, version };

  const rows = [];
  const push = (arr, d, m) => {
    const spend = Number(m.spend) || 0;
    const roas = Number(m[ROAS_METRIC]) || 0;
    arr.push({
      date: (d.stat_time_day || "").slice(0, 10),
      campaign_name: m.campaign_name || "(sin nombre)",
      spend,
      impressions: Number(m.impressions) || 0,
      clicks: Number(m.clicks) || 0,
      purchases: Number(m[PURCHASE_METRIC]) || 0,
      revenue: spend * roas,
    });
  };
  await forEachWindow(ctx, since, until, (a, b) =>
    fetchReportInto(rows, ctx, { dataLevel: "AUCTION_CAMPAIGN", dimensions: ["stat_time_day", "campaign_id"], metrics: METRICS, since: a, until: b }, push));
  return rows;
}

// ── Nivel anuncio (creativos) ──
// Devuelve filas diarias por anuncio + un mapa de thumbnails { ad_name: url }.
// El thumbnail se pide aparte (mejor-esfuerzo): si falla, quedan las métricas
// igual y las tarjetas sin imagen. Estructura pensada para calzar con el
// dashboard, que arma "Best creatives" desde adRows + thumbnails.
export async function fetchTiktokAdDaily(config, since, until) {
  const advertiserId = String(config.advertiserId || "").trim();
  if (!advertiserId) throw new Error("Falta sources.tiktok.advertiserId en clients.json");
  const { token, version } = creds();
  const ctx = { advertiserId, token, version };

  const rows = [];
  const adIds = new Set();
  const push = (arr, d, m) => {
    const spend = Number(m.spend) || 0;
    const roas = Number(m[ROAS_METRIC]) || 0;
    if (d.ad_id) adIds.add(String(d.ad_id));
    arr.push({
      date: (d.stat_time_day || "").slice(0, 10),
      ad_id: String(d.ad_id || ""),
      ad_name: m.ad_name || "(sin nombre)",
      campaign_name: m.campaign_name || "",
      spend,
      impressions: Number(m.impressions) || 0,
      clicks: Number(m.clicks) || 0,
      purchases: Number(m[PURCHASE_METRIC]) || 0,
      revenue: spend * roas,
    });
  };
  await forEachWindow(ctx, since, until, (a, b) =>
    fetchReportInto(rows, ctx, { dataLevel: "AUCTION_AD", dimensions: ["stat_time_day", "ad_id"], metrics: AD_METRICS, since: a, until: b }, push));

  // Thumbnails (mejor-esfuerzo). El /ad/get/ devuelve image_mode + una URL de
  // preview por ad. Lo mapeamos por ad_name para que el dashboard lo use igual
  // que los de Meta. Si algo falla, seguimos sin imágenes.
  const thumbnails = {};
  try {
    const nameById = {};
    for (const r of rows) if (r.ad_id) nameById[r.ad_id] = r.ad_name;
    const ids = [...adIds];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const url = new URL(`${BASE}/${version}/ad/get/`);
      url.searchParams.set("advertiser_id", advertiserId);
      url.searchParams.set("filtering", JSON.stringify({ ad_ids: chunk }));
      url.searchParams.set("fields", JSON.stringify(["ad_id", "ad_name", "image_urls", "video_id"]));
      url.searchParams.set("page_size", "100");
      const res = await fetch(url.toString(), { headers: { "Access-Token": token } });
      const body = await res.json();
      if (body.code !== 0) { console.warn(`    TikTok thumbnails: ${body.message}`); break; }
      for (const ad of body.data?.list || []) {
        const name = nameById[String(ad.ad_id)] || ad.ad_name;
        const img = Array.isArray(ad.image_urls) && ad.image_urls.length ? ad.image_urls[0] : null;
        if (name && img) thumbnails[name] = img;
      }
    }
  } catch (e) {
    console.warn(`    TikTok thumbnails: ${e.message}`);
  }
  console.log(`    TikTok creativos: ${rows.length} filas, ${Object.keys(thumbnails).length} con miniatura`);

  return { rows, thumbnails };
}

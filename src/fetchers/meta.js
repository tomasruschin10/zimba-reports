// Meta Ads — insights diarios (time_increment=1) a nivel campaña y a nivel ad.
// MANTENIMIENTO: Meta rota la versión ~cada 3 meses. Cambiá META_API_VERSION.

const PURCHASE_TYPES = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];
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
    const res = await fetch(next); const body = await res.json();
    if (body.error) throw new Error(`Meta API: ${body.error.message} (code ${body.error.code})`);
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
  }));
}
export async function fetchMetaAdDaily({ adAccountId }, since, until) {
  const { token, version } = base(adAccountId);
  const url = new URL(`https://graph.facebook.com/${version}/${adAccountId}/insights`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("level", "ad");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("fields", "ad_name,spend,impressions,clicks,actions,action_values");
  url.searchParams.set("limit", "500");
  const rows = await fetchAll(url.toString());
  return rows.map((r) => ({
    date: r.date_start, ad_name: r.ad_name,
    spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    purchases: pickPurchase(r.actions), revenue: pickPurchase(r.action_values),
  }));
}

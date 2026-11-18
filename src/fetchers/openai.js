// ─────────────────────────────────────────────
// ChatGPT Ads (OpenAI Ads) — reporte diario por campaña (Ads Insights API).
//   GET https://api.ads.openai.com/v1/ad_account/insights
//   aggregation_level=campaign, time_granularity=daily
//
// Credenciales (env / secrets de GitHub): la clave de la cuenta publicitaria.
// El nombre de la variable va en clients.json → sources.chatgpt.keyEnv
// (default OPENAI_ADS_API_KEY). La clave ya define la cuenta.
//
// Las conversiones (`conversions`) se guardan como leads. Si la API rechaza
// ese campo, se reintenta sin él y la corrida sigue con gasto/clics.
// Los importes vienen en la moneda de la cuenta (EUR para la Clínica): el
// build los marca con `cur` y el dashboard convierte al sumar.
// ─────────────────────────────────────────────
const BASE = "https://api.ads.openai.com/v1";
const BASE_FIELDS = ["metadata.readable_time", "campaign.id", "campaign.name", "campaign.impressions", "campaign.clicks", "campaign.spend"];

const toUnix = (ymd, endOfDay = false) => Math.floor(Date.parse(ymd + "T00:00:00Z") / 1000) + (endOfDay ? 86400 : 0);

async function getPage(key, fields, since, until, after) {
  const url = new URL(`${BASE}/ad_account/insights`);
  url.searchParams.set("aggregation_level", "campaign");
  url.searchParams.set("time_granularity", "daily");
  url.searchParams.set("limit", "2000");
  for (const f of fields) url.searchParams.append("fields[]", f);
  url.searchParams.append("time_ranges[]", JSON.stringify({ type: "unix_range", start: toUnix(since), end: toUnix(until, true) }));
  if (after) url.searchParams.set("after", after);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { error: { message: text.slice(0, 200) } }; }
  if (!res.ok) { const e = new Error(`OpenAI Ads ${res.status}: ${body?.error?.message || text.slice(0, 200)}`); e.status = res.status; throw e; }
  return body;
}

const pick = (r, k) => r[`campaign_${k}`] ?? r[k] ?? r.campaign?.[k];

export async function fetchOpenaiCampaignDaily({ keyEnv = "OPENAI_ADS_API_KEY" } = {}, since, until) {
  const key = process.env[keyEnv];
  if (!key) throw new Error(`Falta ${keyEnv}`);
  let fields = [...BASE_FIELDS, "campaign.conversions"];
  const rows = [];
  let after = null;
  for (let guard = 0; guard < 50; guard++) {
    let body;
    try {
      body = await getPage(key, fields, since, until, after);
    } catch (e) {
      if (e.status === 400 && fields.includes("campaign.conversions")) {
        console.warn(`  ChatGPT Ads: sin conversiones (${e.message}); sigo con gasto y clics`);
        fields = BASE_FIELDS; rows.length = 0; after = null; continue;
      }
      throw e;
    }
    for (const r of body.data || []) {
      const date = r.readable_time || r.metadata?.readable_time || (r.start_time ? new Date(r.start_time * 1000).toISOString().slice(0, 10) : null);
      if (!date) continue;
      rows.push({
        date,
        campaign_name: r.campaign_name || r.campaign?.name || "(sin nombre)",
        spend: Number(pick(r, "spend")) || 0,
        impressions: Number(pick(r, "impressions")) || 0,
        clicks: Number(pick(r, "clicks")) || 0,
        purchases: 0,
        revenue: 0,
        leads: Number(pick(r, "conversions")) || 0,
      });
    }
    if (!body.has_more) break;
    after = body.last_id || body.after || null;
    if (!after) break;
  }
  return rows;
}

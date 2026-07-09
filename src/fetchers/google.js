// ─────────────────────────────────────────────
// Google Ads — reporting diario (vía REST searchStream).
// Trae 3 niveles: campañas (con tipo), ad groups y keywords.
//
// Credenciales (env / secrets de GitHub):
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID (MCC sin guiones),
//   GOOGLE_ADS_API_VERSION (opcional, default v24).
//
// El customerId de cada cliente va en clients.json (sources.google.customerId).
// ─────────────────────────────────────────────

function creds() {
  const c = {
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    loginCustomerId: (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, ""),
    version: process.env.GOOGLE_ADS_API_VERSION || "v24",
  };
  const missing = Object.entries(c).filter(([k, v]) => !v && k !== "version").map(([k]) => k);
  if (missing.length) throw new Error(`Faltan credenciales de Google Ads: ${missing.join(", ")}`);
  return c;
}

async function getAccessToken(c) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId, client_secret: c.clientSecret,
      refresh_token: c.refreshToken, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`OAuth Google: ${data.error_description || data.error || "sin access_token"}`);
  return data.access_token;
}

// Ejecuta una query GAQL y devuelve las filas crudas (results).
async function runQuery(c, accessToken, customerId, query) {
  const url = `https://googleads.googleapis.com/${c.version}/customers/${customerId}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": c.developerToken,
      "login-customer-id": c.loginCustomerId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.error || (Array.isArray(body) && body[0]?.error)) {
    const err = body.error || body[0].error;
    throw new Error(`Google Ads API: ${err.message} (status ${err.status || res.status})`);
  }
  const out = [];
  const batches = Array.isArray(body) ? body : [body];
  for (const batch of batches) for (const r of batch.results || []) out.push(r);
  return out;
}

const met = (m) => ({
  spend: (Number(m?.costMicros) || 0) / 1e6,
  impressions: Number(m?.impressions) || 0,
  clicks: Number(m?.clicks) || 0,
  purchases: Number(m?.conversions) || 0,
  revenue: Number(m?.conversionsValue) || 0,
});

// Nombre legible del tipo de campaña.
const CHANNEL_LABELS = {
  SEARCH: "Search", SHOPPING: "Shopping", DISPLAY: "Display",
  VIDEO: "Video", PERFORMANCE_MAX: "Performance Max",
  DEMAND_GEN: "Demand Gen", MULTI_CHANNEL: "Multichannel",
  LOCAL: "Local", SMART: "Smart", HOTEL: "Hotel",
};

// Trae los 3 niveles de una sola pasada (una sesión de token).
// Devuelve { campaigns, adGroups, keywords }.
export async function fetchGoogleAll(config, since, until) {
  const customerId = (config.customerId || "").replace(/-/g, "");
  if (!customerId) throw new Error("Falta sources.google.customerId en clients.json");
  const c = creds();
  const accessToken = await getAccessToken(c);
  const range = `WHERE segments.date BETWEEN '${since}' AND '${until}'`;

  // 1) Campañas (con tipo de campaña)
  const campRows = await runQuery(c, accessToken, customerId, `
    SELECT campaign.name, campaign.advertising_channel_type, segments.date,
           metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.conversions_value
    FROM campaign ${range}`);
  const campaigns = campRows.map((r) => ({
    date: r.segments?.date,
    campaign_name: r.campaign?.name || "(sin nombre)",
    channel_type: CHANNEL_LABELS[r.campaign?.advertisingChannelType] || r.campaign?.advertisingChannelType || "Otro",
    ...met(r.metrics),
  }));

  // 2) Ad groups
  const agRows = await runQuery(c, accessToken, customerId, `
    SELECT campaign.name, ad_group.name, segments.date,
           metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.conversions_value
    FROM ad_group ${range}`);
  const adGroups = agRows.map((r) => ({
    date: r.segments?.date,
    campaign_name: r.campaign?.name || "(sin nombre)",
    ad_group_name: r.adGroup?.name || "(sin nombre)",
    ...met(r.metrics),
  }));

  // 3) Keywords
  const kwRows = await runQuery(c, accessToken, customerId, `
    SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, segments.date,
           metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.conversions_value
    FROM keyword_view ${range}`);
  const keywords = kwRows.map((r) => ({
    date: r.segments?.date,
    campaign_name: r.campaign?.name || "(sin nombre)",
    ad_group_name: r.adGroup?.name || "(sin nombre)",
    keyword: r.adGroupCriterion?.keyword?.text || "(sin keyword)",
    ...met(r.metrics),
  }));

  return { campaigns, adGroups, keywords };
}

// Compat: la función vieja sigue existiendo por si algo la usa.
export async function fetchGoogleCampaignDaily(config, since, until) {
  const { campaigns } = await fetchGoogleAll(config, since, until);
  return campaigns;
}

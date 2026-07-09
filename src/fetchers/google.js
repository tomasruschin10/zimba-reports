// ─────────────────────────────────────────────
// Google Ads — insights diarios por campaña (vía REST searchStream).
//
// Credenciales (en env / secrets de GitHub):
//   GOOGLE_ADS_DEVELOPER_TOKEN   — token del MCC (API Center)
//   GOOGLE_ADS_CLIENT_ID         — OAuth client (Desktop app)
//   GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_REFRESH_TOKEN     — generado una vez con get-refresh-token
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID — el MCC sin guiones (ej. 1183917394)
//   GOOGLE_ADS_API_VERSION       — opcional; default v24. Si Google saca una
//                                  nueva y deprecan esta, cambiá esta variable.
//
// El customerId de cada cliente (la cuenta de Google Ads a leer) va en
// clients.json, en sources.google.customerId (10 dígitos, sin guiones).
//
// MANTENIMIENTO: Google deprecia versiones ~cada año. Si un fetch falla con
// error de versión, subí GOOGLE_ADS_API_VERSION a la vigente.
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

// Access token a partir del refresh token.
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

// config: { customerId } (10 dígitos, sin guiones). since/until: 'YYYY-MM-DD'.
export async function fetchGoogleCampaignDaily(config, since, until) {
  const customerId = (config.customerId || "").replace(/-/g, "");
  if (!customerId) throw new Error("Falta sources.google.customerId en clients.json");
  const c = creds();

  // Diagnóstico: mostramos longitud de cada credencial (no el valor) para detectar
  // si alguna llega vacía o con caracteres de más. Se puede sacar después.
  const len = (s) => (s ? String(s).length : 0);
  console.log(`    [google diag] devToken:${len(c.developerToken)} clientId:${len(c.clientId)} secret:${len(c.clientSecret)} refresh:${len(c.refreshToken)} loginCid:${len(c.loginCustomerId)}(${c.loginCustomerId}) customerId:${customerId} v:${c.version}`);

  const accessToken = await getAccessToken(c);
  console.log(`    [google diag] accessToken obtenido: ${accessToken ? "SÍ len " + accessToken.length : "NO"}`);

  const query = `
    SELECT campaign.name, segments.date,
           metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `;

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

  // searchStream devuelve un array de batches, cada uno con .results
  const rows = [];
  const batches = Array.isArray(body) ? body : [body];
  for (const batch of batches) {
    for (const r of batch.results || []) {
      const m = r.metrics || {};
      rows.push({
        date: r.segments?.date,
        campaign_name: r.campaign?.name || "(sin nombre)",
        spend: (Number(m.costMicros) || 0) / 1e6,
        impressions: Number(m.impressions) || 0,
        clicks: Number(m.clicks) || 0,
        purchases: Number(m.conversions) || 0,
        revenue: Number(m.conversionsValue) || 0,
      });
    }
  }
  return rows;
}

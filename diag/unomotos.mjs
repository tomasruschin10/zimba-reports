// Diagnóstico de las cuentas de Google Ads de UnoMotos. Salida cifrada con diag/pub.pem.
const c = {
  developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN, clientId: process.env.GOOGLE_ADS_CLIENT_ID,
  clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET, refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  login: (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, ""),
};
const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }) })).json();
const at = tok.access_token;
async function q(cid, query) {
  const r = await fetch(`https://googleads.googleapis.com/v24/customers/${cid}/googleAds:searchStream`, { method: "POST",
    headers: { Authorization: `Bearer ${at}`, "developer-token": c.developerToken, "login-customer-id": c.login, "Content-Type": "application/json" },
    body: JSON.stringify({ query }) });
  const b = await r.json();
  if (!r.ok) return { error: JSON.stringify(b).slice(0, 600) };
  return (Array.isArray(b) ? b : [b]).flatMap((x) => x.results || []);
}
const ACC = { "UnoMotos.com.ar": "3153259612", "Motos En Cuotas": "5782375484", "VOGE": "8565357360", "Taller": "4023737774", "Hero": "7238210476" };
const D = "segments.date BETWEEN '2026-09-01' AND '2026-11-26'";
const out = { mcc_clients: await q(c.login, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.status FROM customer_client") };
for (const [name, id] of Object.entries(ACC)) {
  out[name] = {
    conv_actions: await q(id, "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, conversion_action.counting_type, conversion_action.click_through_lookback_window_days, conversion_action.value_settings.default_value FROM conversion_action WHERE conversion_action.status != 'REMOVED'"),
    conv_by_action_month: await q(id, `SELECT segments.month, segments.conversion_action_name, metrics.all_conversions, metrics.conversions FROM campaign WHERE ${D}`),
    campaigns: await q(id, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.network_settings.target_content_network, campaign.network_settings.target_search_network, campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.all_conversions, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE ${D} AND metrics.impressions > 0`),
    by_network: await q(id, `SELECT campaign.name, segments.ad_network_type, metrics.cost_micros, metrics.clicks, metrics.conversions FROM campaign WHERE ${D} AND metrics.cost_micros > 0`),
    search_terms_top: await q(id, `SELECT search_term_view.search_term, campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions FROM search_term_view WHERE ${D} ORDER BY metrics.cost_micros DESC LIMIT 60`),
    changes: await q(id, "SELECT change_event.change_date_time, change_event.change_resource_type, change_event.resource_change_operation, change_event.user_email, change_event.changed_fields, campaign.name FROM change_event WHERE change_event.change_date_time >= '2026-09-27' ORDER BY change_event.change_date_time DESC LIMIT 80"),
  };
}
process.stdout.write(JSON.stringify(out));

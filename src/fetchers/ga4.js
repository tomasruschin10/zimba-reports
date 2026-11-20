// ─────────────────────────────────────────────
// Google Analytics 4 — ventas reales (último clic) para pisar las conversiones
// de Google Ads, y facturación de toda la tienda por fuente.
//
// Credenciales (secrets de GitHub):
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET (el mismo cliente OAuth de Ads)
//   GA4_REFRESH_TOKEN  (generado con: node get-refresh-token.mjs ga4)
//
// En clients.json: sources.ga4 = { propertyId: "432896457", googleRevenue: true }
// ─────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://analyticsdata.googleapis.com/v1beta";

// Si no está como secret, se lee del archivo que guarda el workflow "GA4 · autorizar".
function tokenFile() {
  try { return readFileSync(join(homedir(), ".ga4_refresh_token"), "utf8").trim(); } catch { return ""; }
}

function creds() {
  const c = {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: process.env.GA4_REFRESH_TOKEN || tokenFile(),
  };
  const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Faltan credenciales de GA4: ${missing.join(", ")}`);
  return c;
}

async function token(c) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`OAuth GA4: ${d.error_description || d.error || "sin access_token"}`);
  return d.access_token;
}

// runReport con paginado. Devuelve filas como objetos {dim1, dim2, ..., met1, ...}.
async function report(at, propertyId, { dimensions, metrics, since, until, filter }) {
  const out = [];
  let offset = 0;
  for (;;) {
    const body = {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit: 100000, offset,
      ...(filter ? { dimensionFilter: filter } : {}),
    };
    const res = await fetch(`${API}/properties/${propertyId}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.error) throw new Error(`GA4 API: ${d.error.message}`);
    for (const r of d.rows || []) {
      const o = {};
      dimensions.forEach((n, i) => (o[n] = r.dimensionValues[i].value));
      metrics.forEach((n, i) => (o[n] = Number(r.metricValues[i].value) || 0));
      out.push(o);
    }
    offset += (d.rows || []).length;
    if (!d.rows?.length || offset >= (d.rowCount || 0)) break;
  }
  return out;
}

const fecha = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const googleCpc = { filter: { fieldName: "sessionSourceMedium", stringFilter: { matchType: "EXACT", value: "google / cpc" } } };

export async function fetchGa4(config, since, until) {
  const propertyId = String(config.propertyId || "").replace(/^properties\//, "");
  if (!propertyId) throw new Error("Falta sources.ga4.propertyId en clients.json");
  const at = await token(creds());
  const M = ["transactions", "purchaseRevenue"];
  const val = (r) => ({ purchases: r.transactions, revenue: r.purchaseRevenue });

  const camp = await report(at, propertyId, { dimensions: ["date", "sessionCampaignName"], metrics: M, since, until, filter: googleCpc });
  const ag = await report(at, propertyId, { dimensions: ["date", "sessionCampaignName", "sessionGoogleAdsAdGroupName"], metrics: M, since, until, filter: googleCpc });
  const kw = await report(at, propertyId, { dimensions: ["date", "sessionGoogleAdsAdGroupName", "sessionGoogleAdsKeyword"], metrics: M, since, until, filter: googleCpc });
  const ch = await report(at, propertyId, { dimensions: ["date", "sessionSourceMedium"], metrics: ["sessions", ...M], since, until });

  return {
    campaigns: camp.map((r) => ({ date: fecha(r.date), campaign_name: r.sessionCampaignName, ...val(r) })),
    adGroups: ag.map((r) => ({ date: fecha(r.date), campaign_name: r.sessionCampaignName, ad_group_name: r.sessionGoogleAdsAdGroupName, ...val(r) })),
    keywords: kw.map((r) => ({ date: fecha(r.date), ad_group_name: r.sessionGoogleAdsAdGroupName, keyword: r.sessionGoogleAdsKeyword, ...val(r) })),
    channels: ch.map((r) => ({ date: fecha(r.date), source: r.sessionSourceMedium, sessions: r.sessions, ...val(r) })),
  };
}

// Pisa compras y valor de las filas de Google Ads con lo que dice GA4 (mismo
// día + mismo nombre). Lo que no está en GA4 queda en 0: GA4 no le dio la venta.
export function applyGa4(rows, ga4Rows, keyFn) {
  const map = new Map();
  for (const r of ga4Rows) {
    const k = keyFn(r);
    const m = map.get(k) || { purchases: 0, revenue: 0 };
    m.purchases += r.purchases; m.revenue += r.revenue;
    map.set(k, m);
  }
  for (const r of rows) {
    const k = keyFn(r);
    const m = map.get(k);
    r.purchases = m ? m.purchases : 0;
    r.revenue = m ? m.revenue : 0;
    map.delete(k); // si hay filas repetidas (ej. misma keyword en 2 concordancias), la venta va a una sola
  }
}

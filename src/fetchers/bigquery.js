// ─────────────────────────────────────────────
// BigQuery — leads reales que entran al CRM del cliente (ej. Terres).
// Usa el mismo refresh token del servidor que GA4 (~/.ga4_refresh_token),
// autorizado con los scopes analytics.readonly + bigquery.readonly (cuenta info@).
//
// En clients.json: alerts.leadsBigQuery = {
//   table: "terres8.proveedores.zimba_lead_forms", // vista que comparte el cliente
//   project: "zimba-reports",                      // proyecto que paga la consulta
//   location: "us-central1", dateField: "created_time", sourceField: "source" }
// ─────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function refreshToken() {
  if (process.env.GA4_REFRESH_TOKEN) return process.env.GA4_REFRESH_TOKEN;
  try { return readFileSync(join(homedir(), ".ga4_refresh_token"), "utf8").trim(); } catch { return ""; }
}

async function accessToken() {
  const c = { client_id: process.env.GOOGLE_ADS_CLIENT_ID, client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET, refresh_token: refreshToken() };
  const falta = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (falta.length) throw new Error(`Faltan credenciales de BigQuery: ${falta.join(", ")}`);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...c, grant_type: "refresh_token" }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`OAuth BigQuery: ${d.error_description || d.error || "sin access_token"}`);
  return d.access_token;
}

// Devuelve { "YYYY-MM-DD": { total, porFuente: { meta: n, website: n, ... } } } desde `desde`.
export async function leadsPorDia(cfg, desde, tz = "America/Argentina/Buenos_Aires") {
  const at = await accessToken();
  const f = cfg.dateField || "created_time", s = cfg.sourceField || "source";
  const query = `SELECT FORMAT_DATE('%Y-%m-%d', DATE(TIMESTAMP(${f}), '${tz}')) AS dia, IFNULL(CAST(${s} AS STRING), 'sin dato') AS fuente, COUNT(*) AS n
    FROM \`${cfg.table}\` WHERE DATE(TIMESTAMP(${f}), '${tz}') >= DATE('${desde}') GROUP BY dia, fuente`;
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${cfg.project}/queries`, {
    method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, useLegacySql: false, location: cfg.location || "US", timeoutMs: 60000 }),
  });
  const d = await res.json();
  if (d.error) throw new Error(`BigQuery: ${d.error.message}`);
  if (!d.jobComplete) throw new Error("BigQuery: la consulta no terminó a tiempo");
  const out = {};
  for (const r of d.rows || []) {
    const [dia, fuente, n] = r.f.map((x) => x.v);
    out[dia] ??= { total: 0, porFuente: {} };
    out[dia].total += Number(n); out[dia].porFuente[fuente] = Number(n);
  }
  return out;
}

// Diagnóstico profundo: hace la llamada real a la API de Ads y muestra la respuesta cruda.
// Prueba 3 variantes para aislar la causa del UNAUTHENTICATED.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

console.log("\n=== Diagnóstico profundo Google Ads API ===");
console.log("(Pegá los MISMOS valores de los secrets de GitHub)\n");
const developerToken = (await ask("Developer Token:\n> ")).trim();
const clientId = (await ask("\nClient ID:\n> ")).trim();
const clientSecret = (await ask("\nClient Secret:\n> ")).trim();
const refreshToken = (await ask("\nRefresh Token:\n> ")).trim();
const loginCustomerId = "1183917394"; // MCC
const customerId = "1481406288";      // Chill Out
const V = "v24";

console.log("\n1) Generando access token...");
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
});
const tok = await tokRes.json();
if (!tok.access_token) { console.log("   ✗ No se pudo generar access token:", JSON.stringify(tok)); process.exit(1); }
const accessToken = tok.access_token;
console.log(`   ✓ access token OK (scope: ${tok.scope || "?"})`);

const query = "SELECT campaign.name, segments.date, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS";

async function tryCall(label, url, headers) {
  console.log(`\n─── ${label} ───`);
  console.log("URL:", url);
  console.log("Headers:", Object.keys(headers).join(", "));
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query }) });
    console.log("HTTP status:", res.status);
    console.log("request-id:", res.headers.get("request-id") || res.headers.get("x-request-id") || "(no vino)");
    const text = await res.text();
    console.log("Respuesta (primeros 600 chars):");
    console.log(text.slice(0, 600));
  } catch (e) {
    console.log("Error de red:", e.message);
  }
}

// Variante A: como está en el fetcher (con login-customer-id)
await tryCall("A) searchStream CON login-customer-id",
  `https://googleads.googleapis.com/${V}/customers/${customerId}/googleAds:searchStream`,
  { "Authorization": `Bearer ${accessToken}`, "developer-token": developerToken, "login-customer-id": loginCustomerId, "Content-Type": "application/json" });

// Variante B: sin login-customer-id
await tryCall("B) searchStream SIN login-customer-id",
  `https://googleads.googleapis.com/${V}/customers/${customerId}/googleAds:searchStream`,
  { "Authorization": `Bearer ${accessToken}`, "developer-token": developerToken, "Content-Type": "application/json" });

// Variante C: endpoint search normal (no stream)
await tryCall("C) search (no-stream) CON login-customer-id",
  `https://googleads.googleapis.com/${V}/customers/${customerId}/googleAds:search`,
  { "Authorization": `Bearer ${accessToken}`, "developer-token": developerToken, "login-customer-id": loginCustomerId, "Content-Type": "application/json" });

console.log("\n\nPegale TODO esto a Claude (tapá el request-id si querés, no es secreto igual).");
rl.close();
process.exit(0);

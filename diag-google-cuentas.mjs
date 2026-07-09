// Lista las cuentas accesibles con el token, y prueba leer Chill Out.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

console.log("\n=== Cuentas accesibles con tu token ===\n");
const developerToken = (await ask("Developer Token:\n> ")).trim();
const clientId = (await ask("\nClient ID:\n> ")).trim();
const clientSecret = (await ask("\nClient Secret:\n> ")).trim();
const refreshToken = (await ask("\nRefresh Token:\n> ")).trim();
const loginCustomerId = "1183917394";
const V = "v24";

const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
});
const tok = await tokRes.json();
if (!tok.access_token) { console.log("✗ OAuth falló:", JSON.stringify(tok)); process.exit(1); }
const accessToken = tok.access_token;
console.log("✓ access token OK\n");

// 1) listAccessibleCustomers: qué cuentas ve este token
console.log("─── Cuentas accesibles directas (listAccessibleCustomers) ───");
const lac = await fetch(`https://googleads.googleapis.com/${V}/customers:listAccessibleCustomers`, {
  headers: { "Authorization": `Bearer ${accessToken}`, "developer-token": developerToken },
});
const lacBody = await lac.json();
console.log(JSON.stringify(lacBody, null, 2).slice(0, 800));

// 2) Bajo el MCC, listar TODAS las cuentas hijas con nombre e ID
console.log("\n─── Cuentas bajo el MCC 1183917394 (con nombre) ───");
const q = "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager FROM customer_client";
const res = await fetch(`https://googleads.googleapis.com/${V}/customers/${loginCustomerId}/googleAds:search`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${accessToken}`, "developer-token": developerToken, "login-customer-id": loginCustomerId, "Content-Type": "application/json" },
  body: JSON.stringify({ query: q }),
});
const body = await res.json();
if (body.error) {
  console.log("Error:", JSON.stringify(body.error).slice(0, 400));
} else {
  for (const r of body.results || []) {
    const c = r.customerClient;
    console.log(`  ${c.id}  ${c.manager ? "[MANAGER]" : "         "}  ${c.descriptiveName || "(sin nombre)"}`);
  }
}
console.log("\nBuscá Chill Out en la lista de arriba y fijate su ID exacto. Pegale esto a Claude.");
rl.close();
process.exit(0);

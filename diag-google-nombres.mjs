// Pide el nombre de cada cuenta accesible, para identificar cuál es Chill Out.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

console.log("\n=== Nombres de tus cuentas accesibles ===\n");
const developerToken = (await ask("Developer Token:\n> ")).trim();
const clientId = (await ask("\nClient ID:\n> ")).trim();
const clientSecret = (await ask("\nClient Secret:\n> ")).trim();
const refreshToken = (await ask("\nRefresh Token:\n> ")).trim();
const V = "v24";

const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
});
const tok = await tokRes.json();
const accessToken = tok.access_token;

const ids = ["7222366669","9553656252","8996194052","1703437794","6644172513","6796711054","3117168501"];
console.log("\nConsultando nombre de cada cuenta...\n");
for (const id of ids) {
  // Cada cuenta se consulta a sí misma (login-customer-id = su propio id)
  const res = await fetch(`https://googleads.googleapis.com/${V}/customers/${id}/googleAds:search`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "developer-token": developerToken, "login-customer-id": id, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "SELECT customer.id, customer.descriptive_name, customer.manager FROM customer" }),
  });
  const body = await res.json();
  if (body.error) {
    console.log(`  ${id}  → error: ${body.error.details?.[0]?.errors?.[0]?.errorCode?.authorizationError || body.error.status}`);
  } else {
    const c = body.results?.[0]?.customer;
    console.log(`  ${id}  → ${c?.descriptiveName || "(sin nombre)"} ${c?.manager ? "[MANAGER]" : ""}`);
  }
}
console.log("\n¿Alguna es Chill Out? Pegale esto a Claude.");
rl.close();
process.exit(0);

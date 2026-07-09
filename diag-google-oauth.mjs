// Diagnostica el OAuth de Google: intenta sacar un access token del refresh token.
// Uso: pegás las 3 credenciales y te dice si el OAuth funciona o qué falla.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

console.log("\n=== Diagnóstico OAuth Google Ads ===");
console.log("(Pegá los MISMOS valores que cargaste en los secrets de GitHub)\n");
const clientId = (await ask("Client ID:\n> ")).trim();
const clientSecret = (await ask("\nClient Secret:\n> ")).trim();
const refreshToken = (await ask("\nRefresh Token:\n> ")).trim();

console.log("\nProbando intercambio refresh_token → access_token...\n");
const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId, client_secret: clientSecret,
    refresh_token: refreshToken, grant_type: "refresh_token",
  }),
});
const data = await res.json();
if (data.access_token) {
  console.log("╔═══════════════════════════════════════╗");
  console.log("║  ✓ OAuth OK - el access token se generó ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log("\nLas 3 credenciales están BIEN. El problema es otro (dev token o login-customer-id).");
} else {
  console.log("╔═══════════════════════════════════════╗");
  console.log("║  ✗ OAuth FALLÓ                          ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log("\nError:", data.error);
  console.log("Detalle:", data.error_description);
  console.log("\n→ Si dice 'invalid_grant': el refresh token no matchea con este client id/secret.");
  console.log("→ Si dice 'invalid_client': el client id o secret están mal.");
}
rl.close();
process.exit(0);

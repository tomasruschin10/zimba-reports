// ─────────────────────────────────────────────
// Genera el REFRESH TOKEN de Google Ads (OAuth).
// Uso:
//   node get-refresh-token.mjs
// Te va a pedir Client ID y Client Secret, te da un link para autorizar,
// y al final te imprime el refresh token.
// ─────────────────────────────────────────────

import readline from "node:readline";
import { createServer } from "node:http";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const SCOPE = "https://www.googleapis.com/auth/adwords";
const REDIRECT = "http://localhost:4444";

console.log("\n=== Generador de refresh token · Google Ads ===\n");
const clientId = (await ask("Pegá tu Client ID y Enter:\n> ")).trim();
const clientSecret = (await ask("\nPegá tu Client Secret y Enter:\n> ")).trim();

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent",
});

console.log("\n─────────────────────────────────────────────");
console.log("1) Abrí este link en el navegador (logueado como info@zimba.com.ar):\n");
console.log(authUrl);
console.log("\n2) Autorizá. El navegador va a quedar 'cargando' en localhost:4444 — es normal.");
console.log("   Este script captura el código solo.\n");
console.log("─────────────────────────────────────────────\n");
console.log("Esperando autorización...");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  if (!code) { res.end("Sin código."); return; }
  res.end("Listo. Podés cerrar esta pestaña y volver a la terminal.");
  server.close();

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: REDIRECT, grant_type: "authorization_code",
    }),
  });
  const data = await tokenRes.json();
  if (data.refresh_token) {
    console.log("\n\n╔══════════════════════════════════════════════╗");
    console.log("║  ✓ REFRESH TOKEN generado                     ║");
    console.log("╚══════════════════════════════════════════════╝\n");
    console.log(data.refresh_token);
    console.log("\nGuardalo seguro. Es el que va a usar el sitio.\n");
  } else {
    console.log("\nError:", JSON.stringify(data, null, 2));
  }
  rl.close();
  process.exit(0);
});
server.listen(4444);

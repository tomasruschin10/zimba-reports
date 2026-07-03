// ─────────────────────────────────────────────
// build.js — corre en GitHub Actions (3×/día) y en cada push.
//
// Trae los insights diarios de Meta (campaña y ad) de un rango que cubre todas
// las vistas, y vuelca las FILAS CRUDAS al JSON. Todo el cálculo (períodos,
// cuenta, campaña, KPIs, gráficos, creatives) lo hace el dashboard en el cliente.
// Así el filtro por campaña y los períodos salen sin recompilar nada.
// ─────────────────────────────────────────────

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMetaCampaignDaily, fetchMetaAdDaily, fetchMetaDemographics, fetchMetaDevices, fetchMetaThumbnails } from "./fetchers/meta.js";
import { fetchGoogleCampaignDaily } from "./fetchers/google.js";
import { fetchTiktokCampaignDaily } from "./fetchers/tiktok.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
const ymd = (d) => d.toISOString().slice(0, 10);

// Traemos desde el 1 del mes de hace 2 meses: cubre todas las vistas y sus
// períodos anteriores comparables (mes pasado vs antemes, últimos 30 vs 30 previos).
function fetchWindow() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return { since: ymd(start), until: ymd(now) };
}

async function buildClient(client) {
  const meta = client.sources.meta;
  if (!meta?.accounts?.length) return null;
  const { since, until } = fetchWindow();

  const campaignRows = []; // {account, date, campaign_name, ...}
  const adRows = [];        // {account, date, campaign_name, adset_name, ad_name, ...}
  const demoRows = [];      // {account, date, age, gender, ...}
  const deviceRows = [];    // {account, date, device, ...}
  let thumbnails = {};      // { ad_name: thumbnail_url }
  const accounts = meta.accounts.map((a) => a.label);
  const accountModes = Object.fromEntries(meta.accounts.map((a) => [a.label, a.mode || "sales"]));

  for (const acc of meta.accounts) {
    const camps = await fetchMetaCampaignDaily({ adAccountId: acc.id }, since, until);
    const ads = await fetchMetaAdDaily({ adAccountId: acc.id }, since, until);
    for (const r of camps) campaignRows.push({ account: acc.label, ...r });
    for (const r of ads) adRows.push({ account: acc.label, ...r });

    // Breakdowns (best-effort: si alguno falla, seguimos sin romper el build)
    try {
      const demo = await fetchMetaDemographics({ adAccountId: acc.id }, since, until);
      for (const r of demo) demoRows.push({ account: acc.label, ...r });
    } catch (e) { console.warn(`  demografía ${acc.label}: ${e.message}`); }
    try {
      const dev = await fetchMetaDevices({ adAccountId: acc.id }, since, until);
      for (const r of dev) deviceRows.push({ account: acc.label, ...r });
    } catch (e) { console.warn(`  dispositivo ${acc.label}: ${e.message}`); }
    try {
      const adNames = ads.map((r) => r.ad_name);
      const th = await fetchMetaThumbnails({ adAccountId: acc.id }, adNames);
      thumbnails = { ...thumbnails, ...th };
    } catch (e) { console.warn(`  thumbnails ${acc.label}: ${e.message}`); }

    console.log(`  ${client.slug}/${acc.label}: ${camps.length} campaña, ${ads.length} ad, ${demoRows.length} demo, ${deviceRows.length} device`);
  }

  // ── Google Ads (opcional; solo si está habilitado en clients.json) ──
  const g = client.sources.google;
  if (g?.enabled && g.customerId) {
    const label = g.label || "Google";
    try {
      const camps = await fetchGoogleCampaignDaily({ customerId: g.customerId }, since, until);
      for (const r of camps) campaignRows.push({ account: label, ...r });
      accounts.push(label);
      accountModes[label] = g.mode || "sales";
      console.log(`  ${client.slug}/${label}: ${camps.length} campaña (Google Ads)`);
    } catch (e) {
      console.warn(`  Google Ads ${label}: ${e.message}`);
    }
  }

  // ── TikTok Ads (opcional; solo si está habilitado en clients.json) ──
  const tk = client.sources.tiktok;
  if (tk?.enabled && tk.advertiserId) {
    const label = tk.label || "TikTok";
    try {
      const camps = await fetchTiktokCampaignDaily({ advertiserId: tk.advertiserId }, since, until);
      for (const r of camps) campaignRows.push({ account: label, ...r });
      accounts.push(label);
      accountModes[label] = tk.mode || "sales";
      console.log(`  ${client.slug}/${label}: ${camps.length} campaña (TikTok Ads)`);
    } catch (e) {
      console.warn(`  TikTok Ads ${label}: ${e.message}`);
    }
  }

  return {
    slug: client.slug,
    client: client.name,
    updatedAt: new Date().toISOString(),
    accounts,
    accountModes,
    campaignRows,
    adRows,
    demoRows,
    deviceRows,
    thumbnails,
  };
}

async function main() {
  const clients = JSON.parse(await readFile(join(ROOT, "clients.json"), "utf8"));
  await mkdir(join(OUT, "data"), { recursive: true });

  const built = [];
  for (const client of clients) {
    console.log(`\n${client.name} (${client.slug})`);
    try {
      const report = await buildClient(client);
      if (!report) continue;
      await writeFile(join(OUT, "data", `${client.slug}.json`), JSON.stringify(report), "utf8");
      await copyFile(join(ROOT, "src", "dashboard.html"), join(OUT, `${client.slug}.html`));
      built.push({ slug: client.slug, name: client.name });
      console.log(`  ✓ ${client.slug} generado`);
    } catch (err) {
      console.error(`  ✗ ${client.slug}: ${err.message}`);
    }
  }

  const items = built.map((b) => `<li><a href="./${b.slug}.html">${b.name}</a></li>`).join("");
  await writeFile(join(OUT, "index.html"),
    `<!doctype html><meta charset="utf8"><title>Zimba · Reportes</title>` +
    `<body style="font-family:system-ui;background:#f6f7f9;color:#1a1d23;padding:40px">` +
    `<h1>Zimba · Reportes</h1><ul>${items || "<li>Sin reportes.</li>"}</ul>`, "utf8");

  console.log(`\n✔ Build listo. ${built.length} cliente(s).`);
}

main().catch((err) => { console.error("Build falló:", err); process.exit(1); });

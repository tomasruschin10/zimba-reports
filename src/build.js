// ─────────────────────────────────────────────
// build.js — corre en GitHub Actions (3×/día) y en cada push.
//
// Para cada cliente y cada cuenta de Meta: trae los insights diarios de un
// rango que cubre todas las vistas (desde el inicio del mes pasado hasta hoy),
// precalcula las 4 vistas fijas × (cada cuenta + Todas), y escribe un JSON
// estático por cliente + el HTML del dashboard. GitHub Pages sirve todo eso.
//
// No hay server ni base de datos: el dashboard es un archivo que lee el JSON.
// ─────────────────────────────────────────────

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMetaCampaignDaily, fetchMetaAdDaily } from "./fetchers/meta.js";
import { computeView, fixedRanges } from "./aggregate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
const ymd = (d) => d.toISOString().slice(0, 10);

// Rango a traer: desde el 1 del mes pasado hasta hoy (cubre las 4 vistas).
function fetchWindow() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { since: ymd(start), until: ymd(now) };
}

async function buildClient(client) {
  const meta = client.sources.meta;
  if (!meta?.accounts?.length) return null;
  const { since, until } = fetchWindow();

  // Traemos por cuenta y guardamos las filas etiquetadas.
  const perAccount = {}; // label -> { campaigns:[], ads:[] }
  for (const acc of meta.accounts) {
    const campaigns = await fetchMetaCampaignDaily({ adAccountId: acc.id }, since, until);
    const ads = await fetchMetaAdDaily({ adAccountId: acc.id }, since, until);
    perAccount[acc.label] = { campaigns, ads };
    console.log(`  ${client.slug}/${acc.label}: ${campaigns.length} filas campaña, ${ads.length} ad`);
  }

  const accounts = meta.accounts.map((a) => a.label);
  const ranges = fixedRanges(new Date());

  // Precalculamos: views[rangeKey][accountOrTodas] = { totals, campaigns, roasByDay, creatives }
  const views = {};
  for (const r of ranges) {
    views[r.key] = { _label: r.label, _from: r.from, _to: r.to };
    // Por cuenta
    for (const label of accounts) {
      const { campaigns, ads } = perAccount[label];
      views[r.key][label] = computeView(campaigns, ads, r.from, r.to);
    }
    // Todas (suma de cuentas)
    const allCamp = accounts.flatMap((l) => perAccount[l].campaigns);
    const allAds = accounts.flatMap((l) => perAccount[l].ads);
    views[r.key]["Todas"] = computeView(allCamp, allAds, r.from, r.to);
  }

  return {
    slug: client.slug,
    client: client.name,
    updatedAt: new Date().toISOString(),
    accounts,
    defaultView: "mes",
    views,
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
      // El dashboard: una copia del template por cliente (lee su propio JSON).
      await copyFile(join(ROOT, "src", "dashboard.html"), join(OUT, `${client.slug}.html`));
      built.push({ slug: client.slug, name: client.name, updatedAt: report.updatedAt });
      console.log(`  ✓ ${client.slug} generado`);
    } catch (err) {
      console.error(`  ✗ ${client.slug}: ${err.message}`);
    }
  }

  // Índice
  const items = built.map((b) => `<li><a href="./${b.slug}.html">${b.name}</a></li>`).join("");
  await writeFile(join(OUT, "index.html"),
    `<!doctype html><meta charset="utf8"><title>Zimba · Reportes</title>` +
    `<body style="font-family:system-ui;background:#0e1116;color:#e8ecf2;padding:40px">` +
    `<h1>Zimba · Reportes</h1><ul>${items || "<li>Sin reportes.</li>"}</ul>`, "utf8");

  console.log(`\n✔ Build listo. ${built.length} cliente(s).`);
}

main().catch((err) => { console.error("Build falló:", err); process.exit(1); });

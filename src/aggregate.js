// ─────────────────────────────────────────────
// Agregación en memoria (sin base de datos). Dadas las filas diarias que trajo
// Meta, calcula los KPIs, la tabla por campaña, ROAS por día y best creatives
// para un rango [from, to].
// ─────────────────────────────────────────────

const inRange = (date, from, to) => date >= from && date <= to;

function derive(a) {
  const { spend = 0, revenue = 0, purchases = 0, clicks = 0, impressions = 0 } = a;
  return {
    spend, revenue, purchases, clicks, impressions,
    roas: spend > 0 ? revenue / spend : 0,
    costPerPurchase: purchases > 0 ? spend / purchases : 0,
    aov: purchases > 0 ? revenue / purchases : 0,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    convRate: clicks > 0 ? (purchases / clicks) * 100 : 0,
  };
}
function addInto(acc, r) {
  acc.spend += r.spend; acc.revenue += r.revenue; acc.purchases += r.purchases;
  acc.clicks += r.clicks; acc.impressions += r.impressions;
}

// campaignRows y adRows: filas diarias. from/to: 'YYYY-MM-DD'.
export function computeView(campaignRows, adRows, from, to) {
  const cr = campaignRows.filter((r) => inRange(r.date, from, to));
  const ar = adRows.filter((r) => inRange(r.date, from, to));

  // Totales
  const totalsAcc = { spend: 0, revenue: 0, purchases: 0, clicks: 0, impressions: 0 };
  cr.forEach((r) => addInto(totalsAcc, r));

  // Por campaña
  const byCamp = new Map();
  for (const r of cr) {
    if (!byCamp.has(r.campaign_name)) byCamp.set(r.campaign_name, { spend: 0, revenue: 0, purchases: 0, clicks: 0, impressions: 0 });
    addInto(byCamp.get(r.campaign_name), r);
  }
  const campaigns = [...byCamp.entries()]
    .map(([name, a]) => ({ name, ...derive(a) }))
    .sort((x, y) => y.spend - x.spend);

  // ROAS por día
  const byDay = new Map();
  for (const r of cr) {
    if (!byDay.has(r.date)) byDay.set(r.date, { spend: 0, revenue: 0 });
    const d = byDay.get(r.date); d.spend += r.spend; d.revenue += r.revenue;
  }
  const roasByDay = [...byDay.entries()]
    .map(([date, d]) => ({ date, roas: d.spend > 0 ? d.revenue / d.spend : 0 }))
    .sort((x, y) => x.date.localeCompare(y.date));

  // Best creatives
  const byAd = new Map();
  for (const r of ar) {
    if (!byAd.has(r.ad_name)) byAd.set(r.ad_name, { spend: 0, revenue: 0, purchases: 0, clicks: 0, impressions: 0 });
    addInto(byAd.get(r.ad_name), r);
  }
  const creatives = [...byAd.entries()]
    .map(([name, a]) => ({ name, ...derive(a) }))
    .filter((c) => c.spend > 0)
    .sort((x, y) => y.roas - x.roas)
    .slice(0, 8);

  return { totals: derive(totalsAcc), campaigns, roasByDay, creatives };
}

// Las 4 vistas fijas, con sus rangos calculados a partir de hoy.
export function fixedRanges(today = new Date()) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const y = today.getFullYear(), m = today.getMonth();
  const monthStart = new Date(y, m, 1);
  const prevStart = new Date(y, m - 1, 1);
  const prevEnd = new Date(y, m, 0);
  const last30 = new Date(today); last30.setDate(last30.getDate() - 29);
  return [
    { key: "hoy", label: "Hoy", from: ymd(today), to: ymd(today) },
    { key: "mes", label: "Este mes", from: ymd(monthStart), to: ymd(today) },
    { key: "mespasado", label: "Mes pasado", from: ymd(prevStart), to: ymd(prevEnd) },
    { key: "ultimos30", label: "Últimos 30", from: ymd(last30), to: ymd(today) },
  ];
}

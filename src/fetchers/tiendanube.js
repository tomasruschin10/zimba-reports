// ─────────────────────────────────────────────
// Tienda Nube — ventas reales de la tienda.
//
// Trae lo que el ecommerce REALMENTE vendió (no lo que los ads dicen que
// vendieron). Sirve para cruzar contra la atribución de Meta/Google, que
// suele estar incompleta.
//
// Credenciales: el token de cada tienda va en un secret propio, que se
// nombra en clients.json (sources.tiendanube.tokenEnv). Ej: TIENDANUBE_TOKEN_BACAN.
// El storeId también va en clients.json (no es secreto).
//
// El access token de Tienda Nube NO EXPIRA (solo se invalida si desinstalan
// la app o si se genera uno nuevo).
// ─────────────────────────────────────────────

const API = "https://api.tiendanube.com/v1";
const UA = "Zimba Reports (info@zimba.com.ar)"; // requerido por la API

// Estados de pago que cuentan como venta concretada.
const PAGADAS = ["paid", "partially_paid"];
// Estados que representan intención de compra que NO se concretó (plata perdida).
const PERDIDAS = ["pending", "abandoned", "expired", "voided"];

async function tnGet(path, token, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { "Authentication": `bearer ${token}`, "User-Agent": UA },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tienda Nube API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Trae todas las órdenes del período (paginado).
async function fetchOrders(storeId, token, since, until) {
  const out = [];
  let page = 1;
  while (page <= 30) {
    const rows = await tnGet(`/${storeId}/orders`, token, {
      created_at_min: `${since}T00:00:00-03:00`,
      created_at_max: `${until}T23:59:59-03:00`,
      per_page: 200,
      page,
      fields: "id,number,created_at,completed_at,status,payment_status,payment_details,gateway,gateway_name,total,products,customer,storefront",
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < 200) break;
    page++;
  }
  return out;
}

// config: { storeId, tokenEnv }. since/until: 'YYYY-MM-DD'.
export async function fetchTiendanube(config, since, until) {
  const storeId = String(config.storeId || "").trim();
  if (!storeId) throw new Error("Falta sources.tiendanube.storeId en clients.json");
  const token = process.env[config.tokenEnv];
  if (!token) throw new Error(`Falta el secret ${config.tokenEnv}`);

  const orders = await fetchOrders(storeId, token, since, until);

  // Filas diarias de ventas concretadas.
  const dailyMap = {};
  // Filas diarias de órdenes perdidas (intención que no se concretó).
  const lostMap = {};
  // Productos vendidos (solo de órdenes pagadas).
  const prodMap = {};
  // Métodos de pago (para detectar dónde se cae la gente).
  const payMap = {};

  console.log("DEBUG primeras 2 ordenes:", JSON.stringify(orders.slice(0,2), null, 2));
  for (const o of orders) {
    const date = String(o.completed_at || o.created_at || "").slice(0, 10);
    if (!date) continue;
    const total = Number(o.total) || 0;
    const pago = o.payment_status;
    // El método puede venir en payment_details.method, gateway_name o gateway.
    const metodo = o.payment_details?.method || o.gateway_name || o.gateway || "(sin método)";
    const cancelada = o.status === "cancelled";

    if (PAGADAS.includes(pago) && !cancelada) {
      if (!dailyMap[date]) dailyMap[date] = { date, orders: 0, revenue: 0, units: 0 };
      dailyMap[date].orders += 1;
      dailyMap[date].revenue += total;
      for (const p of o.products || []) {
        const q = Number(p.quantity) || 0;
        dailyMap[date].units += q;
        const name = p.name || "(sin nombre)";
        if (!prodMap[name]) prodMap[name] = { name, units: 0, revenue: 0, orders: 0 };
        prodMap[name].units += q;
        prodMap[name].revenue += (Number(p.price) || 0) * q;
        prodMap[name].orders += 1;
      }
      if (!payMap[metodo]) payMap[metodo] = { metodo, pagadas: 0, perdidas: 0, revPagadas: 0, revPerdidas: 0 };
      payMap[metodo].pagadas += 1;
      payMap[metodo].revPagadas += total;
    } else if (PERDIDAS.includes(pago) || cancelada) {
      if (!lostMap[date]) lostMap[date] = { date, orders: 0, revenue: 0 };
      lostMap[date].orders += 1;
      lostMap[date].revenue += total;
      if (!payMap[metodo]) payMap[metodo] = { metodo, pagadas: 0, perdidas: 0, revPagadas: 0, revPerdidas: 0 };
      payMap[metodo].perdidas += 1;
      payMap[metodo].revPerdidas += total;
    }
  }

  const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  const lost = Object.values(lostMap).sort((a, b) => a.date.localeCompare(b.date));
  const products = Object.values(prodMap).sort((a, b) => b.revenue - a.revenue).slice(0, 20);
  const payments = Object.values(payMap).sort((a, b) => (b.pagadas + b.perdidas) - (a.pagadas + a.perdidas));

  return { daily, lost, products, payments };
}

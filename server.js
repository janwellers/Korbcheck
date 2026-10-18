const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { priceJob, priceRule } = require("./prices");
const { aldiSearch, reweSearch, reweMarket, offersSearch } = require("./sources");
const { CATS, BASE } = require("./products");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const send = (res, code, body, type = "application/json; charset=utf-8", extra = {}) => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const plzOf = (u) => (/^\d{5}$/.test(u.searchParams.get("plz") || "") ? u.searchParams.get("plz") : "10115");
const safe = (p) => p.catch((e) => ({ error: String(e.message || e) }));

// Eigene Produkte: einfache Regel aus Suchbegriff und Menge
function customRule(c) {
  const words = String(c.q || "").toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 4);
  const a = Number(c.a), u = ["g", "ml", "stk", "wl", "rolle"].includes(c.u) ? c.u : null;
  if (!words.length || !a || !u) return null;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { id: String(c.id).slice(0, 40), q: words.join(" "), qo: words[0], size: { a, u }, inc: words.map((w) => new RegExp(esc(w))), range: [0.5, 2.1], allowBio: /bio/.test(words.join(" ")) };
}

function readBody(req) {
  return new Promise((ok, ko) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 2e5) req.destroy(); }); req.on("end", () => ok(d)); req.on("error", ko); });
}

async function api(req, res, u) {
  if (u.pathname === "/api/health") return send(res, 200, { ok: true });
  if (u.pathname === "/api/products") return send(res, 200, { cats: CATS, products: BASE.map((p) => ({ id: p.id, n: p.n, c: p.c, u: p.u, est: p.est, note: p.note || null })) });
  if (u.pathname === "/api/prices") return send(res, 200, priceJob(plzOf(u)));
  if (u.pathname === "/api/custom" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const plz = /^\d{5}$/.test(body.plz || "") ? body.plz : "10115";
    const market = await reweMarket(plz).catch(() => ({ id: "1931630" }));
    const items = {}, status = {};
    await Promise.all((body.items || []).slice(0, 30).map(async (c) => { const r = customRule(c); if (r) items[r.id] = await priceRule(r, plz, market, status); }));
    return send(res, 200, { items, status });
  }
  if (u.pathname === "/api/search") {
    const q = (u.searchParams.get("q") || "").trim().slice(0, 60);
    if (q.length < 2) return send(res, 400, { error: "Suchbegriff zu kurz" });
    const plz = plzOf(u);
    const market = await reweMarket(plz).catch(() => ({ id: "1931630" }));
    const [aldi, rewe, offers] = await Promise.all([safe(aldiSearch(q)), safe(reweSearch(q, market)), safe(offersSearch(q, plz))]);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rel = (list) => (Array.isArray(list) ? list.filter((it) => words.every((w) => `${it.name} ${it.desc || ""}`.toLowerCase().includes(w))) : list);
    return send(res, 200, { q, plz, reweMarket: market, aldi: rel(aldi), rewe: rel(rewe), offers: Array.isArray(offers) ? rel(offers).filter((o) => o.store) : offers });
  }
  return send(res, 404, { error: "Nicht gefunden" });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname.startsWith("/api/")) return await api(req, res, u);
    let p = path.normalize(path.join(PUB, decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname)));
    if (!p.startsWith(PUB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(PUB, "index.html");
    send(res, 200, fs.readFileSync(p), TYPES[path.extname(p)] || "application/octet-stream", { "Cache-Control": "no-cache" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "Serverfehler" });
  }
});
server.listen(PORT, () => {
  console.log(`Korbcheck läuft auf http://localhost:${PORT}`);
  priceJob("10115");
});

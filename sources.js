// Live-Preisquellen: Aldi Süd (Regalpreise), Rewe (Regalpreise je Markt), marktguru (Prospektangebote)
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE_HEADERS = { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.5" };

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  if (hit && hit.pending) return hit.pending;
  const stale = hit && "val" in hit ? hit.val : undefined;
  const pending = fn().then(
    (val) => { cache.set(key, { val, exp: Date.now() + ttlMs }); return val; },
    (err) => {
      // Lieber den letzten guten Wert zeigen als gar nichts
      if (stale !== undefined) { cache.set(key, { val: stale, exp: Date.now() + 10 * 60e3 }); return stale; }
      cache.delete(key); throw err;
    }
  );
  cache.set(key, { pending, exp: 0, ...(stale !== undefined ? { val: stale } : {}) });
  return pending;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blockedUntil = {};
async function getJson(url, headers = {}, timeoutMs = 12000) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const b = blockedUntil[host];
    if (b && b.until > Date.now()) throw new Error(`HTTP ${b.status} ${host}`);
    const res = await fetch(url, { headers: { ...BASE_HEADERS, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(1500 * (attempt + 1) ** 2); continue; }
    // 403 = Anbieter sperrt diesen Server, nicht weiter nachfragen
    if (res.status === 429 || res.status === 403) blockedUntil[host] = { status: res.status, until: Date.now() + (res.status === 403 ? 30 : 3) * 60e3 };
    throw new Error(`HTTP ${res.status} ${host}`);
  }
}

function limiter(max) {
  let active = 0; const queue = [];
  const next = () => { if (active >= max || !queue.length) return; active++; const { fn, ok, ko } = queue.shift(); fn().then(ok, ko).finally(() => { active--; next(); }); };
  return (fn) => new Promise((ok, ko) => { queue.push({ fn, ok, ko }); next(); });
}
const aldiLimit = limiter(3), reweLimit = limiter(1), mgLimit = limiter(4);

// ---------- Mengen erkennen ----------
const num = (s) => parseFloat(String(s).replace(",", "."));
const UNIT = { g: ["g", 1], kg: ["g", 1000], ml: ["ml", 1], cl: ["ml", 10], l: ["ml", 1000], liter: ["ml", 1000] };
function parseSizes(text) {
  if (!text) return [];
  const s = String(text).toLowerCase().replace(/\u00a0/g, " ").replace(/(\d)\.(\d{3})\b/g, "$1$2");
  const out = [];
  let m = s.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*-?\s*(kg|g|ml|cl|liter|l)\b/);
  if (m) { const [u, f] = UNIT[m[3]]; out.push({ a: +m[1] * num(m[2]) * f, u, multi: +m[1] }); }
  else if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*-?\s*(kg|g|ml|cl|liter|l)\b/))) { const [u, f] = UNIT[m[2]]; out.push({ a: num(m[1]) * f, u }); }
  if ((m = s.match(/(\d+)\s*(?:x\s*\d+\s*blatt|rollen)/))) out.push({ a: +m[1], u: "rolle" });
  if ((m = s.match(/(\d+)\s*(?:wl\b|waschladung)/))) out.push({ a: +m[1], u: "wl" });
  if ((m = s.match(/(\d+)\s*(?:er\b|er-|stück|stk\b|st\.)/))) out.push({ a: +m[1], u: "stk" });
  return out;
}
const sizesOf = (...texts) => { const out = []; for (const t of texts) for (const z of parseSizes(t)) if (!out.some((o) => o.u === z.u)) out.push(z); return out; };

// ---------- Aldi Süd ----------
async function aldiSearch(q) {
  return cached(`aldi:${q}`, 6 * 3600e3, () => aldiLimit(async () => {
    const url = `https://api.aldi-sued.de/v3/product-search?currency=EUR&q=${encodeURIComponent(q)}&limit=30&offset=0&serviceType=walk-in`;
    const d = await getJson(url, { Origin: "https://www.aldi-sued.de", Referer: "https://www.aldi-sued.de/" });
    return (d.data || []).map((p) => {
      const name = [p.brandName, p.name].filter(Boolean).join(" ");
      const was = p.price?.wasPriceDisplay ? num(p.price.wasPriceDisplay.replace(/[^\d,]/g, "")) : null;
      return {
        store: "aldi", name, price: p.price.amountRelevant / 100,
        sizes: sizesOf(p.sellingSize, p.name),
        sizeText: p.sellingSize || "", regular: was, url: `https://www.aldi-sued.de/produkt/${p.urlSlugText}-${p.sku}`,
        deposit: (p.price.bottleDeposit || 0) / 100,
      };
    });
  }));
}

// ---------- Rewe ----------
const DEFAULT_REWE = { id: "1931630", name: "REWE Markt", street: "Heidestr. 41", city: "Berlin / Mitte", zip: "10557" };
async function reweMarket(plz) {
  if (!/^\d{5}$/.test(plz || "")) return DEFAULT_REWE;
  return cached(`rewemarket:${plz}`, 24 * 3600e3, async () => {
    const list = await getJson(`https://www.rewe.de/shop/api/marketselection/zipcodes/${plz}/services/pickup`);
    const m = Array.isArray(list) && list[0];
    if (!m) return { ...DEFAULT_REWE, fallback: true };
    return { id: m.wwIdent, name: m.displayName, street: m.street, city: m.city, zip: m.zipCode };
  });
}
function reweRef(pr) {
  if (pr.basePrice && pr.baseUnit?.KG === 1) return { refPrice: pr.basePrice / 100, refUnit: "kg" };
  const m = (pr.grammage || "").match(/1 kg = (\d+,\d+)/);
  return m ? { refPrice: num(m[1]), refUnit: "kg" } : {};
}
async function reweSearch(q, market) {
  return cached(`rewe:${market.id}:${q}`, 6 * 3600e3, () => reweLimit(async () => {
    await sleep(450);
    const url = `https://www.rewe.de/shop/api/products?search=${encodeURIComponent(q)}&objectsPerPage=40&serviceTypes=PICKUP&market=${market.id}`;
    const d = await getJson(url);
    return (d._embedded?.products || []).flatMap((p) => {
      const art = p._embedded?.articles?.[0]; const pr = art?._embedded?.listing?.pricing;
      if (!pr || pr.currentRetailPrice == null) return [];
      const g = (pr.grammage || "").split("(")[0];
      return [{
        store: "rewe", name: p.productName, price: pr.currentRetailPrice / 100,
        sizes: sizesOf(g, p.productName), sizeText: g.trim(),
        regular: pr.discount?.regularPrice ? pr.discount.regularPrice / 100 : null,
        until: pr.discount?.validTo ? pr.discount.validTo.slice(0, 10) : null,
        ...reweRef(pr),
        url: `https://www.rewe.de/shop${p._links?.detail?.href || ""}`,
      }];
    });
  }));
}

// ---------- marktguru (Prospektangebote) ----------
async function mgKeys() {
  return cached("mgkeys", 12 * 3600e3, async () => {
    const res = await fetch("https://www.marktguru.de/", { headers: BASE_HEADERS, signal: AbortSignal.timeout(12000) });
    const html = await res.text();
    const apiKey = html.match(/apiKey":"([^"]+)/)?.[1], clientKey = html.match(/clientKey":"([^"]+)/)?.[1];
    if (!apiKey || !clientKey) throw new Error("marktguru keys not found");
    return { apiKey, clientKey };
  });
}
function mgStore(name) {
  const n = (name || "").toLowerCase();
  if (n.startsWith("aldi")) return "aldi";
  if (n.startsWith("lidl")) return "lidl";
  if (n.startsWith("kaufland")) return "kaufland";
  if (n.startsWith("rewe")) return "rewe";
  if (/^(edeka|e center|e-center|e xpress|marktkauf)/.test(n)) return "edeka";
  return null;
}
async function offersSearch(q, plz) {
  const zip = /^\d{5}$/.test(plz || "") ? plz : "10115";
  return cached(`mg:${zip}:${q}`, 3 * 3600e3, () => mgLimit(async () => {
    const k = await mgKeys();
    const url = `https://api.marktguru.de/api/v1/offers/search?as=web&q=${encodeURIComponent(q)}&zipCode=${zip}&limit=100&offset=0`;
    let d;
    try { d = await getJson(url, { "x-apikey": k.apiKey, "x-clientkey": k.clientKey }); }
    catch (e) { cache.delete("mgkeys"); throw e; }
    const now = Date.now(), soon = now + 2 * 86400e3;
    return (d.results || []).flatMap((o) => {
      const adv = (o.advertisers || [])[0]; const store = mgStore(adv?.name);
      const v = (o.validityDates || [])[0]; if (!v) return [];
      const from = Date.parse(v.from), to = Date.parse(v.to);
      if (to < now || from > soon) return [];
      const brand = /nobrand/i.test(o.brand?.name || "") ? "" : o.brand?.name || "";
      const name = [brand, o.product?.name].filter(Boolean).join(" ");
      const desc = o.description || "";
      const sizes = sizesOf(desc, o.product?.name);
      const unit = o.unit?.shortName;
      if (!sizes.some((z) => z.u === "g") && o.volume && unit === "kg") sizes.push({ a: o.volume * 1000, u: "g" });
      if (!sizes.some((z) => z.u === "ml") && o.volume && unit === "l") sizes.push({ a: o.volume * 1000, u: "ml" });
      return [{
        store, storeName: adv?.name, name, desc, price: o.price, regular: o.oldPrice || null, sizes, sizeText: desc,
        refPrice: o.referencePrice, refUnit: unit, from: new Date(from + 3 * 3600e3).toISOString().slice(0, 10),
        until: new Date(to).toISOString().slice(0, 10), loyalty: !!o.requiresLoyalityMembership,
        url: `https://www.marktguru.de/offers/${o.id}`, image: `https://mg2de.b-cdn.net/api/v1/offers/${o.id}/images/default/0/small.jpg`,
      }];
    });
  }));
}

module.exports = { parseSizes, aldiSearch, reweSearch, reweMarket, offersSearch, cached };

const { aldiSearch, reweSearch, reweMarket, offersSearch } = require("./sources");
const { BASE } = require("./products");

const STORES = ["aldi", "lidl", "kaufland", "rewe", "edeka"];
const DEFAULT_EXC = /(^|[\s,!-])bio([\s,-]|$)|bio-|demeter|naturland|vegan|veggie/;

function units(target) { return [target.u, ...(target.alias || [])]; }

// Wählt aus Trefferliste das günstigste passende Produkt; Preis wird auf die Zielmenge umgerechnet.
function sizeLabel(sizes) {
  const s = (sizes || [])[0];
  if (!s) return "";
  const f = (n) => n.toLocaleString("de-DE");
  if (s.u === "g") return s.a >= 1000 ? `${f(s.a / 1000)} kg` : `${f(s.a)} g`;
  if (s.u === "ml") return s.a >= 1000 ? `${f(s.a / 1000)} l` : `${f(s.a)} ml`;
  return `${f(s.a)} ${{ stk: "Stück", wl: "WL", rolle: "Rollen" }[s.u] || s.u}`;
}

function bestMatch(items, rule) {
  const [lo, hi] = rule.range || [0.5, 2.1];
  const ok = [];
  for (const it of items) {
    const text = `${it.name} ${it.desc || ""}`.toLowerCase();
    if (!rule.inc.every((r) => r.test(text))) continue;
    if (rule.exc && rule.exc.test(text)) continue;
    if (!rule.allowBio && DEFAULT_EXC.test(text)) continue;
    if (/nur online|adventskalender|kalender|geschenk/.test(text)) continue;
    const z = (it.sizes || []).find((s) => units(rule.size).includes(s.u));
    let ratio = z ? z.a / rule.size.a : null;
    if (rule.perKg && it.refUnit === "kg" && it.refPrice) {
      ok.push({ it, ratio: Math.round((it.price / it.refPrice) * 1000) / (rule.size.a), v: Math.round(it.refPrice * rule.size.a / 10) / 100, exact: true, perKg: true });
      continue;
    }
    if (ratio == null || ratio < lo || ratio > hi) continue;
    ok.push({ it, ratio, v: Math.round((it.price / ratio) * 100) / 100, exact: Math.abs(ratio - 1) <= 0.12 });
  }
  if (!ok.length) return null;
  // Gleiche Packungsgröße wird leicht bevorzugt, damit keine Großpackungen den Vergleich verzerren.
  ok.sort((a, b) => a.v * (a.exact ? 1 : 1.1) - b.v * (b.exact ? 1 : 1.1));
  const b = ok[0];
  return {
    v: b.v, name: b.it.name, packPrice: b.it.price, perKg: !!b.perKg, pack: b.it.desc != null ? sizeLabel(b.it.sizes) : b.it.sizeText || "", desc: b.it.desc || null, ratio: Math.round(b.ratio * 100) / 100,
    regular: b.it.regular || null, until: b.it.until || null, from: b.it.from || null, loyalty: b.it.loyalty || /(^|\s)(mit|nur mit) .{0,20}app\b|plus app|payback|kundenkarte/i.test(`${b.it.name} ${b.it.desc || ""}`),
    storeName: b.it.storeName || null, url: b.it.url || null,
  };
}

const safe = (p) => p.then((v) => ({ v }), (e) => ({ err: String(e.message || e) }));

async function priceRule(rule, plz, market, status) {
  const q = rule.q, qo = rule.qo || rule.q;
  const [aldi, rewe, offers] = await Promise.all([safe(aldiSearch(q)), safe(reweSearch(q, market)), safe(offersSearch(qo, plz))]);
  for (const [k, r] of [["aldi", aldi], ["rewe", rewe], ["angebote", offers]]) if (r.err) status[k] = r.err;
  const live = { aldi: aldi.v ? bestMatch(aldi.v, rule) : null, rewe: rewe.v ? bestMatch(rewe.v, rule) : null };
  const offerBy = {};
  for (const s of STORES) offerBy[s] = offers.v ? bestMatch(offers.v.filter((o) => o.store === s), rule) : null;
  const derivedFrom = { lidl: "aldi", kaufland: "aldi", edeka: "rewe" };
  return STORES.map((s, i) => {
    let base;
    if (live[s]) base = { ...live[s], kind: "live" };
    else if (derivedFrom[s] && live[derivedFrom[s]]) base = { v: live[derivedFrom[s]].v, kind: "derived", src: derivedFrom[s], ref: live[derivedFrom[s]].name };
    else if (rule.est) base = { v: rule.est[i], kind: "estimate" };
    else base = null;
    const offer = offerBy[s] ? { ...offerBy[s], kind: "offer" } : null;
    if (!base && !offer) return null;
    const pick = offer && (!base || offer.v < base.v) ? offer : base;
    return { ...pick, base: pick === offer ? base : null, offer: pick === offer ? null : offer };
  });
}

async function priceAll(plz, rules = BASE) {
  const status = {};
  const market = await reweMarket(plz).catch((e) => { status.rewe = String(e.message || e); return { id: "1931630", fallback: true }; });
  const items = {};
  await Promise.all(rules.map(async (r) => { items[r.id] = await priceRule(r, plz, market, status); }));
  return { plz, updated: new Date().toISOString(), reweMarket: market, status, items };
}

// Läuft im Hintergrund weiter; die Seite holt sich Zwischenstände, bis alles da ist.
const jobs = new Map();
function priceJob(plz, rules = BASE) {
  let j = jobs.get(plz);
  if (!j || (j.done && Date.now() - j.started > 20 * 60e3)) {
    j = { plz, started: Date.now(), done: false, items: j ? { ...j.items } : {}, status: {}, reweMarket: null };
    jobs.set(plz, j);
    const job = j;
    (async () => {
      job.reweMarket = await reweMarket(plz).catch((e) => { job.status.rewe = String(e.message || e); return { id: "1931630", fallback: true }; });
      await Promise.all(rules.map(async (r) => { job.items[r.id] = await priceRule(r, plz, job.reweMarket, job.status); }));
    })().catch((e) => { job.status.server = String(e.message || e); }).finally(() => { job.done = true; job.updated = new Date().toISOString(); });
  }
  return { plz, updated: j.updated || new Date().toISOString(), pending: !j.done, reweMarket: j.reweMarket, status: j.status, items: j.items };
}

module.exports = { priceAll, priceJob, priceRule, bestMatch, STORES };

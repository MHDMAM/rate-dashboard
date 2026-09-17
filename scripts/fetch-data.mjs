// Pulls prices from several free, keyless sources and writes data/latest.json + data/history.json.
// Every source is fetched independently and wrapped in try/catch so one dead endpoint
// never blocks the others - the dashboard should degrade gracefully, not go blank.

import * as cheerio from "cheerio";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");
const HISTORY_MAX_POINTS = 300; // ~ a week at 30-min cadence, plenty for sparklines

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TROY_OZ_IN_GRAMS = 31.1034768;

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "User-Agent": UA, Accept: "application/json,text/plain,*/*", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "User-Agent": UA, Accept: "text/html,*/*", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function safe(name, fn) {
  try {
    return { ok: true, name, data: await fn() };
  } catch (err) {
    console.error(`[warn] source "${name}" failed:`, err.message);
    return { ok: false, name, error: err.message };
  }
}

// --- Metals spot prices (USD/oz), two independent providers for cross-checking ---

async function fetchGoldApi() {
  const [gold, silver, platinum] = await Promise.all([
    fetchJson("https://api.gold-api.com/price/XAU"),
    fetchJson("https://api.gold-api.com/price/XAG"),
    fetchJson("https://api.gold-api.com/price/XPT"),
  ]);
  return {
    source: "gold-api.com",
    sourceUrl: "https://gold-api.com/",
    unit: "USD/oz",
    gold: gold.price,
    silver: silver.price,
    platinum: platinum.price,
    updatedAt: gold.updatedAt || new Date().toISOString(),
  };
}

async function fetchGoldPriceOrg() {
  const json = await fetchJson("https://data-asg.goldprice.org/dbXRates/USD", {
    headers: { Referer: "https://goldprice.org/", Origin: "https://goldprice.org" },
  });
  const item = json.items?.[0];
  if (!item) throw new Error("no items in response");
  return {
    source: "goldprice.org",
    sourceUrl: "https://goldprice.org/",
    unit: "USD/oz",
    gold: item.xauPrice,
    silver: item.xagPrice,
    platinum: null,
    updatedAt: new Date(json.ts).toISOString(),
  };
}

// --- General FX reference rates (mid-market, no bank/dealer spread) ---

async function fetchOpenExchangeRates() {
  const json = await fetchJson("https://open.er-api.com/v6/latest/USD");
  if (json.result !== "success") throw new Error("API reported failure");
  return {
    source: "open.er-api.com",
    sourceUrl: "https://www.exchangerate-api.com/",
    base: "USD",
    rates: json.rates,
    updatedAt: json.time_last_update_utc,
  };
}

async function fetchFrankfurter() {
  const json = await fetchJson("https://api.frankfurter.app/latest?from=EUR");
  return {
    source: "frankfurter.app (ECB)",
    sourceUrl: "https://www.frankfurter.app/",
    base: "EUR",
    rates: json.rates,
    updatedAt: json.date,
  };
}

// --- Malaysian money-changer cash boards (actual buy/sell you'd get over the counter) ---

async function fetchMerchantrade() {
  const branchCode = "MY0100141";
  const json = await fetchJson(`https://rateboard.mtradeasia.com/api/branches/getBranchData/${branchCode}`, {
    headers: { Referer: `https://rateboard.mtradeasia.com/${branchCode}` },
  });
  const rates = (json.currencyExchange || []).map((r) => ({
    code: r.currencyCode,
    name: r.currencyName,
    unit: r.unit,
    buy: r.weBuy,
    sell: r.weSell,
  }));
  return {
    source: "Merchantrade Asia",
    sourceUrl: `https://rateboard.mtradeasia.com/${branchCode}`,
    branchName: json.branchName,
    rates,
    updatedAt: new Date().toISOString(),
  };
}

// BNM publishes official spot rates at fixed daily sessions. We ask for the
// current MYR-calendar month/day and walk sessions latest-first since earlier
// sessions may not be published yet on a given day.
const BNM_CURRENCY_CODES = [
  "USD", "GBP", "EUR", "CHF", "AUD", "NZD", "CAD", "JPY", "SGD", "HKD",
  "THB", "CNY", "IDR", "PHP", "VND", "KRW", "INR", "SAR", "AED", "BND",
  "TWD", "PKR", "BDT", "MMK", "KWD", "QAR",
];

function myrNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function parseDateParts(text) {
  const s = text.trim();
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return { d: +m[1], mo: +m[2] - 1, y: +m[3] };
  m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return { d: +m[3], mo: +m[2] - 1, y: +m[1] };
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mo = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mo !== -1) return { d: +m[1], mo, y: +m[3] };
  }
  return null;
}

function parseRateCell(text) {
  const nums = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (nums.length >= 2) return { buy: nums[0], sell: nums[1] };
  if (nums.length === 1) return { buy: nums[0], sell: nums[0] };
  return null;
}

async function fetchBnmSession(sessionTime, monthStart, yearStart) {
  const params = new URLSearchParams({
    p_p_id: "bnm_exchange_rate_display_portlet",
    p_p_lifecycle: "0",
    p_p_state: "normal",
    p_p_mode: "view",
    _bnm_exchange_rate_display_portlet_monthStart: String(monthStart),
    _bnm_exchange_rate_display_portlet_yearStart: String(yearStart),
    _bnm_exchange_rate_display_portlet_monthEnd: String(monthStart),
    _bnm_exchange_rate_display_portlet_yearEnd: String(yearStart),
    _bnm_exchange_rate_display_portlet_sessionTime: sessionTime,
    _bnm_exchange_rate_display_portlet_rateType: "SR",
    _bnm_exchange_rate_display_portlet_quotation: "rm",
  });
  const html = await fetchText(`https://www.bnm.gov.my/exchange-rates?${params.toString()}`);
  const $ = cheerio.load(html);
  const today = myrNow();
  const todayParts = { d: today.getUTCDate(), mo: today.getUTCMonth(), y: today.getUTCFullYear() };

  let rates = null;
  $("table").each((_, table) => {
    if (rates) return;
    const $table = $(table);
    const headerCells = $table.find("thead th, tr:first-child th, tr:first-child td").toArray();
    const columnCodes = headerCells.map((cell) => {
      const text = $(cell).text().trim().toUpperCase();
      return BNM_CURRENCY_CODES.find((code) => text.includes(code)) || null;
    });
    if (!columnCodes.some(Boolean)) return;

    $table.find("tbody tr").each((_, row) => {
      if (rates) return;
      const cells = $(row).find("td").toArray();
      if (cells.length === 0) return;
      const dateParts = parseDateParts($(cells[0]).text());
      if (!dateParts) return;
      if (dateParts.d !== todayParts.d || dateParts.mo !== todayParts.mo || dateParts.y !== todayParts.y) return;

      const found = [];
      cells.forEach((cell, idx) => {
        const code = columnCodes[idx];
        if (!code) return;
        const parsed = parseRateCell($(cell).text());
        if (parsed) found.push({ code, ...parsed });
      });
      if (found.length > 0) rates = found;
    });
  });

  if (!rates) throw new Error(`no rows parsed for today at session ${sessionTime}`);
  return rates;
}

async function fetchBnm() {
  const today = myrNow();
  const monthStart = today.getUTCMonth(); // BNM's own param is 0-indexed (Jan = 0)
  const yearStart = today.getUTCFullYear();
  const sessions = ["1700", "1200", "1130", "0900"];

  let lastErr;
  for (const session of sessions) {
    try {
      const rates = await fetchBnmSession(session, monthStart, yearStart);
      return {
        source: "Bank Negara Malaysia (BNM)",
        sourceUrl: "https://www.bnm.gov.my/exchange-rates",
        session,
        rateType: "SR",
        rates,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("no BNM session had today's rates");
}

async function fetchMyMoneyMaster() {
  const html = await fetchText("http://www.mymoneymaster.com.my/Home/full_rate_board");
  const $ = cheerio.load(html);
  const rates = [];
  $("tbody#ajaxmobval tr").each((_, el) => {
    const row = $(el);
    const code = row.find(".rate-grap-currency-short").first().text().trim();
    const unit = row.find(".rate-grap-currency-breif").first().text().replace(/ /g, " ").trim();
    const buy = parseFloat(row.find(".rate-grap-buy").first().text().trim());
    const sell = parseFloat(row.find(".rate-grap-sell").first().text().trim());
    if (code && Number.isFinite(buy) && Number.isFinite(sell)) {
      rates.push({ code, unit, buy, sell });
    }
  });
  if (rates.length === 0) throw new Error("no rows parsed - page structure may have changed");
  return {
    source: "My Money Master",
    sourceUrl: "http://www.mymoneymaster.com.my/Home/full_rate_board",
    rates,
    updatedAt: new Date().toISOString(),
  };
}

// --- Local retail: physical gold/silver bar listings ---

async function fetchAstonAndSons() {
  const categories = [
    { key: "gold-bars", url: "https://www.astonandsons.com.my/product-category/gold-bars/" },
    { key: "silver-bars", url: "https://www.astonandsons.com.my/product-category/silver-bars/" },
  ];
  const products = [];
  for (const cat of categories) {
    const html = await fetchText(cat.url);
    const $ = cheerio.load(html);
    $("article.as-product-card").each((_, el) => {
      const card = $(el);
      const name = card.find(".as-product-card-name a").first().text().trim();
      const url = card.find(".as-product-card-name a").first().attr("href");
      const category = card.find(".as-product-card-cat").first().text().trim() || cat.key;
      const priceText = card.find(".woocommerce-Price-amount").first().text().replace(/[^\d.]/g, "");
      const price = parseFloat(priceText);
      if (name && Number.isFinite(price)) {
        products.push({ name, category, price, currency: "MYR", url });
      }
    });
  }
  if (products.length === 0) throw new Error("no products parsed - page structure may have changed");
  return {
    source: "Aston & Sons",
    sourceUrl: "https://www.astonandsons.com.my/product-category/gold-bars/",
    products,
    updatedAt: new Date().toISOString(),
  };
}

function round(n, dp = 2) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

async function loadJsonSafe(p, fallback) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const [goldApi, goldPriceOrg, openER, frankfurter, merchantrade, myMoneyMaster, bnm, astonAndSons] = await Promise.all([
    safe("gold-api.com", fetchGoldApi),
    safe("goldprice.org", fetchGoldPriceOrg),
    safe("open.er-api.com", fetchOpenExchangeRates),
    safe("frankfurter.app", fetchFrankfurter),
    safe("Merchantrade Asia", fetchMerchantrade),
    safe("My Money Master", fetchMyMoneyMaster),
    safe("Bank Negara Malaysia", fetchBnm),
    safe("Aston & Sons", fetchAstonAndSons),
  ]);

  const previous = await loadJsonSafe(LATEST_PATH, null);

  // Prefer live data; fall back to the last good snapshot per-source so a single
  // flaky fetch doesn't blank out that whole card on the dashboard.
  const metals = {
    goldApi: goldApi.ok ? goldApi.data : previous?.metals?.goldApi ?? null,
    goldPriceOrg: goldPriceOrg.ok ? goldPriceOrg.data : previous?.metals?.goldPriceOrg ?? null,
  };
  const fx = {
    openER: openER.ok ? openER.data : previous?.fx?.openER ?? null,
    frankfurter: frankfurter.ok ? frankfurter.data : previous?.fx?.frankfurter ?? null,
  };
  const myCashRates = {
    merchantrade: merchantrade.ok ? merchantrade.data : previous?.myCashRates?.merchantrade ?? null,
    myMoneyMaster: myMoneyMaster.ok ? myMoneyMaster.data : previous?.myCashRates?.myMoneyMaster ?? null,
    bnm: bnm.ok ? bnm.data : previous?.myCashRates?.bnm ?? null,
  };
  const astonAndSonsData = astonAndSons.ok ? astonAndSons.data : previous?.astonAndSons ?? null;

  const usdMyrMid = fx.openER?.rates?.MYR ?? null;
  const derived = {
    usdMyrMid: round(usdMyrMid, 4),
    goldMyrPerGram: round((metals.goldApi?.gold * usdMyrMid) / TROY_OZ_IN_GRAMS, 2),
    silverMyrPerGram: round((metals.goldApi?.silver * usdMyrMid) / TROY_OZ_IN_GRAMS, 2),
    platinumMyrPerGram: round((metals.goldApi?.platinum * usdMyrMid) / TROY_OZ_IN_GRAMS, 2),
  };

  const latest = {
    updatedAt: new Date().toISOString(),
    metals,
    fx,
    myCashRates,
    astonAndSons: astonAndSonsData,
    derived,
    sourceStatus: [goldApi, goldPriceOrg, openER, frankfurter, merchantrade, myMoneyMaster, bnm, astonAndSons].map((r) => ({
      name: r.name,
      ok: r.ok,
      error: r.ok ? undefined : r.error,
    })),
  };

  await writeFile(LATEST_PATH, JSON.stringify(latest, null, 2));

  const history = await loadJsonSafe(HISTORY_PATH, []);
  history.push({
    t: latest.updatedAt,
    goldUsdOz: metals.goldApi?.gold ?? null,
    silverUsdOz: metals.goldApi?.silver ?? null,
    platinumUsdOz: metals.goldApi?.platinum ?? null,
    usdMyr: derived.usdMyrMid,
  });
  const trimmed = history.slice(-HISTORY_MAX_POINTS);
  await writeFile(HISTORY_PATH, JSON.stringify(trimmed, null, 2));

  console.log("Wrote data/latest.json and data/history.json");
  console.log(latest.sourceStatus.map((s) => `${s.ok ? "OK  " : "FAIL"} ${s.name}${s.error ? ` (${s.error})` : ""}`).join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

const METAL_COLORS = { gold: "#c98500", silver: "#6e7681", platinum: "#4a3aa7" };

const CURRENCY_FLAGS = {
  USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", CHF: "🇨🇭", SGD: "🇸🇬", AUD: "🇦🇺",
  NZD: "🇳🇿", CAD: "🇨🇦", JPY: "🇯🇵", CNY: "🇨🇳", HKD: "🇭🇰", THB: "🇹🇭",
  IDR: "🇮🇩", PHP: "🇵🇭", VND: "🇻🇳", KRW: "🇰🇷", INR: "🇮🇳", SAR: "🇸🇦",
  AED: "🇦🇪", BND: "🇧🇳", TWD: "🇹🇼", MYR: "🇲🇾", SYP: "🇸🇾",
};

function flag(code) {
  return CURRENCY_FLAGS[code] || "🏳️";
}

function fmtMoney(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function timeAgo(iso) {
  if (!iso) return "unknown";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(iso).toLocaleString();
}

async function loadJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function renderMetals(latest, history) {
  const grid = document.getElementById("metals-grid");
  grid.innerHTML = "";

  const metalDefs = [
    { key: "gold", label: "Gold (XAU)", color: METAL_COLORS.gold, myrKey: "goldMyrPerGram" },
    { key: "silver", label: "Silver (XAG)", color: METAL_COLORS.silver, myrKey: "silverMyrPerGram" },
    { key: "platinum", label: "Platinum (XPT)", color: METAL_COLORS.platinum, myrKey: "platinumMyrPerGram" },
  ];

  const goldApi = latest.metals?.goldApi;
  const goldPriceOrg = latest.metals?.goldPriceOrg;

  metalDefs.forEach((def) => {
    const usdOz = goldApi?.[def.key];
    const myrGram = latest.derived?.[def.myrKey];
    const compareVal = def.key === "platinum" ? null : goldPriceOrg?.[def.key];

    const card = document.createElement("div");
    card.className = "metal-card";
    card.innerHTML = `
      <div class="metal-card-head">
        <span class="metal-name"><span class="metal-swatch" style="background:${def.color}"></span>${def.label}</span>
      </div>
      <div class="metal-price">$${fmtMoney(usdOz)}<span class="unit">/oz</span></div>
      <div class="metal-sub">RM ${fmtMoney(myrGram)} / gram &middot; source: gold-api.com</div>
      ${compareVal != null ? `<div class="metal-compare">goldprice.org: $${fmtMoney(compareVal)}/oz</div>` : ""}
      <div class="metal-sparkline"><canvas id="spark-${def.key}"></canvas></div>
    `;
    grid.appendChild(card);
  });

  if (window.Chart && Array.isArray(history) && history.length > 1) {
    const labels = history.map((h) => h.t);
    metalDefs.forEach((def) => {
      const seriesKey = { gold: "goldUsdOz", silver: "silverUsdOz", platinum: "platinumUsdOz" }[def.key];
      const values = history.map((h) => h[seriesKey]);
      const canvas = document.getElementById(`spark-${def.key}`);
      if (!canvas) return;
      new Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              data: values,
              borderColor: def.color,
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.25,
              fill: false,
              spanGaps: true,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          scales: { x: { display: false }, y: { display: false } },
          plugins: {
            legend: { display: false },
            tooltip: {
              intersect: false,
              mode: "index",
              callbacks: {
                title: (items) => new Date(items[0].label).toLocaleString(),
                label: (item) => `$${fmtMoney(item.parsed.y)}/oz`,
              },
            },
          },
        },
      });
    });
  }
}

// open.er-api.com rates are "units of X per 1 USD". Convert to "RM per 1 unit of X"
// by dividing MYR-per-USD by X-per-USD, then scale to match the per-100/per-1000/etc
// quoting convention the money-changer boards use for that currency.
const UNIT_SCALE = { JPY: 100, KRW: 1000, IDR: 1e6, VND: 1e6 };

function myrPerUnit(mid, code) {
  const perUsd = mid[code];
  const myrPerUsd = mid.MYR;
  if (!perUsd || !myrPerUsd) return null;
  return (myrPerUsd / perUsd) * (UNIT_SCALE[code] || 1);
}

function buildFxRows(latest) {
  const merch = latest.myCashRates?.merchantrade?.rates || [];
  const mmm = latest.myCashRates?.myMoneyMaster?.rates || [];
  const bnm = latest.myCashRates?.bnm?.rates || [];

  // Join on a normalized currency code (strip BIG/SMALL/MEDIUM qualifiers).
  const baseCode = (code) => code.replace(/\s+(BIG|SMALL|MEDIUM)$/i, "").trim();

  const rows = new Map();
  const ensure = (code) => {
    if (!rows.has(code)) rows.set(code, { code, merchant: null, mmm: null, bnm: null });
    return rows.get(code);
  };
  merch.forEach((r) => {
    ensure(baseCode(r.code)).merchant = { buy: r.buy, sell: r.sell };
  });
  mmm.forEach((r) => {
    ensure(baseCode(r.code)).mmm = { buy: r.buy, sell: r.sell };
  });
  bnm.forEach((r) => {
    ensure(baseCode(r.code)).bnm = { buy: r.buy, sell: r.sell };
  });

  return rows;
}

function renderFx(latest) {
  const tbody = document.getElementById("fx-tbody");
  const rows = buildFxRows(latest);
  const mid = latest.fx?.openER?.rates || {};

  const priority = ["USD", "SGD", "EUR", "GBP", "AUD", "JPY", "CNY", "THB", "HKD", "IDR"];
  const sorted = [...rows.values()].sort((a, b) => {
    const ai = priority.indexOf(a.code);
    const bi = priority.indexOf(b.code);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.code.localeCompare(b.code);
  });

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No data available.</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted
    .map((row) => {
      const scale = UNIT_SCALE[row.code] || 1;
      const myrUnit = myrPerUnit(mid, row.code);
      const midCell = myrUnit != null ? `RM ${fmtMoney(myrUnit, 4)}${scale > 1 ? ` /${scale}` : ""}` : "—";
      return `
        <tr>
          <td>${flag(row.code)} ${row.code}</td>
          <td>${row.merchant ? `${fmtMoney(row.merchant.buy, 4)} / ${fmtMoney(row.merchant.sell, 4)}` : "—"}</td>
          <td>${row.mmm ? `${fmtMoney(row.mmm.buy, 4)} / ${fmtMoney(row.mmm.sell, 4)}` : "—"}</td>
          <td>${row.bnm ? `${fmtMoney(row.bnm.buy, 4)} / ${fmtMoney(row.bnm.sell, 4)}` : "—"}</td>
          <td>${midCell}</td>
        </tr>
      `;
    })
    .join("");
}

function renderPriority(latest) {
  const strip = document.getElementById("priority-strip");
  const rows = buildFxRows(latest);
  const mid = latest.fx?.openER?.rates || {};

  const cards = ["USD", "EUR", "CHF"].map((code) => {
    const row = rows.get(code);
    const myrUnit = myrPerUnit(mid, code);
    const rateCell = myrUnit != null ? `RM ${fmtMoney(myrUnit, 4)}` : "—";
    const cashSub = row?.merchant
      ? `Cash: ${fmtMoney(row.merchant.buy, 4)} / ${fmtMoney(row.merchant.sell, 4)}`
      : "";
    return `
      <div class="priority-card">
        <div class="priority-head"><span class="flag">${flag(code)}</span><span class="curr-name">${code}</span></div>
        <div class="priority-rate">${rateCell}</div>
        ${cashSub ? `<div class="priority-sub">${cashSub}</div>` : ""}
      </div>
    `;
  });

  // SYP has no Malaysian dealer quotes. Anchor on SP-Today's real parallel-market
  // USD rate when we have it (general FX feeds carry an official rate that lags
  // Syria's street rate); only fall back to the mid-market feed's own SYP figure
  // when SP-Today is unavailable, and say which one is showing.
  const spUsd = latest.spToday?.rates?.find((r) => r.code === "USD");
  const spEur = latest.spToday?.rates?.find((r) => r.code === "EUR");
  const sypPerUsd = spUsd ? (spUsd.buy + spUsd.sell) / 2 : mid.SYP;
  const isLive = Boolean(spUsd);

  if (sypPerUsd != null) {
    const sypRows = [
      { code: "USD", per: sypPerUsd },
      { code: "EUR", per: spEur ? (spEur.buy + spEur.sell) / 2 : mid.EUR ? sypPerUsd / mid.EUR : null },
      { code: "CHF", per: mid.CHF ? sypPerUsd / mid.CHF : null },
      { code: "MYR", per: mid.MYR ? sypPerUsd / mid.MYR : null },
    ];
    cards.push(`
      <div class="priority-card syp">
        <div class="priority-head"><span class="flag">${flag("SYP")}</span><span class="curr-name">SYP</span></div>
        <div class="syp-rows">
          ${sypRows
            .map((r) => `<div>1 ${flag(r.code)} ${r.code} = ${r.per != null ? fmtMoney(r.per, 0) : "—"} SYP</div>`)
            .join("")}
        </div>
        <div class="priority-sub">${isLive ? "Source: SP-Today (parallel market)" : "Source: mid-market feed (may lag street rate)"}</div>
      </div>
    `);
  }

  strip.innerHTML = cards.join("");
}

function renderSypGold(latest) {
  const tbody = document.getElementById("syp-gold-tbody");
  const items = latest.spTodayGold?.items || [];
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="2" class="muted">No data available.</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map((it) => `<tr><td>${it.label}</td><td>${fmtMoney(it.price, 0)} SYP</td></tr>`)
    .join("");
}

function renderFeatured(latest) {
  const grid = document.getElementById("featured-grid");
  const products = latest.featuredProducts?.products || [];
  if (products.length === 0) {
    grid.innerHTML = `<p class="muted">No data available.</p>`;
    return;
  }
  grid.innerHTML = products
    .map((p) => {
      const stockLabel = p.inStock ? `In stock${p.stockCount ? ` (${p.stockCount})` : ""}` : "Out of stock";
      const image = p.image
        ? `<img class="featured-card-image" src="${p.image}" alt="${p.name}" loading="lazy" />`
        : `<div class="featured-card-image placeholder">No image</div>`;
      return `
        <div class="featured-card">
          <a class="featured-card-image-wrap" href="${p.url}" target="_blank" rel="noopener" aria-label="${p.name}">
            ${image}
            <span class="featured-stock ${p.inStock ? "in" : "out"}">${stockLabel}</span>
          </a>
          <div class="featured-card-body">
            <div class="featured-card-name"><a href="${p.url}" target="_blank" rel="noopener">${p.name}</a></div>
            <div class="featured-card-meta">
              <span class="featured-weight">${p.weightLabel || "—"}</span>
              <span class="featured-price">RM ${fmtMoney(p.price)}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderRetail(latest) {
  const tbody = document.getElementById("retail-tbody");
  const products = latest.astonAndSons?.products || [];
  if (products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No data available.</td></tr>`;
    return;
  }
  tbody.innerHTML = products
    .map(
      (p) => `
        <tr>
          <td>${p.name}</td>
          <td>${p.category}</td>
          <td>RM ${fmtMoney(p.price)}</td>
          <td>${p.url ? `<a href="${p.url}" target="_blank" rel="noopener">View</a>` : "—"}</td>
        </tr>
      `
    )
    .join("");
}

function renderStatus(latest) {
  const list = document.getElementById("source-status");
  const items = latest.sourceStatus || [];
  list.innerHTML = items
    .map(
      (s) => `<li><span class="dot ${s.ok ? "ok" : "fail"}"></span>${s.name}${s.ok ? "" : ` — ${s.error || "unavailable"}`}</li>`
    )
    .join("");
}

async function init() {
  const updatedEl = document.getElementById("updated-at");
  try {
    const [latest, history] = await Promise.all([
      loadJson("data/latest.json"),
      loadJson("data/history.json").catch(() => []),
    ]);

    updatedEl.textContent = `Updated ${timeAgo(latest.updatedAt)}`;
    renderMetals(latest, history);
    renderPriority(latest);
    renderSypGold(latest);
    renderFeatured(latest);
    renderFx(latest);
    renderRetail(latest);
    renderStatus(latest);
  } catch (err) {
    updatedEl.textContent = "Failed to load data";
    console.error(err);
  }
}

init();

const METAL_COLORS = { gold: "#c98500", silver: "#6e7681", platinum: "#4a3aa7" };

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
      <canvas class="metal-sparkline" id="spark-${def.key}"></canvas>
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

function renderFx(latest) {
  const tbody = document.getElementById("fx-tbody");
  const merch = latest.myCashRates?.merchantrade?.rates || [];
  const mmm = latest.myCashRates?.myMoneyMaster?.rates || [];
  const mid = latest.fx?.openER?.rates || {};

  // Join on a normalized currency code (strip BIG/SMALL/MEDIUM qualifiers).
  const baseCode = (code) => code.replace(/\s+(BIG|SMALL|MEDIUM)$/i, "").trim();

  const rows = new Map();
  merch.forEach((r) => {
    const code = baseCode(r.code);
    if (!rows.has(code)) rows.set(code, { code, label: r.code, merchant: null, mmm: null });
    const row = rows.get(code);
    if (!row.merchant || r.code === code) row.merchant = { buy: r.buy, sell: r.sell };
  });
  mmm.forEach((r) => {
    const code = baseCode(r.code);
    if (!rows.has(code)) rows.set(code, { code, label: r.code, merchant: null, mmm: null });
    const row = rows.get(code);
    row.mmm = { buy: r.buy, sell: r.sell };
  });

  const priority = ["USD", "SGD", "EUR", "GBP", "AUD", "JPY", "CNY", "THB", "HKD", "IDR"];
  const sorted = [...rows.values()].sort((a, b) => {
    const ai = priority.indexOf(a.code);
    const bi = priority.indexOf(b.code);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.code.localeCompare(b.code);
  });

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No data available.</td></tr>`;
    return;
  }

  // open.er-api.com rates are "units of X per 1 USD". Convert to "RM per 1 unit of X"
  // by dividing MYR-per-USD by X-per-USD, then scale to match the per-100/per-1000/etc
  // quoting convention the money-changer boards use for that currency.
  const unitScale = { JPY: 100, KRW: 1000, IDR: 1e6, VND: 1e6 };
  tbody.innerHTML = sorted
    .map((row) => {
      const perUsd = mid[row.code];
      const myrPerUsd = mid.MYR;
      const scale = unitScale[row.code] || 1;
      const myrPerUnit = perUsd && myrPerUsd ? (myrPerUsd / perUsd) * scale : null;
      const midCell = myrPerUnit != null ? `RM ${fmtMoney(myrPerUnit, 4)}${scale > 1 ? ` /${scale}` : ""}` : "—";
      return `
        <tr>
          <td>${row.code}</td>
          <td>${row.merchant ? `${fmtMoney(row.merchant.buy, 4)} / ${fmtMoney(row.merchant.sell, 4)}` : "—"}</td>
          <td>${row.mmm ? `${fmtMoney(row.mmm.buy, 4)} / ${fmtMoney(row.mmm.sell, 4)}` : "—"}</td>
          <td>${midCell}</td>
        </tr>
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
    renderFx(latest);
    renderRetail(latest);
    renderStatus(latest);
  } catch (err) {
    updatedEl.textContent = "Failed to load data";
    console.error(err);
  }
}

init();

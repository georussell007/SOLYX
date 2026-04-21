/* ============================================================
   SOLYX — Market Intelligence Terminal · app.js
   ============================================================ */

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let watchlist     = [];    // array of {symbol, name, price, change_pct}
let activeSymbol  = null;  // currently displayed ticker
let currentResult = null;  // last successful /api/analyze response
let _emptyLi      = null;  // cached ref to #watchlistEmpty — survives nav.innerHTML rewrites

// Deep Dive modal state
let _ddSymbol = null;
let _ddPeriod = "1mo";
let _ddPrices = null;

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------
function loadWatchlist() {
  try {
    const raw    = localStorage.getItem("watchlist");
    const parsed = raw ? JSON.parse(raw) : [];
    watchlist = parsed.map(item =>
      typeof item === "string"
        ? { symbol: item, name: item, price: null, change_pct: null }
        : item
    );
  } catch (_) {
    watchlist = [];
  }
}

function saveWatchlist() {
  localStorage.setItem("watchlist", JSON.stringify(watchlist));
}

function loadLastSymbol() {
  return localStorage.getItem("lastSymbol") || null;
}

function saveLastSymbol(sym) {
  localStorage.setItem("lastSymbol", sym);
}

// ---------------------------------------------------------------------------
// Market strip
// ---------------------------------------------------------------------------
function formatPrice(val) {
  if (val == null) return "—";
  return Number(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(val) {
  if (val == null) return "—";
  const sign = val >= 0 ? "+" : "";
  return `${sign}${Number(val).toFixed(2)}%`;
}

function renderMarketStrip(indices) {
  const container = document.getElementById("stripIndices");
  if (!indices || !indices.length) return;

  container.innerHTML = indices.map(idx => {
    const chg   = idx.change_pct;
    const cls   = chg == null ? "flat" : chg > 0 ? "up" : chg < 0 ? "down" : "flat";
    const arrow = chg == null ? "" : chg > 0 ? "▲ " : chg < 0 ? "▼ " : "";
    return `
      <div class="index-card">
        <span class="index-name">${idx.name}</span>
        <span class="index-price">${formatPrice(idx.price)}</span>
        <span class="index-change ${cls}">${arrow}${formatPct(chg)}</span>
      </div>`;
  }).join("");

  const ts = document.getElementById("stripTimestamp");
  const now = new Date();
  ts.textContent = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function dismissSplash() {
  const splash = document.getElementById("coldSplash");
  if (splash && !splash.classList.contains("hidden")) {
    splash.classList.add("hidden");
    setTimeout(() => { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 700);
  }
}

async function fetchIndices() {
  try {
    const res  = await fetch("/api/indices");
    const data = await res.json();
    renderMarketStrip(data.indices || []);
  } catch (_) { /* fail silently */ } finally {
    dismissSplash();
  }
}

// ---------------------------------------------------------------------------
// Sidebar / Watchlist
// ---------------------------------------------------------------------------
function inWatchlist(symbol) {
  return watchlist.some(w => w.symbol === symbol);
}

function renderSidebar() {
  const nav = document.getElementById("watchlistNav");
  if (!_emptyLi) _emptyLi = document.getElementById("watchlistEmpty");

  if (!watchlist.length) {
    nav.innerHTML = "";
    if (_emptyLi) { nav.appendChild(_emptyLi); _emptyLi.style.display = "block"; }
    return;
  }

  if (_emptyLi) _emptyLi.style.display = "none";
  nav.innerHTML = watchlist.map(item => {
    const isActive = item.symbol === activeSymbol;
    const chg      = item.change_pct;
    const chgCls   = chg == null ? "flat" : chg > 0 ? "up" : "down";
    const chgStr   = chg == null ? "—" : `${chg > 0 ? "+" : ""}${Number(chg).toFixed(2)}%`;
    const prStr    = item.price == null ? "—"
      : Number(item.price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const nameStr  = (item.name && item.name !== item.symbol) ? item.name.slice(0, 20) : "";

    return `
      <li class="watchlist-item${isActive ? " active" : ""}" data-ticker="${item.symbol}">
        <div class="wl-main">
          <div class="wl-top">
            <span class="wl-ticker">${item.symbol}</span>
            <span class="wl-price">${prStr}</span>
          </div>
          <div class="wl-bottom">
            <span class="wl-name">${nameStr}</span>
            <span class="wl-chg ${chgCls}">${chgStr}</span>
          </div>
        </div>
        <div class="wl-actions">
          <button class="wl-dive"   data-dive="${item.symbol}"   title="Deep Dive">↗</button>
          <button class="wl-remove" data-remove="${item.symbol}" title="Remove">✕</button>
        </div>
      </li>`;
  }).join("");

  // Click row → load stock (guard action buttons so they don't also trigger load)
  nav.querySelectorAll(".watchlist-item").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".wl-remove") || e.target.closest(".wl-dive")) return;
      analyzeSymbol(row.dataset.ticker);
    });
  });

  // Click ↗ → open Deep Dive
  nav.querySelectorAll(".wl-dive").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeepDive(btn.dataset.dive);
    });
  });

  // Click ✕ → remove
  nav.querySelectorAll(".wl-remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromWatchlist(btn.dataset.remove);
    });
  });
}

function addToWatchlist(data) {
  if (!inWatchlist(data.symbol)) {
    watchlist.unshift({
      symbol:     data.symbol,
      name:       data.name       || data.symbol,
      price:      data.price      ?? null,
      change_pct: data.change_pct ?? null,
    });
    saveWatchlist();
    renderSidebar();
  }
  updateBookmarkIcon();
}

function removeFromWatchlist(symbol) {
  watchlist = watchlist.filter(w => w.symbol !== symbol);
  saveWatchlist();
  renderSidebar();
  updateBookmarkIcon();
}

function toggleWatchlist(symbol) {
  if (inWatchlist(symbol)) {
    removeFromWatchlist(symbol);
  } else {
    const data = (currentResult && currentResult.symbol === symbol)
      ? currentResult
      : { symbol, name: symbol, price: null, change_pct: null };
    addToWatchlist(data);
  }
}

function updateBookmarkIcon() {
  const btn = document.getElementById("bookmarkBtn");
  if (!btn || !activeSymbol) return;
  const inList = inWatchlist(activeSymbol);
  btn.textContent = inList ? "★" : "☆";
  btn.title       = inList ? "Remove from watchlist" : "Add to watchlist";
  btn.classList.toggle("bookmarked", inList);
}

async function refreshWatchlistPrices() {
  if (!watchlist.length) return;
  const btn = document.getElementById("watchlistRefreshBtn");
  if (btn) btn.classList.add("spinning");

  await Promise.all(watchlist.map(async item => {
    try {
      const res = await fetch(`/api/analyze?symbol=${encodeURIComponent(item.symbol)}`);
      if (res.ok) {
        const d = await res.json();
        item.price      = d.price      ?? item.price;
        item.change_pct = d.change_pct ?? item.change_pct;
        item.name       = d.name       || item.name;
      }
    } catch (_) { /* keep existing values */ }
  }));

  saveWatchlist();
  renderSidebar();
  updateBookmarkIcon();
  if (btn) btn.classList.remove("spinning");
}

// ---------------------------------------------------------------------------
// Analyze / result rendering
// ---------------------------------------------------------------------------
function showError(msg) {
  const banner = document.getElementById("errorBanner");
  banner.textContent = `⚠ ${msg}`;
  banner.style.display = "block";
}

function clearError() {
  const banner = document.getElementById("errorBanner");
  banner.style.display = "none";
  banner.textContent   = "";
}

function setLoading(on) {
  document.getElementById("loadingIndicator").style.display = on ? "block" : "none";
  document.getElementById("searchBtn").disabled = on;
}

function fmt(val, type) {
  if (val == null) return "—";
  if (type === "pct")   return (val * 100).toFixed(2) + "%";
  if (type === "float") return Number(val).toFixed(2);
  if (type === "price") return Number(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return val;
}

function renderResult(data) {
  currentResult = data;

  document.getElementById("placeholderPanel").style.display = "none";
  document.getElementById("resultPanel").style.display      = "block";

  document.getElementById("resSymbol").textContent  = data.symbol || "—";
  document.getElementById("resName").textContent    = data.name   || "—";
  document.getElementById("resPrice").textContent   = fmt(data.price,    "price");
  document.getElementById("resBeta").textContent    = fmt(data.beta,     "float");
  document.getElementById("resWacc").textContent    = fmt(data.wacc,     "pct");
  document.getElementById("resDe").textContent      = fmt(data.de_ratio, "float");
  document.getElementById("resSummary").textContent = data.summary || "—";

  // Show action buttons
  document.getElementById("bookmarkBtn").style.display  = "flex";
  document.getElementById("deepDiveBtn").style.display  = "inline-flex";

  // Show NPV panel
  document.getElementById("npvPanel").style.display = "block";

  // Pre-fill WACC into NPV discount rate field
  const waccInput = document.getElementById("npvDiscountRate");
  if (waccInput) {
    const newRate = data.wacc != null ? (data.wacc * 100).toFixed(2) : "";
    // Only pre-fill if blank or it came from the last WACC — don't overwrite user edits
    if (!waccInput.dataset.userEdited) {
      waccInput.value = newRate;
    }
  }
  // Hide stale results when a new stock loads
  document.getElementById("npvResults").style.display   = "none";
  document.getElementById("npvDirtyHint").style.display = "none";

  // Reset all NPV state for the new symbol
  npvOverride.revenue = false;
  npvOverride.costs   = false;
  npvOverride.growth  = false;
  currentFinancials   = null;

  // Clear previous source labels and fields
  npvClearSources();
  ["npvAnnualRevenue","npvAnnualCosts","npvGrowthRate"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ""; el.classList.remove("npv-input--auto","npv-input--custom"); }
  });
  ["npvRevenueBadge","npvCostsBadge","npvGrowthBadge"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  ["npvRevenueHint","npvCostsHint","npvGrowthHint"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });

  // Fetch real financials and pre-fill NPV fields
  fetchAndFillFinancials(data.symbol, data.wacc);

  // Refresh watchlist entry if already bookmarked
  if (inWatchlist(data.symbol)) {
    const entry = watchlist.find(w => w.symbol === data.symbol);
    if (entry) {
      entry.price      = data.price      ?? entry.price;
      entry.change_pct = data.change_pct ?? entry.change_pct;
      entry.name       = data.name       || entry.name;
      saveWatchlist();
      renderSidebar();
    }
  }

  updateBookmarkIcon();
}

async function analyzeSymbol(symbol) {
  symbol = symbol.trim().toUpperCase();
  if (!symbol) return;

  clearError();
  setLoading(true);
  document.getElementById("resultPanel").style.display      = "none";
  document.getElementById("placeholderPanel").style.display = "none";

  activeSymbol = symbol;
  saveLastSymbol(symbol);
  renderSidebar();
  updateSP500ActiveRow();

  document.getElementById("tickerInput").value = symbol;

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 60_000);

  try {
    const res  = await fetch(`/api/analyze?symbol=${encodeURIComponent(symbol)}`,
                             { signal: controller.signal });
    const data = await res.json();

    console.log(`[analyze] ${symbol} →`, data);

    if (!res.ok) {
      showError(`SYMBOL NOT FOUND — ${data.error || "please check the ticker and try again."}`);
      document.getElementById("placeholderPanel").style.display = "flex";
    } else {
      renderResult(data);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      showError("REQUEST TIMED OUT — please try again.");
    } else {
      showError("NETWORK ERROR — could not reach the server.");
    }
    document.getElementById("placeholderPanel").style.display = "flex";
  } finally {
    clearTimeout(timeout);
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------
let acItems = [];
let acIndex = -1;
let acTimer = null;

async function fetchAutocomplete(q) {
  if (!q) { closeAutocomplete(); return; }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    acItems   = res.ok ? (await res.json()) : [];
  } catch (_) {
    acItems = [];
  }
  acIndex = -1;
  renderAutocomplete();
}

function renderAutocomplete() {
  const dd = document.getElementById("autocompleteDropdown");
  if (!acItems.length) { closeAutocomplete(); return; }

  dd.innerHTML = acItems.map((item, i) =>
    `<div class="ac-item${i === acIndex ? " ac-selected" : ""}" data-index="${i}">
       <span class="ac-symbol">${item.symbol}</span>
       <span class="ac-name">${item.name}</span>
     </div>`
  ).join("");
  dd.style.display = "block";

  dd.querySelectorAll(".ac-item").forEach(el => {
    el.addEventListener("mousedown", e => {
      e.preventDefault();
      selectAcItem(+el.dataset.index);
    });
  });
}

function closeAutocomplete() {
  const dd = document.getElementById("autocompleteDropdown");
  if (dd) { dd.style.display = "none"; dd.innerHTML = ""; }
  acItems = []; acIndex = -1;
}

function selectAcItem(idx) {
  if (idx < 0 || idx >= acItems.length) return;
  const sym = acItems[idx].symbol;
  document.getElementById("tickerInput").value = sym;
  closeAutocomplete();
  analyzeSymbol(sym);
}

function navigateAc(dir) {
  if (!acItems.length) return;
  acIndex = Math.max(-1, Math.min(acItems.length - 1, acIndex + dir));
  if (acIndex >= 0)
    document.getElementById("tickerInput").value = acItems[acIndex].symbol;
  renderAutocomplete();
}

// ---------------------------------------------------------------------------
// S&P 500 right panel — slim scrolling ticker
// ---------------------------------------------------------------------------
let sp500Data    = [];
let _tickerRaf   = null;
let _tickerPaused = false;

function buildTickerRows(items) {
  return items.map(s => {
    const chg    = s.change_pct;
    const cls    = chg == null ? "flat" : chg > 0 ? "up" : "down";
    const arrow  = chg == null ? "" : chg > 0 ? "▲" : "▼";
    const chgStr = chg == null ? "—" : `${arrow}${Math.abs(chg).toFixed(2)}%`;
    const prStr  = s.price == null ? "—"
      : Number(s.price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const isActive = s.symbol === activeSymbol;
    return `<li class="sp500-row${isActive ? " active" : ""}" data-ticker="${s.symbol}">
      <span class="sp-sym">${s.symbol}</span>
      <span class="sp-price">${prStr}</span>
      <span class="sp-chg ${cls}">${chgStr}</span>
      <button class="sp-dive" data-dive="${s.symbol}" title="Deep Dive">↗ DIVE</button>
    </li>`;
  }).join("");
}

function renderSP500List() {
  const list    = document.getElementById("sp500List");
  const wrap    = document.getElementById("sp500ListWrap");
  const loading = document.getElementById("sp500Loading");
  if (!sp500Data.length) return;

  loading.style.display = "none";
  list.style.display    = "block";
  list.innerHTML = buildTickerRows(sp500Data);

  // Row click → analyze
  list.querySelectorAll(".sp500-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".sp-dive")) return;
      analyzeSymbol(row.dataset.ticker);
    });
  });

  // Dive button click → Deep Dive modal
  list.querySelectorAll(".sp-dive").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeepDive(btn.dataset.dive);
    });
  });

  // Wire pause/resume once
  if (!wrap.dataset.scrollInit) {
    wrap.dataset.scrollInit = "1";
    wrap.addEventListener("mouseenter", () => { _tickerPaused = true;  }, { passive: true });
    wrap.addEventListener("mouseleave", () => { _tickerPaused = false; }, { passive: true });
  }

  startTickerScroll(wrap);
}

function startTickerScroll(wrap) {
  if (_tickerRaf) cancelAnimationFrame(_tickerRaf);
  const SPEED = 0.5;
  function step() {
    if (!_tickerPaused) {
      wrap.scrollTop += SPEED;
      if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 1) {
        wrap.scrollTop = 0;
      }
    }
    _tickerRaf = requestAnimationFrame(step);
  }
  _tickerRaf = requestAnimationFrame(step);
}

function updateSP500ActiveRow() {
  document.querySelectorAll(".sp500-row").forEach(row => {
    row.classList.toggle("active", row.dataset.ticker === activeSymbol);
  });
}

async function fetchSP500(force = false) {
  const refreshBtn = document.getElementById("sp500RefreshBtn");
  if (refreshBtn) refreshBtn.classList.add("spinning");

  try {
    const url  = force ? "/api/sp500?bust=" + Date.now() : "/api/sp500";
    const res  = await fetch(url);
    const data = await res.json();

    if (!res.ok || data.error) {
      console.warn("S&P 500 fetch error:", data.error);
      document.getElementById("sp500Loading").textContent = "DATA UNAVAILABLE";
      return;
    }

    sp500Data = data.stocks || [];

    if (!sp500Data.length) {
      document.getElementById("sp500Loading").textContent =
        data.warning ? "PRICES LOADING..." : "NO DATA";
      return;
    }

    renderSP500List();
  } catch (err) {
    console.warn("S&P 500 network error:", err);
  } finally {
    if (refreshBtn) refreshBtn.classList.remove("spinning");
  }
}

// ---------------------------------------------------------------------------
// Deep Dive Modal
// ---------------------------------------------------------------------------
function openDeepDive(symbol) {
  _ddSymbol = symbol;
  _ddPeriod = "1mo";
  _ddPrices = null;

  // Use cached data if this symbol was the last analyzed
  const data = (currentResult && currentResult.symbol === symbol) ? currentResult : null;

  // Header
  document.getElementById("ddSymbol").textContent = symbol;
  document.getElementById("ddName").textContent   = data?.name || "—";

  const price = data?.price ?? null;
  document.getElementById("ddPrice").textContent  = price != null ? formatPrice(price) : "—";

  const chg   = data?.change_pct ?? null;
  const ddChg = document.getElementById("ddChg");
  ddChg.textContent = chg != null ? formatPct(chg) : "—";
  ddChg.className   = "dd-chg " + (chg == null ? "flat" : chg > 0 ? "up" : "down");

  // Ratios (instant, from cached result)
  document.getElementById("ddRatioBeta").textContent = fmt(data?.beta,     "float");
  document.getElementById("ddRatioWacc").textContent = fmt(data?.wacc,     "pct");
  document.getElementById("ddRatioDe").textContent   = fmt(data?.de_ratio, "float");

  // Reset chart area
  const chartMsg = document.getElementById("ddChartMsg");
  chartMsg.style.display = "flex";
  chartMsg.innerHTML     = "FETCHING CHART<span class='dots'>...</span>";
  document.getElementById("ddStatRow").style.visibility = "hidden";

  // Reset period buttons
  document.querySelectorAll(".dd-period-btn").forEach(b => {
    b.classList.toggle("dd-period-active", b.dataset.period === "1mo");
  });

  // Reset news
  document.getElementById("ddNewsList").innerHTML =
    "<div class='dd-chart-msg'>FETCHING NEWS<span class='dots'>...</span></div>";

  // Show overlay
  document.getElementById("ddOverlay").classList.add("dd-open");
  document.body.style.overflow = "hidden";

  // Fetch in parallel
  fetchAndDrawChart(symbol, "1mo");
  fetchAndRenderNews(symbol);
}

function closeDeepDive() {
  document.getElementById("ddOverlay").classList.remove("dd-open");
  document.body.style.overflow = "";
  _ddSymbol = null;
  _ddPrices = null;
}

async function fetchAndDrawChart(symbol, period) {
  _ddPeriod = period;
  const chartMsg = document.getElementById("ddChartMsg");
  try {
    const res  = await fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}&period=${period}`);
    const data = await res.json();

    if (!res.ok || data.error || !data.prices?.length) {
      if (chartMsg) chartMsg.textContent = "CHART DATA UNAVAILABLE";
      return;
    }

    _ddPrices = data.prices;
    if (chartMsg) chartMsg.style.display = "none";

    const canvas = document.getElementById("ddCanvas");
    ddDrawChart(canvas, data.prices, null);

    // Hover crosshair
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      ddDrawChart(canvas, data.prices, e.clientX - rect.left);
    };
    canvas.onmouseleave = () => ddDrawChart(canvas, data.prices, null);

    // Stat chips
    const statRow = document.getElementById("ddStatRow");
    if (statRow) statRow.style.visibility = "visible";

    const chgPct = data.period_change_pct;
    const chgEl  = document.getElementById("ddPeriodChg");
    if (chgEl) {
      chgEl.textContent = chgPct != null ? formatPct(chgPct) : "—";
      chgEl.className   = "dd-stat-value" + (chgPct > 0 ? " up" : chgPct < 0 ? " down" : "");
    }

    const highEl = document.getElementById("ddPeriodHigh");
    const lowEl  = document.getElementById("ddPeriodLow");
    if (highEl) highEl.textContent = data.period_high != null ? `$${formatPrice(data.period_high)}` : "—";
    if (lowEl)  lowEl.textContent  = data.period_low  != null ? `$${formatPrice(data.period_low)}`  : "—";

  } catch (err) {
    if (chartMsg) chartMsg.textContent = "CHART DATA UNAVAILABLE";
  }
}

function ddDrawChart(canvas, prices, hoverX) {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth  || 840;
  const cssH = canvas.offsetHeight || 220;

  // Resize backing store to match DPR
  if (canvas.width  !== Math.round(cssW * dpr) ||
      canvas.height !== Math.round(cssH * dpr)) {
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.scale(dpr, dpr);

  const W   = cssW;
  const H   = cssH;
  const PAD = { top: 16, right: 16, bottom: 36, left: 72 };
  const cW  = W - PAD.left - PAD.right;
  const cH  = H - PAD.top  - PAD.bottom;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, W, H);

  if (!prices || prices.length < 2) { ctx.restore(); return; }

  const closes = prices.map(p => p.close);
  const rawMin = Math.min(...closes);
  const rawMax = Math.max(...closes);
  const spread = (rawMax - rawMin) || 1;
  const yMin   = rawMin - spread * 0.05;
  const yMax   = rawMax + spread * 0.05;
  const yRange = yMax - yMin;

  const xOf = i => PAD.left + (i / (prices.length - 1)) * cW;
  const yOf = p => PAD.top  + (1 - (p - yMin) / yRange) * cH;

  // Grid lines + Y labels
  const MONO = `10px "SF Mono","Fira Code","Consolas",monospace`;
  for (let i = 0; i <= 5; i++) {
    const y = PAD.top + (i / 5) * cH;
    ctx.strokeStyle = "#1e2330"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    const val = yMax - (i / 5) * yRange;
    ctx.fillStyle = "#4a5260"; ctx.font = MONO; ctx.textAlign = "right";
    ctx.fillText(`$${val.toFixed(2)}`, PAD.left - 6, y + 4);
  }

  // X-axis labels
  const xCount = Math.min(6, prices.length);
  ctx.fillStyle = "#4a5260"; ctx.textAlign = "center"; ctx.font = MONO;
  for (let i = 0; i < xCount; i++) {
    const idx   = Math.round((i / (xCount - 1)) * (prices.length - 1));
    const parts = prices[idx].date.split("-");
    ctx.fillText(`${parts[1]}/${parts[2]}`, xOf(idx), H - PAD.bottom + 14);
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
  grad.addColorStop(0, "rgba(255,159,26,0.22)");
  grad.addColorStop(1, "rgba(255,159,26,0.0)");
  ctx.beginPath();
  prices.forEach((p, i) => { const x = xOf(i), y = yOf(p.close); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.lineTo(xOf(prices.length - 1), PAD.top + cH);
  ctx.lineTo(xOf(0), PAD.top + cH);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  // Price line
  ctx.beginPath(); ctx.strokeStyle = "#ff9f1a"; ctx.lineWidth = 1.5; ctx.lineJoin = "round";
  prices.forEach((p, i) => { const x = xOf(i), y = yOf(p.close); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();

  // Crosshair
  if (hoverX !== null && hoverX >= PAD.left && hoverX <= W - PAD.right) {
    const rawIdx = (hoverX - PAD.left) / cW * (prices.length - 1);
    const idx    = Math.max(0, Math.min(prices.length - 1, Math.round(rawIdx)));
    const p      = prices[idx];
    const x      = xOf(idx);
    const y      = yOf(p.close);

    // Vertical dotted line
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(255,159,26,0.45)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + cH); ctx.stroke();
    ctx.restore();

    // Dot on line
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ff9f1a"; ctx.fill();
    ctx.strokeStyle = "#05060a"; ctx.lineWidth = 1.5; ctx.stroke();

    // Tooltip box
    const parts = p.date.split("-");
    const label = `${parts[1]}/${parts[2]}  $${p.close.toFixed(2)}`;
    ctx.font = `11px "SF Mono","Fira Code",monospace`;
    const tw  = ctx.measureText(label).width;
    const tPad = 8, tW = tw + tPad * 2, tH = 22;
    let tx = Math.max(PAD.left, Math.min(W - PAD.right - tW, x - tW / 2));
    const ty = Math.max(4, PAD.top - tH - 4);
    ctx.fillStyle = "#1e2330"; ctx.fillRect(tx, ty, tW, tH);
    ctx.strokeStyle = "#2a2f3a"; ctx.lineWidth = 1; ctx.strokeRect(tx, ty, tW, tH);
    ctx.fillStyle = "#f3f4f6"; ctx.textAlign = "left";
    ctx.fillText(label, tx + tPad, ty + 15);
  }

  ctx.restore();
}

async function fetchAndRenderNews(symbol) {
  const list = document.getElementById("ddNewsList");
  try {
    const res  = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    const news = res.ok ? await res.json() : [];

    if (!news.length) {
      list.innerHTML = "<div class='dd-news-empty'>NO RECENT NEWS AVAILABLE</div>";
      return;
    }

    list.innerHTML = news.map(item => `
      <a class="dd-news-card" href="${escHtml(item.link)}" target="_blank" rel="noopener noreferrer">
        <div class="dd-news-body">
          <div class="dd-news-title">${escHtml(item.title)}</div>
          <div class="dd-news-meta">
            <span class="dd-news-pub">${escHtml(item.publisher)}</span>
            ${item.publisher && item.published ? " · " : ""}${escHtml(item.published || "")}
          </div>
        </div>
        <span class="dd-news-arrow">→</span>
      </a>`).join("");
  } catch (_) {
    list.innerHTML = "<div class='dd-news-empty'>COULD NOT LOAD NEWS</div>";
  }
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// NPV Calculator
// ---------------------------------------------------------------------------
function npvMarkDirty() {
  const hint = document.getElementById("npvDirtyHint");
  const res  = document.getElementById("npvResults");
  if (hint) hint.style.display = "block";
  if (res)  res.style.display  = "none";
}

function _npvFmt(val) {
  // Format dollar value with sign, commas, 2dp
  if (val == null) return "—";
  const abs = Math.abs(val);
  const str = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (val < 0 ? "-$" : "+$") + str;
}

function _dollarFmt(val) {
  if (val == null) return "—";
  return "$" + Math.abs(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// NPV smart-fill helpers
// ---------------------------------------------------------------------------
function fmtFinancialShort(val) {
  if (val == null) return "";
  const abs = Math.abs(val);
  if (abs >= 1e9) return "$" + (val / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return "$" + (val / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return "$" + Math.round(val).toLocaleString("en-US");
  return "$" + Math.round(val);
}

function npvSetSource(sourceId, text) {
  const el = document.getElementById(sourceId);
  if (!el) return;
  if (text) { el.textContent = "Source: " + text; el.style.display = ""; }
  else       { el.style.display = "none"; el.textContent = ""; }
}

function npvClearSources() {
  ["npvRevenueSource","npvCostsSource","npvGrowthSource","npvRateSource"].forEach(id => npvSetSource(id, ""));
}

// ---------------------------------------------------------------------------
// NPV auto-fill state
// ---------------------------------------------------------------------------
let currentFinancials = null;   // real yfinance data for current symbol
let _currentWacc      = null;   // WACC for current symbol
const npvOverride = { revenue: false, costs: false, growth: false };
let   _npvAutoTimer = null;

function npvSetAutoState(fieldId, badgeId, hintId, isAuto) {
  const input = document.getElementById(fieldId);
  const badge = document.getElementById(badgeId);
  const hint  = document.getElementById(hintId);
  if (!input || !badge || !hint) return;
  if (isAuto) {
    input.classList.add("npv-input--auto");
    input.classList.remove("npv-input--custom");
    badge.textContent   = "AUTO";
    badge.className     = "npv-auto-badge npv-auto-badge--auto";
    badge.style.display = "";
    hint.style.display  = "";
  } else {
    input.classList.remove("npv-input--auto");
    input.classList.add("npv-input--custom");
    badge.textContent   = "CUSTOM";
    badge.className     = "npv-auto-badge npv-auto-badge--custom";
    badge.style.display = "";
    hint.style.display  = "none";
  }
}

function npvSetLoadingMsg(text, color) {
  const el = document.getElementById("npvDataLoading");
  if (!el) return;
  el.textContent   = text;
  el.style.color   = color || "";
  el.style.display = text ? "" : "none";
}

// ---------------------------------------------------------------------------
// applyFinancials — write currentFinancials into the NPV input fields
// ---------------------------------------------------------------------------
function applyFinancials() {
  if (!currentFinancials) return;
  const fin   = currentFinancials;
  const yr    = fin.data_year ? `FY${fin.data_year}` : "latest";
  const notes = fin.source_notes || {};

  if (fin.annual_revenue != null && !npvOverride.revenue) {
    document.getElementById("npvAnnualRevenue").value = Math.round(fin.annual_revenue);
    npvSetAutoState("npvAnnualRevenue","npvRevenueBadge","npvRevenueHint", true);
    npvSetSource("npvRevenueSource",
      `${notes.revenue || "Annual income statement"} — ${fmtFinancialShort(fin.annual_revenue)} (${yr})`);
    console.log("[NPV PREFILL] Revenue:", fin.annual_revenue);
  }
  if (fin.annual_costs != null && !npvOverride.costs) {
    document.getElementById("npvAnnualCosts").value = Math.round(fin.annual_costs);
    npvSetAutoState("npvAnnualCosts","npvCostsBadge","npvCostsHint", true);
    npvSetSource("npvCostsSource",
      `${notes.costs || "Annual income statement"} — ${fmtFinancialShort(fin.annual_costs)} (${yr})`);
    console.log("[NPV PREFILL] Costs:", fin.annual_costs);
  }
  if (fin.growth_rate != null && !npvOverride.growth) {
    document.getElementById("npvGrowthRate").value = (fin.growth_rate * 100).toFixed(1);
    npvSetAutoState("npvGrowthRate","npvGrowthBadge","npvGrowthHint", true);
    npvSetSource("npvGrowthSource",
      `${notes.growth || "2-year revenue comparison"} — ${(fin.growth_rate * 100).toFixed(1)}%`);
    console.log("[NPV PREFILL] Growth:", fin.growth_rate);
  }
  if (_currentWacc != null) {
    const rateEl = document.getElementById("npvDiscountRate");
    if (rateEl && !rateEl.dataset.userEdited) {
      rateEl.value = (_currentWacc * 100).toFixed(2);
      npvSetSource("npvRateSource", `Calculated WACC — ${(_currentWacc * 100).toFixed(2)}%`);
    }
  }
  npvMarkDirty();
}

// ---------------------------------------------------------------------------
// Fetch real financials from yfinance and pre-fill NPV fields
// ---------------------------------------------------------------------------
async function fetchAndFillFinancials(symbol, wacc) {
  currentFinancials = null;
  _currentWacc      = wacc;

  const unavailable = document.getElementById("npvUnavailable");
  if (unavailable) unavailable.style.display = "none";
  npvClearSources();
  npvSetLoadingMsg(`↻ LOADING FINANCIAL DATA FOR ${symbol}…`, "var(--accent)");

  try {
    const res  = await fetch(`/api/financials?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    console.log("[FINANCIALS] Loaded for", symbol, data);

    const hasData = data.annual_revenue != null || data.annual_costs != null;

    if (!hasData) {
      npvSetLoadingMsg("FINANCIAL DATA UNAVAILABLE — ENTER VALUES MANUALLY", "var(--text-dim)");
      if (unavailable) unavailable.style.display = "";
      return;
    }

    currentFinancials = data;
    npvSetLoadingMsg("✓ FINANCIAL DATA LOADED — ENTER INVESTMENT TO BEGIN", "#22c55e");
    setTimeout(() => npvSetLoadingMsg(""), 4000);

    // Apply immediately (don't wait for initial investment input)
    applyFinancials();

  } catch (err) {
    console.error("[FINANCIALS] Failed to load:", err);
    npvSetLoadingMsg("FINANCIAL DATA UNAVAILABLE — ENTER VALUES MANUALLY", "var(--text-dim)");
    if (unavailable) unavailable.style.display = "";
  }
}

// ---------------------------------------------------------------------------
// npvAutoFill — triggered when user types Initial Investment
// Uses real financials if loaded, falls back to estimates only if not
// ---------------------------------------------------------------------------
function npvAutoFill() {
  const initial = parseFloat(document.getElementById("npvInitial").value);
  if (isNaN(initial) || initial <= 0) return;

  if (currentFinancials) {
    // Real data is loaded — just apply it (don't overwrite with estimates)
    applyFinancials();
    return;
  }

  // No real data — fall back to percentage estimates
  console.log("[NPV PREFILL] No financials loaded, using estimates");
  if (!npvOverride.revenue) {
    document.getElementById("npvAnnualRevenue").value = Math.round(initial * 0.20);
    npvSetAutoState("npvAnnualRevenue","npvRevenueBadge","npvRevenueHint", true);
    npvSetSource("npvRevenueSource", "Estimated — 20% of initial investment");
  }
  if (!npvOverride.costs) {
    document.getElementById("npvAnnualCosts").value = Math.round(initial * 0.08);
    npvSetAutoState("npvAnnualCosts","npvCostsBadge","npvCostsHint", true);
    npvSetSource("npvCostsSource", "Estimated — 8% of initial investment");
  }
  if (!npvOverride.growth) {
    document.getElementById("npvGrowthRate").value = 5;
    npvSetAutoState("npvGrowthRate","npvGrowthBadge","npvGrowthHint", true);
    npvSetSource("npvGrowthSource", "Default conservative growth assumption");
  }
}

function npvWireAutoFill() {
  // Trigger auto-fill with 500ms debounce on initial investment input
  document.getElementById("npvInitial").addEventListener("input", () => {
    clearTimeout(_npvAutoTimer);
    _npvAutoTimer = setTimeout(npvAutoFill, 500);
  });

  // Mark a field as manually overridden when user edits it directly
  [
    ["npvAnnualRevenue", "revenue", "npvRevenueBadge", "npvRevenueHint"],
    ["npvAnnualCosts",   "costs",   "npvCostsBadge",   "npvCostsHint"],
    ["npvGrowthRate",    "growth",  "npvGrowthBadge",  "npvGrowthHint"],
  ].forEach(([id, key, badgeId, hintId]) => {
    document.getElementById(id).addEventListener("input", () => {
      npvOverride[key] = true;
      npvSetAutoState(id, badgeId, hintId, false);
    });
  });
}

async function calculateNpv() {
  const initialRaw  = document.getElementById("npvInitial").value.trim();
  const revenueRaw  = document.getElementById("npvAnnualRevenue").value.trim();
  const costsRaw    = document.getElementById("npvAnnualCosts").value.trim();
  const lifespan    = parseInt(document.getElementById("npvLifespan").value, 10);
  const growthRaw   = document.getElementById("npvGrowthRate").value.trim();
  const rateRaw     = document.getElementById("npvDiscountRate").value.trim();

  if (!initialRaw || !revenueRaw || !costsRaw || !rateRaw) {
    alert("Please fill in all fields before calculating.");
    return;
  }

  const initial    = parseFloat(initialRaw);
  const revenue    = parseFloat(revenueRaw);
  const costs      = parseFloat(costsRaw);
  const growthRate = parseFloat(growthRaw || "0") / 100;
  const rate       = parseFloat(rateRaw) / 100;

  if (isNaN(initial) || initial <= 0)               { alert("Initial investment must be a positive number."); return; }
  if (isNaN(revenue) || revenue < 0)                { alert("Annual revenue must be a non-negative number."); return; }
  if (isNaN(costs)   || costs < 0)                  { alert("Annual costs must be a non-negative number."); return; }
  if (isNaN(rate) || rate <= 0 || rate >= 1)        { alert("Discount rate must be between 0.01% and 99.99%."); return; }
  if (isNaN(growthRate) || growthRate < -0.5)       { alert("Growth rate must be greater than -50%."); return; }

  const btn = document.getElementById("npvCalcBtn");
  btn.textContent = "CALCULATING...";
  btn.disabled    = true;

  try {
    const res  = await fetch("/api/npv", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        initial_investment: initial,
        annual_revenue:     revenue,
        annual_costs:       costs,
        growth_rate:        growthRate,
        lifespan:           lifespan,
        discount_rate:      rate,
      }),
    });
    const data = await res.json();

    if (!res.ok) { alert(`Calculation error: ${data.error}`); return; }

    renderNpvResults(data);

    document.getElementById("npvDirtyHint").style.display = "none";
    document.getElementById("npvResults").style.display   = "block";
  } catch (err) {
    alert("Could not reach the server. Please try again.");
  } finally {
    btn.textContent = "CALCULATE NPV";
    btn.disabled    = false;
  }
}

function renderNpvResults(data) {
  const npv      = data.npv;
  const pi       = data.profitability_index;
  const payback  = data.payback_year;
  const dcfs     = data.discounted_cash_flows || [];
  const cumul    = data.cumulative_cash_flows  || [];
  const sens     = data.sensitivity            || [];
  const inputs   = data.inputs                 || {};

  // ── Summary cards ──
  const valEl = document.getElementById("npvValueDisplay");
  valEl.textContent = _npvFmt(npv);
  valEl.className   = "npv-card-value " + (npv > 0 ? "up" : npv < 0 ? "down" : "");

  const piEl = document.getElementById("npvPiDisplay");
  piEl.textContent = pi != null ? Number(pi).toFixed(4) : "—";
  piEl.className   = "npv-card-value " + (pi > 1 ? "up" : pi < 1 ? "down" : "");

  const pbEl = document.getElementById("npvPaybackDisplay");
  pbEl.textContent = payback != null ? `Year ${payback}` : "Not Achieved";
  pbEl.className   = "npv-card-value" + (payback != null ? " up" : " down");

  // ── Verdict ──
  const verdict = document.getElementById("npvVerdict");
  if (npv > 0) {
    verdict.textContent = "▲  PROJECT ACCEPTED — POSITIVE VALUE CREATED";
    verdict.className   = "npv-verdict accept";
  } else if (npv < 0) {
    verdict.textContent = "▼  PROJECT REJECTED — VALUE DESTRUCTIVE";
    verdict.className   = "npv-verdict reject";
  } else {
    verdict.textContent = "◆  BREAKEVEN — NO VALUE CREATED OR DESTROYED";
    verdict.className   = "npv-verdict neutral";
  }

  // ── DCF Table ──
  const tbody = document.getElementById("npvTableBody");
  const rate  = inputs.discount_rate      || 0;
  const cfs   = data.cash_flows           || [];
  const init  = inputs.initial_investment || 0;

  // Year 0 row (initial investment)
  let rows = `<tr>
    <td>Year 0</td>
    <td class="npv-auto-cf">—</td>
    <td>1.0000</td>
    <td class="cum-negative">${_dollarFmt(-init)}</td>
    <td class="cum-negative">${_npvFmt(-init)}</td>
  </tr>`;

  cfs.forEach((cf, i) => {
    const t       = i + 1;
    const factor  = 1 / Math.pow(1 + rate, t);
    const dcf     = dcfs[i] ?? 0;
    const cum     = cumul[i] ?? 0;
    const cumCls  = cum >= 0 ? "cum-positive" : "cum-negative";
    rows += `<tr>
      <td>Year ${t}</td>
      <td class="npv-auto-cf">${_dollarFmt(cf)}</td>
      <td>${factor.toFixed(4)}</td>
      <td>${_dollarFmt(dcf)}</td>
      <td class="${cumCls}">${_npvFmt(cum)}</td>
    </tr>`;
  });

  tbody.innerHTML = rows;

  // ── Sensitivity Table ──
  const sensBody = document.getElementById("npvSensBody");
  sensBody.innerHTML = sens.map(row => {
    const cls      = row.is_base ? "sens-base" : "";
    const verdict2 = row.npv > 0 ? `<span class="verdict-accept">ACCEPT</span>`
                   : row.npv < 0 ? `<span class="verdict-reject">REJECT</span>`
                   : "BREAKEVEN";
    return `<tr class="${cls}">
      <td>${row.rate.toFixed(2)}%${row.is_base ? " (base)" : ""}</td>
      <td>${_npvFmt(row.npv)}</td>
      <td>${verdict2}</td>
    </tr>`;
  }).join("");

  // ── Chart ──
  // Build cumulative series starting at Year 0 = -initial
  const chartPoints = [-init, ...cumul];
  drawNpvChart(document.getElementById("npvCanvas"), chartPoints, payback);
}

function drawNpvChart(canvas, points, paybackYear) {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth  || 800;
  const cssH = canvas.offsetHeight || 200;

  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.scale(dpr, dpr);

  const W   = cssW;
  const H   = cssH;
  const PAD = { top: 16, right: 20, bottom: 36, left: 90 };
  const cW  = W - PAD.left - PAD.right;
  const cH  = H - PAD.top  - PAD.bottom;

  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, W, H);

  if (!points || points.length < 2) { ctx.restore(); return; }

  const rawMin = Math.min(...points);
  const rawMax = Math.max(...points);
  const spread = (rawMax - rawMin) || 1;
  const yMin   = rawMin - spread * 0.08;
  const yMax   = rawMax + spread * 0.08;
  const yRange = yMax - yMin;
  const n      = points.length;

  const xOf = i => PAD.left + (i / (n - 1)) * cW;
  const yOf = v => PAD.top  + (1 - (v - yMin) / yRange) * cH;
  const y0  = yOf(0);   // y-coordinate of the breakeven line

  // Grid + Y labels
  const MONO = `10px "SF Mono","Fira Code","Consolas",monospace`;
  for (let i = 0; i <= 5; i++) {
    const y   = PAD.top + (i / 5) * cH;
    const val = yMax - (i / 5) * yRange;
    ctx.strokeStyle = "#1e2330"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    ctx.fillStyle = "#4a5260"; ctx.font = MONO; ctx.textAlign = "right";
    const label = val >= 0 ? `+$${(val/1000).toFixed(0)}k` : `-$${(Math.abs(val)/1000).toFixed(0)}k`;
    ctx.fillText(label, PAD.left - 6, y + 4);
  }

  // X-axis labels (Year 0, Year 1, …)
  ctx.fillStyle = "#4a5260"; ctx.textAlign = "center"; ctx.font = MONO;
  for (let i = 0; i < n; i++) {
    ctx.fillText(`Y${i}`, xOf(i), H - PAD.bottom + 14);
  }

  // Breakeven line (y=0)
  if (y0 >= PAD.top && y0 <= PAD.top + cH) {
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = "rgba(255,209,102,0.45)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y0); ctx.lineTo(W - PAD.right, y0); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "rgba(255,209,102,0.6)"; ctx.font = MONO; ctx.textAlign = "left";
    ctx.fillText("BREAKEVEN", PAD.left + 4, y0 - 4);
  }

  // Payback vertical marker
  if (paybackYear != null && paybackYear < n) {
    const xPb = xOf(paybackYear);
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(34,197,94,0.5)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xPb, PAD.top); ctx.lineTo(xPb, PAD.top + cH); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "rgba(34,197,94,0.7)"; ctx.font = MONO; ctx.textAlign = "center";
    ctx.fillText(`PAYBACK`, xPb, PAD.top + 10);
  }

  // Draw line segment-by-segment, red below zero → green above zero
  for (let i = 0; i < n - 1; i++) {
    const x1 = xOf(i),     y1 = yOf(points[i]);
    const x2 = xOf(i + 1), y2 = yOf(points[i + 1]);

    // Determine color by midpoint value
    const mid = (points[i] + points[i + 1]) / 2;
    ctx.strokeStyle = mid >= 0 ? "#22c55e" : "#ef4444";
    ctx.lineWidth   = 2;
    ctx.lineJoin    = "round";
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // Dots at each year
  for (let i = 0; i < n; i++) {
    const x = xOf(i), y = yOf(points[i]);
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = points[i] >= 0 ? "#22c55e" : "#ef4444";
    ctx.fill();
    ctx.strokeStyle = "#05060a"; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
function wireEvents() {
  const input  = document.getElementById("tickerInput");
  const btn    = document.getElementById("searchBtn");
  const bmkBtn = document.getElementById("bookmarkBtn");

  // Search button
  btn.addEventListener("click", () => {
    closeAutocomplete();
    analyzeSymbol(input.value);
  });

  // Typing → debounced autocomplete
  input.addEventListener("input", () => {
    clearTimeout(acTimer);
    acIndex = -1;
    const q = input.value.trim();
    if (!q) { closeAutocomplete(); return; }
    acTimer = setTimeout(() => fetchAutocomplete(q), 140);
  });

  // Keyboard navigation
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); navigateAc(+1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); navigateAc(-1); return; }
    if (e.key === "Escape")    { closeAutocomplete(); return; }
    if (e.key === "Enter") {
      if (acItems.length && acIndex >= 0) {
        e.preventDefault();
        selectAcItem(acIndex);
      } else {
        closeAutocomplete();
        analyzeSymbol(input.value);
      }
    }
  });

  input.addEventListener("blur", () => setTimeout(closeAutocomplete, 160));

  document.addEventListener("click", e => {
    if (!e.target.closest(".search-autocomplete-wrap")) closeAutocomplete();
  });

  // Bookmark
  bmkBtn.addEventListener("click", () => {
    if (activeSymbol) toggleWatchlist(activeSymbol);
  });

  // Deep Dive (main panel button)
  document.getElementById("deepDiveBtn").addEventListener("click", () => {
    if (activeSymbol) openDeepDive(activeSymbol);
  });

  // Placeholder hint tickers
  document.querySelectorAll(".hint-ticker").forEach(el => {
    el.addEventListener("click", () => analyzeSymbol(el.dataset.ticker));
  });

  // Sidebar refresh
  document.getElementById("watchlistRefreshBtn").addEventListener("click", refreshWatchlistPrices);

  // S&P 500 refresh
  document.getElementById("sp500RefreshBtn").addEventListener("click", () => fetchSP500(true));

  // ── Deep Dive modal controls ──
  document.getElementById("ddCloseBtn").addEventListener("click", closeDeepDive);

  // Click backdrop to close
  document.getElementById("ddOverlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("ddOverlay")) closeDeepDive();
  });

  // Period bar buttons
  document.getElementById("ddPeriodBar").addEventListener("click", (e) => {
    const pbtn = e.target.closest(".dd-period-btn");
    if (!pbtn || !_ddSymbol) return;
    document.querySelectorAll(".dd-period-btn").forEach(b => b.classList.remove("dd-period-active"));
    pbtn.classList.add("dd-period-active");
    const chartMsg = document.getElementById("ddChartMsg");
    chartMsg.style.display = "flex";
    chartMsg.innerHTML     = "FETCHING CHART<span class='dots'>...</span>";
    document.getElementById("ddStatRow").style.visibility = "hidden";
    fetchAndDrawChart(_ddSymbol, pbtn.dataset.period);
  });

  // Escape key
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeDeepDive();
  });

  // ── NPV Calculator ──
  document.getElementById("npvCalcBtn").addEventListener("click", calculateNpv);
  npvWireAutoFill();

  // Mark dirty when any input changes; track manual edits to discount rate
  ["npvInitial", "npvAnnualRevenue", "npvAnnualCosts", "npvGrowthRate", "npvLifespan"].forEach(id => {
    document.getElementById(id).addEventListener("input", npvMarkDirty);
    document.getElementById(id).addEventListener("change", npvMarkDirty);
  });
  const npvRateField = document.getElementById("npvDiscountRate");
  npvRateField.addEventListener("input", () => {
    npvRateField.dataset.userEdited = "1";
    npvMarkDirty();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  _emptyLi = document.getElementById("watchlistEmpty");
  loadWatchlist();
  renderSidebar();
  wireEvents();
  fetchIndices();

  setInterval(fetchIndices, 60_000);

  fetchSP500();
  setInterval(() => fetchSP500(true), 60_000);

  const last = loadLastSymbol();
  if (last) analyzeSymbol(last);
});

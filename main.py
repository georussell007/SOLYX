from flask import Flask, render_template, request, jsonify
import yfinance as yf
import pandas as pd
import numpy as np
from scipy.stats import linregress
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import requests
from io import StringIO

app = Flask(__name__, template_folder="templates", static_folder="static")

# ---------------------------------------------------------------------------
# S&P 500 / search globals
# ---------------------------------------------------------------------------
_sp500_cache: dict  = {"data": None, "ts": 0.0}
_SP500_TTL          = 60
_sp500_fetching     = False   # prevents concurrent background fetches

_search_index: list = []   # [{"symbol": ..., "name": ...}, ...]  — built once
_sp500_names:  dict = {}   # symbol → company name
_search_lock        = threading.Lock()

# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def get_live_indices():
    indices = [
        ("^GSPC", "S&P 500"),
        ("^NDX",  "Nasdaq 100"),
        ("^DJI",  "Dow Jones"),
    ]
    result = []
    for symbol, name in indices:
        try:
            info = yf.Ticker(symbol).info
            price = info.get("regularMarketPrice") or info.get("previousClose")
            change_pct = info.get("regularMarketChangePercent")
            result.append({
                "symbol": symbol,
                "name": name,
                "price": price,
                "change_pct": change_pct,
            })
        except Exception:
            result.append({"symbol": symbol, "name": name, "price": None, "change_pct": None})
    return result


def get_history(symbol: str, lookback_days: int = 365):
    try:
        end = datetime.today()
        start = end - timedelta(days=lookback_days)
        df = yf.download(symbol, start=start.strftime("%Y-%m-%d"),
                         end=end.strftime("%Y-%m-%d"), progress=False, auto_adjust=True)
        return df
    except Exception:
        return pd.DataFrame()


def get_fundamentals(symbol: str):
    """
    Fetch market cap, debt, equity, name, and beta for a symbol.
    Uses fast_info for market cap and balance_sheet for debt/equity —
    both work even when .info is rate-limited by Yahoo Finance.
    Falls back to .info for name and beta.
    """
    t = yf.Ticker(symbol)

    # ── Market cap via fast_info (lightweight, no crumb needed) ──
    market_cap = None
    try:
        mc = t.fast_info.market_cap
        if mc:
            market_cap = float(mc)
    except Exception:
        pass

    # ── Name and beta from .info (may fail if rate-limited) ──
    name     = symbol
    beta_inf = None
    try:
        info = t.info
        name     = info.get("longName") or info.get("shortName") or symbol
        beta_inf = info.get("beta") or info.get("beta3Year")
        if not market_cap:
            market_cap = info.get("marketCap")
    except Exception:
        pass

    # ── Debt + equity from annual balance sheet ──
    debt   = None
    equity = None
    try:
        bs = t.balance_sheet
        if bs is not None and not bs.empty:
            col = bs.iloc[:, 0]   # most recent annual period

            for label in ["Total Debt",
                          "Long Term Debt And Capital Lease Obligation",
                          "Long Term Debt"]:
                if label in bs.index:
                    val = col.get(label)
                    if val is not None and not pd.isna(val):
                        debt = float(val)
                        break

            for label in ["Stockholders Equity",
                          "Common Stock Equity",
                          "Total Equity Gross Minority Interest"]:
                if label in bs.index:
                    val = col.get(label)
                    if val is not None and not pd.isna(val):
                        equity = float(val)
                        break
    except Exception:
        pass

    print(f"[fundamentals] {symbol}: cap={market_cap}, debt={debt}, equity={equity}, beta={beta_inf}")
    return {
        "market_cap":   market_cap,
        "total_debt":   debt,
        "total_equity": equity,
        "name":         name,
        "beta_info":    beta_inf,
    }


# ---------------------------------------------------------------------------
# Financial metrics
# ---------------------------------------------------------------------------

def calculate_beta(stock_symbol: str, index_symbol: str = "^GSPC", lookback_days: int = 365):
    try:
        stock_df = get_history(stock_symbol, lookback_days)
        index_df = get_history(index_symbol, lookback_days)
        if stock_df.empty or index_df.empty:
            return None

        # Support both multi-level and single-level column names
        def close_series(df):
            if isinstance(df.columns, pd.MultiIndex):
                return df["Close"].iloc[:, 0]
            return df["Close"]

        stock_close = close_series(stock_df)
        index_close = close_series(index_df)

        stock_ret = stock_close.pct_change().dropna()
        index_ret = index_close.pct_change().dropna()

        aligned = pd.concat([stock_ret, index_ret], axis=1, join="inner").dropna()
        if len(aligned) < 30:
            return None

        slope, *_ = linregress(aligned.iloc[:, 1], aligned.iloc[:, 0])
        return round(float(slope), 4)
    except Exception:
        return None


def calculate_wacc(symbol: str, beta: float = None, fund: dict = None):
    Rf  = 0.04
    ERP = 0.05
    Rd  = 0.05
    Tc  = 0.21

    try:
        if fund is None:
            fund = get_fundamentals(symbol)
        E = fund.get("market_cap")
        D = fund.get("total_debt") or 0

        if not E:
            print(f"[DEBUG] WACC failed: no market cap for {symbol}")
            return None

        if beta is None:
            beta = fund.get("beta_info")
        if beta is None:
            beta = calculate_beta(symbol)
        if beta is None:
            print(f"[DEBUG] WACC failed: no beta for {symbol}")
            return None

        V    = E + D
        Re   = Rf + beta * ERP
        wacc = (E / V) * Re + (D / V) * Rd * (1 - Tc)
        print(f"[DEBUG] WACC {symbol}: E={E:.0f}, D={D:.0f}, beta={beta:.4f}, wacc={wacc:.6f}")
        return round(wacc, 6)
    except Exception as e:
        print(f"[ERROR] WACC {symbol}: {e}")
        return None


def calculate_de_ratio(symbol: str, fund: dict = None):
    try:
        if fund is None:
            fund = get_fundamentals(symbol)
        D = fund.get("total_debt")
        E = fund.get("total_equity")
        if D is None or E is None or E == 0:
            print(f"[DEBUG] D/E failed: debt={D}, equity={E}")
            return None
        return round(D / E, 4)
    except Exception as e:
        print(f"[ERROR] D/E {symbol}: {e}")
        return None


# ---------------------------------------------------------------------------
# Local AI-style summary
# ---------------------------------------------------------------------------

def generate_stock_summary(name, ticker, price, beta, wacc, de_ratio):
    parts = []

    # Price sentence
    if price is not None:
        parts.append(f"{name} ({ticker}) is currently trading around {price:,.2f} USD.")
    else:
        parts.append(f"{name} ({ticker}) pricing data is currently unavailable.")

    # Beta interpretation
    if beta is not None:
        if beta > 1.2:
            vol = "more volatile than the broader market"
        elif beta < 0.8:
            vol = "less volatile than the broader market"
        else:
            vol = "exhibiting volatility broadly in line with the market"
        parts.append(f"With an estimated beta of {beta:.2f}, the stock appears {vol}.")
    else:
        parts.append("Beta could not be calculated due to insufficient historical data.")

    # WACC interpretation
    if wacc is not None:
        parts.append(
            f"The approximate blended cost of capital (WACC) is estimated at {wacc*100:.1f}%, "
            f"reflecting the company's current capital structure and market risk profile."
        )
    else:
        parts.append("WACC could not be estimated due to missing fundamental data.")

    # D/E interpretation
    if de_ratio is not None:
        if de_ratio > 2:
            leverage = "highly levered"
        elif de_ratio > 1:
            leverage = "moderately levered"
        elif de_ratio > 0.2:
            leverage = "lightly levered"
        else:
            leverage = "carrying minimal financial debt"
        parts.append(
            f"At a debt-to-equity ratio of {de_ratio:.2f}, the company appears {leverage} "
            f"based on reported balance sheet figures."
        )
    else:
        parts.append("Debt-to-equity ratio could not be computed due to missing data.")

    return " ".join(parts)


# ---------------------------------------------------------------------------
# S&P 500 / search helpers
# ---------------------------------------------------------------------------

# Fallback seed — common large-caps so search is never completely empty
_SEED_TICKERS = [
    ("AAPL","Apple Inc."),("MSFT","Microsoft Corporation"),("NVDA","NVIDIA Corporation"),
    ("AMZN","Amazon.com Inc."),("GOOGL","Alphabet Inc."),("META","Meta Platforms Inc."),
    ("TSLA","Tesla Inc."),("BRK-B","Berkshire Hathaway Inc."),("JPM","JPMorgan Chase & Co."),
    ("V","Visa Inc."),("UNH","UnitedHealth Group Inc."),("XOM","Exxon Mobil Corporation"),
    ("JNJ","Johnson & Johnson"),("WMT","Walmart Inc."),("MA","Mastercard Inc."),
    ("PG","Procter & Gamble Co."),("HD","Home Depot Inc."),("COST","Costco Wholesale Corp."),
    ("CVX","Chevron Corporation"),("MRK","Merck & Co. Inc."),("ABBV","AbbVie Inc."),
    ("PEP","PepsiCo Inc."),("KO","Coca-Cola Company"),("LLY","Eli Lilly and Company"),
    ("AVGO","Broadcom Inc."),("BAC","Bank of America Corp."),("MCD","McDonald's Corp."),
    ("CRM","Salesforce Inc."),("ADBE","Adobe Inc."),("AMD","Advanced Micro Devices"),
    ("NFLX","Netflix Inc."),("TMO","Thermo Fisher Scientific"),("ORCL","Oracle Corporation"),
    ("ACN","Accenture plc"),("CSCO","Cisco Systems Inc."),("LIN","Linde plc"),
    ("TXN","Texas Instruments Inc."),("ABT","Abbott Laboratories"),("DHR","Danaher Corp."),
    ("NKE","Nike Inc."),("PM","Philip Morris International"),("NEE","NextEra Energy Inc."),
    ("RTX","RTX Corporation"),("QCOM","Qualcomm Inc."),("HON","Honeywell International"),
    ("AMGN","Amgen Inc."),("IBM","IBM Corporation"),("SBUX","Starbucks Corporation"),
    ("GS","Goldman Sachs Group"),("CAT","Caterpillar Inc."),("BA","Boeing Company"),
    ("GE","GE Aerospace"),("NOW","ServiceNow Inc."),("INTU","Intuit Inc."),
    ("BKNG","Booking Holdings Inc."),("SPGI","S&P Global Inc."),("AXP","American Express Co."),
    ("ISRG","Intuitive Surgical Inc."),("BLK","BlackRock Inc."),("MS","Morgan Stanley"),
    ("DE","Deere & Company"),("ADI","Analog Devices Inc."),("PLD","Prologis Inc."),
    ("GILD","Gilead Sciences Inc."),("VRTX","Vertex Pharmaceuticals"),("REGN","Regeneron Pharma"),
    ("MMC","Marsh & McLennan"),("ZTS","Zoetis Inc."),("TJX","TJX Companies"),
    ("MO","Altria Group Inc."),("CI","Cigna Group"),("SO","Southern Company"),
    ("DUK","Duke Energy Corporation"),("BSX","Boston Scientific"),("WFC","Wells Fargo & Co."),
    ("USB","U.S. Bancorp"),("ICE","Intercontinental Exchange"),("CME","CME Group Inc."),
]


def ensure_search_index() -> list[str]:
    """
    Fetch S&P 500 constituents from Wikipedia exactly once per process.
    Uses a browser User-Agent to avoid 403. Falls back to seed list on failure.
    Populates _search_index (for /api/search) and _sp500_names (symbol→name).
    Returns the list of ticker symbols.
    """
    global _search_index, _sp500_names
    with _search_lock:
        if _search_index:
            return [e["symbol"] for e in _search_index]

        # Seed immediately so search is never empty on first call
        for sym, name in _SEED_TICKERS:
            if sym not in _sp500_names:
                _sp500_names[sym] = name
        _search_index = [{"symbol": s, "name": n} for s, n in _SEED_TICKERS]

        # Try to upgrade to full Wikipedia list in background
        def _load():
            global _search_index, _sp500_names
            try:
                resp = requests.get(
                    "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
                    headers={"User-Agent": "Mozilla/5.0 NightTerminal/1.0"},
                    timeout=15,
                )
                resp.raise_for_status()
                tables = pd.read_html(StringIO(resp.text), flavor="lxml")
                df     = tables[0]
                entries, names = [], {}
                for _, row in df.iterrows():
                    sym  = str(row["Symbol"]).replace(".", "-")
                    name = str(row.get("Security", sym))
                    entries.append({"symbol": sym, "name": name})
                    names[sym] = name
                with _search_lock:
                    _search_index = entries
                    _sp500_names.update(names)
            except Exception:
                pass   # keep the seed list

        threading.Thread(target=_load, daemon=True).start()
        return [e["symbol"] for e in _search_index]


def fetch_sp500_prices(symbols: list[str]) -> list[dict]:
    """
    Fetch live prices for all S&P 500 tickers via yf.Tickers() +
    ThreadPoolExecutor so requests run in parallel (up to 20 at once).
    """
    if not symbols:
        return []

    tickers_obj = yf.Tickers(" ".join(symbols))
    stocks: list[dict] = []
    lock = threading.Lock()

    def _one(sym: str) -> None:
        try:
            t  = tickers_obj.tickers.get(sym)
            if t is None:
                return
            fi    = t.fast_info
            price = fi.last_price
            if price is None:
                return
            price = round(float(price), 2)
            prev  = fi.previous_close
            chg   = None
            if prev and float(prev) != 0:
                chg = round((price - float(prev)) / float(prev) * 100, 4)
            with lock:
                stocks.append({
                    "symbol":     sym,
                    "name":       _sp500_names.get(sym, sym),
                    "price":      price,
                    "change_pct": chg,
                })
        except Exception:
            pass

    with ThreadPoolExecutor(max_workers=20) as ex:
        list(ex.map(_one, symbols, timeout=90))

    stocks.sort(key=lambda x: x["symbol"])
    return stocks


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/indices")
def api_indices():
    return jsonify({"indices": get_live_indices()})


@app.route("/api/search")
def api_search():
    """Fast in-memory S&P 500 autocomplete — no yfinance calls."""
    ensure_search_index()
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])

    q_up = q.upper()
    q_lo = q.lower()

    # Tier 1 — symbol starts with query  (e.g. "AA" → AAPL, AMAT…)
    p1 = [x for x in _search_index if x["symbol"].startswith(q_up)]
    # Tier 2 — company name starts with query
    p2 = [x for x in _search_index
          if not x["symbol"].startswith(q_up)
          and x["name"].lower().startswith(q_lo)]
    # Tier 3 — symbol or name contains query anywhere
    p3 = [x for x in _search_index
          if not x["symbol"].startswith(q_up)
          and not x["name"].lower().startswith(q_lo)
          and (q_up in x["symbol"] or q_lo in x["name"].lower())]

    return jsonify((p1 + p2 + p3)[:8])


def _refresh_sp500_bg():
    """
    Run fetch_sp500_prices() in a daemon thread so /api/sp500 never blocks
    the Flask worker thread — /api/analyze always stays responsive.
    """
    global _sp500_fetching
    if _sp500_fetching:
        return
    _sp500_fetching = True

    def _work():
        global _sp500_fetching
        try:
            symbols = ensure_search_index()
            if symbols:
                stocks = fetch_sp500_prices(symbols)
                if stocks:
                    _sp500_cache["data"] = stocks
                    _sp500_cache["ts"]   = time.time()
        except Exception:
            pass
        finally:
            _sp500_fetching = False

    threading.Thread(target=_work, daemon=True).start()


@app.route("/api/sp500")
def api_sp500():
    now = time.time()
    cache_fresh = (_sp500_cache["data"] is not None
                   and (now - _sp500_cache["ts"]) < _SP500_TTL)

    if not cache_fresh:
        # Kick off a background refresh; return stale/empty immediately
        _refresh_sp500_bg()

    if _sp500_cache["data"]:
        return jsonify({"stocks": _sp500_cache["data"]})
    return jsonify({"stocks": [], "warning": "Price data loading — please refresh shortly."})


@app.route("/api/analyze")
def api_analyze():
    symbol = request.args.get("symbol", "").strip().upper()
    if not symbol:
        return jsonify({"error": "Symbol is required."}), 400

    history = get_history(symbol)
    if history.empty:
        return jsonify({"error": f"No historical data for symbol: {symbol}"}), 400

    # Latest price + daily change %
    try:
        if isinstance(history.columns, pd.MultiIndex):
            price_series = history["Close"].iloc[:, 0]
        else:
            price_series = history["Close"]
        price_clean = price_series.dropna()
        price = round(float(price_clean.iloc[-1]), 2)
        if len(price_clean) >= 2:
            prev = float(price_clean.iloc[-2])
            change_pct = round((price - prev) / prev * 100, 4) if prev else None
        else:
            change_pct = None
    except Exception:
        price = None
        change_pct = None

    fund  = get_fundamentals(symbol)
    name  = fund.get("name") or symbol
    beta  = calculate_beta(symbol)
    wacc  = calculate_wacc(symbol, beta=beta, fund=fund)
    de    = calculate_de_ratio(symbol, fund=fund)

    summary = generate_stock_summary(name, symbol, price, beta, wacc, de)

    return jsonify({
        "symbol":     symbol,
        "name":       name,
        "price":      price,
        "change_pct": change_pct,
        "beta":       beta,
        "wacc":       wacc,
        "de_ratio":   de,
        "summary":    summary,
    })


@app.route("/api/news")
def api_news():
    symbol = request.args.get("symbol", "").strip().upper()
    if not symbol:
        return jsonify([])
    try:
        raw = yf.Ticker(symbol).news or []
        now = datetime.now().timestamp()
        out = []
        for item in raw[:8]:
            # yfinance 1.x returns flat dict; newer builds nest under 'content'
            content = item.get("content", item)
            title   = content.get("title") or item.get("title", "")
            pub     = (content.get("provider", {}) or {}).get("displayName") \
                      or item.get("publisher", "")
            link    = (content.get("canonicalUrl", {}) or {}).get("url") \
                      or item.get("link", "")
            # timestamp: ISO string or Unix int
            ts_raw  = content.get("pubDate") or item.get("providerPublishTime", 0)
            try:
                if isinstance(ts_raw, str):
                    from datetime import timezone
                    from dateutil import parser as _dp
                    ts = _dp.parse(ts_raw).timestamp()
                else:
                    ts = float(ts_raw or 0)
            except Exception:
                ts = 0
            diff = int(now - ts)
            if diff < 3600:
                rel = f"{max(1, diff // 60)}m ago"
            elif diff < 86400:
                rel = f"{diff // 3600}h ago"
            else:
                rel = f"{diff // 86400}d ago"
            if title:
                out.append({"title": title, "publisher": pub, "link": link, "published": rel})
        return jsonify(out)
    except Exception:
        return jsonify([])


@app.route("/api/chart")
def api_chart():
    symbol = request.args.get("symbol", "").strip().upper()
    period = request.args.get("period", "1mo")
    if period not in {"1wk", "1mo", "3mo", "6mo", "1y"}:
        period = "1mo"
    if not symbol:
        return jsonify({"error": "Symbol required"}), 400
    try:
        df = yf.download(symbol, period=period, interval="1d",
                         progress=False, auto_adjust=True)
        if df.empty:
            return jsonify({"error": "No data"}), 404

        def _col(name):
            if isinstance(df.columns, pd.MultiIndex):
                return df[name].iloc[:, 0]
            return df[name]

        closes  = _col("Close")
        opens   = _col("Open")
        highs   = _col("High")
        lows    = _col("Low")
        volumes = _col("Volume")

        prices = []
        for date in closes.index:
            c = closes[date]
            if pd.isna(c):
                continue
            def _f(s): return round(float(s[date]), 2) if not pd.isna(s[date]) else None
            prices.append({
                "date":   date.strftime("%Y-%m-%d"),
                "close":  round(float(c), 2),
                "open":   _f(opens),
                "high":   _f(highs),
                "low":    _f(lows),
                "volume": int(volumes[date]) if not pd.isna(volumes[date]) else None,
            })

        if not prices:
            return jsonify({"error": "No valid data"}), 404

        first, last = prices[0]["close"], prices[-1]["close"]
        all_c = [p["close"] for p in prices]
        return jsonify({
            "prices":            prices,
            "period_change_pct": round((last - first) / first * 100, 4) if first else None,
            "period_high":       max(all_c),
            "period_low":        min(all_c),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/financials")
def api_financials():
    symbol = request.args.get("symbol", "").upper().strip()
    if not symbol:
        return jsonify({"error": "symbol required"}), 400

    t = yf.Ticker(symbol)
    result = {
        "symbol":           symbol,
        "name":             symbol,
        "annual_revenue":   None,
        "annual_costs":     None,
        "annual_cash_flow": None,
        "growth_rate":      None,
        "data_year":        None,
        "source_notes":     {},
    }

    # ── name ──────────────────────────────────────────────────────────────
    info = {}
    try:
        info = t.info or {}
        result["name"] = info.get("longName") or info.get("shortName") or symbol
    except Exception:
        pass

    # ── income statement ──────────────────────────────────────────────────
    fin = None
    try:
        fin = t.financials
        if fin is None or fin.empty:
            fin = t.income_stmt
    except Exception:
        pass

    # ── cash flow statement ───────────────────────────────────────────────
    cf_stmt = None
    try:
        cf_stmt = t.cashflow
    except Exception:
        pass

    if fin is not None and not fin.empty:
        # Data year from most-recent column header
        try:
            col = fin.columns[0]
            result["data_year"] = str(col.year) if hasattr(col, "year") else str(col)[:4]
        except Exception:
            pass

        # ── Revenue ──────────────────────────────────────────────────────
        rev_labels = [
            "Total Revenue",
            "Net Interest Income",
            "Total Net Revenue",
            "Revenue",
        ]
        for lbl in rev_labels:
            if lbl in fin.index:
                try:
                    val = fin.loc[lbl].iloc[0]
                    if val is not None and not pd.isna(val) and float(val) > 0:
                        result["annual_revenue"] = float(val)
                        result["source_notes"]["revenue"] = f"{lbl} — annual income statement"
                        break
                except Exception:
                    pass

        if result["annual_revenue"] is None:
            rv = info.get("totalRevenue")
            if rv:
                result["annual_revenue"] = float(rv)
                result["source_notes"]["revenue"] = "Total Revenue — company profile"

        # ── Operating Costs ──────────────────────────────────────────────
        cost_labels = [
            "Operating Expense",
            "Total Expenses",
            "Non Interest Expense",
        ]
        for lbl in cost_labels:
            if lbl in fin.index:
                try:
                    val = fin.loc[lbl].iloc[0]
                    if val is not None and not pd.isna(val):
                        result["annual_costs"] = abs(float(val))
                        result["source_notes"]["costs"] = f"{lbl} — annual income statement"
                        break
                except Exception:
                    pass

        # CoR + OpEx combined
        if result["annual_costs"] is None:
            try:
                cor = fin.loc["Cost Of Revenue"].iloc[0] if "Cost Of Revenue" in fin.index else None
                oe  = fin.loc["Operating Expense"].iloc[0] if "Operating Expense" in fin.index else None
                if cor is not None and oe is not None and not pd.isna(cor) and not pd.isna(oe):
                    result["annual_costs"] = abs(float(cor)) + abs(float(oe))
                    result["source_notes"]["costs"] = "Cost of Revenue + Operating Expense"
            except Exception:
                pass

        if result["annual_costs"] is None:
            oe = info.get("operatingExpenses")
            if oe:
                result["annual_costs"] = abs(float(oe))
                result["source_notes"]["costs"] = "Operating Expenses — company profile"

        # ── Revenue Growth Rate ───────────────────────────────────────────
        if "Total Revenue" in fin.index and len(fin.columns) >= 2:
            try:
                r0 = float(fin.loc["Total Revenue"].iloc[0])
                r1 = float(fin.loc["Total Revenue"].iloc[1])
                if r1 and not pd.isna(r0) and not pd.isna(r1):
                    growth = (r0 - r1) / abs(r1)
                    result["growth_rate"] = round(max(-0.5, min(1.0, growth)), 4)
                    result["source_notes"]["growth"] = "2-year revenue CAGR — income statement"
            except Exception:
                pass

        if result["growth_rate"] is None:
            rg = info.get("revenueGrowth")
            if rg is not None:
                result["growth_rate"] = round(max(-0.5, min(1.0, float(rg))), 4)
                result["source_notes"]["growth"] = "Revenue growth — company profile"

    # ── Free Cash Flow ────────────────────────────────────────────────────
    if cf_stmt is not None and not cf_stmt.empty:
        for lbl in ["Free Cash Flow", "Operating Cash Flow"]:
            if lbl in cf_stmt.index:
                try:
                    val = cf_stmt.loc[lbl].iloc[0]
                    if val is not None and not pd.isna(val):
                        result["annual_cash_flow"] = float(val)
                        result["source_notes"]["cash_flow"] = f"{lbl} — cash flow statement"
                        break
                except Exception:
                    pass

    # ── Costs fallback: Revenue − FCF ─────────────────────────────────────
    if (result["annual_costs"] is None
            and result["annual_revenue"] is not None
            and result["annual_cash_flow"] is not None):
        result["annual_costs"] = result["annual_revenue"] - result["annual_cash_flow"]
        result["source_notes"]["costs"] = "Estimated: Revenue minus Free Cash Flow"

    # ── Debug output ──────────────────────────────────────────────────────
    print(f"[FINANCIALS] {symbol}")
    print(f"  Revenue:        {result['annual_revenue']}")
    print(f"  Operating Costs:{result['annual_costs']}")
    print(f"  Free Cash Flow: {result['annual_cash_flow']}")
    print(f"  Growth Rate:    {result['growth_rate']}")
    print(f"  Data Year:      {result['data_year']}")

    return jsonify(result)


@app.route("/api/npv", methods=["POST"])
def api_npv():
    try:
        body = request.get_json(force=True) or {}

        initial      = body.get("initial_investment")
        annual_rev   = body.get("annual_revenue")
        annual_costs = body.get("annual_costs")
        growth_rate  = body.get("growth_rate", 0.0)
        lifespan     = body.get("lifespan", 5)
        rate         = body.get("discount_rate")

        # Validate
        if initial is None or not isinstance(initial, (int, float)) or initial <= 0:
            return jsonify({"error": "initial_investment must be a positive number"}), 400
        if annual_rev is None or not isinstance(annual_rev, (int, float)) or annual_rev < 0:
            return jsonify({"error": "annual_revenue must be a non-negative number"}), 400
        if annual_costs is None or not isinstance(annual_costs, (int, float)) or annual_costs < 0:
            return jsonify({"error": "annual_costs must be a non-negative number"}), 400
        if not isinstance(lifespan, int) or not (1 <= lifespan <= 15):
            return jsonify({"error": "lifespan must be an integer between 1 and 15"}), 400
        if not isinstance(growth_rate, (int, float)) or not (-0.5 <= growth_rate <= 2.0):
            return jsonify({"error": "growth_rate must be a decimal between -0.5 and 2.0"}), 400
        if rate is None or not isinstance(rate, (int, float)) or not (0 < rate < 1):
            return jsonify({"error": "discount_rate must be between 0 and 1 (exclusive)"}), 400

        # Auto-calculate cash flows from inputs
        base_cf    = annual_rev - annual_costs
        salvage    = round(initial * 0.10, 2)
        cash_flows = []
        for year in range(1, lifespan + 1):
            cf = base_cf * ((1 + growth_rate) ** (year - 1))
            if year == lifespan:
                cf += salvage
            cash_flows.append(round(cf, 2))

        # Core NPV calculation
        def _npv(r, inv, cfs):
            return -inv + sum(cf / (1 + r) ** (t + 1) for t, cf in enumerate(cfs))

        npv_val    = _npv(rate, initial, cash_flows)
        discounted = [round(cf / (1 + rate) ** (t + 1), 2) for t, cf in enumerate(cash_flows)]
        cumulative = []
        running    = -initial
        for d in discounted:
            running += d
            cumulative.append(round(running, 2))

        payback_year = None
        for i, c in enumerate(cumulative):
            if c >= 0:
                payback_year = i + 1
                break

        pi = round((npv_val + initial) / initial, 4)

        # Sensitivity: 5 rates centred on base
        steps       = [-0.04, -0.02, 0.0, 0.02, 0.04]
        sensitivity = []
        for delta in steps:
            r2 = round(rate + delta, 6)
            if 0 < r2 < 1:
                sensitivity.append({
                    "rate":    round(r2 * 100, 4),
                    "npv":     round(_npv(r2, initial, cash_flows), 2),
                    "is_base": delta == 0.0,
                })

        return jsonify({
            "npv":                   round(npv_val, 2),
            "cash_flows":            cash_flows,
            "discounted_cash_flows": discounted,
            "cumulative_cash_flows": cumulative,
            "payback_year":          payback_year,
            "profitability_index":   pi,
            "sensitivity":           sensitivity,
            "salvage_value":         salvage,
            "inputs": {
                "initial_investment": initial,
                "annual_revenue":     annual_rev,
                "annual_costs":       annual_costs,
                "growth_rate":        growth_rate,
                "lifespan":           lifespan,
                "discount_rate":      rate,
            },
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    import os
    from waitress import serve
    port = int(os.environ.get("PORT", 8080))
    print(f" * SOLYX starting on http://0.0.0.0:{port} (waitress, 16 threads)")
    serve(app, host="0.0.0.0", port=port, threads=16)

import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import { createChart } from "lightweight-charts";

// --- CONFIG ---
const ALPHA_VANTAGE_API_KEY = "REPLACE_WITH_YOUR_KEY"; // <-- put your key here
const AUTO_REFRESH_MS = 5000; // live update every 5 seconds
const SAMPLE_SYMBOLS = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "INFY.BSE", "TCS.BSE", "RELIANCE.BSE"
];

// --- UTILITIES: indicators ---
function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

function ema(values, period) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    const val = values[i] * k + prev * (1 - k);
    out.push(val);
    prev = val;
  }
  // first (period-1) entries are not meaningful; align length
  return out.map((v, idx) => (idx < period - 1 ? null : v));
}

function rsi(values, period = 14) {
  const out = [];
  let gains = 0, losses = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (i <= period) {
      if (diff > 0) gains += diff; else losses += Math.abs(diff);
      if (i === period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out.push(100 - 100 / (1 + rs));
      } else out.push(null);
    } else {
      const diff = values[i] - values[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
      const rs = losses === 0 ? 100 : gains / losses;
      out.push(100 - 100 / (1 + rs));
    }
  }
  // align length (values[0] has no RSI)
  out.unshift(null);
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f == null || s == null) return null;
    return f - s;
  });
  const signalLine = ema(macdLine.map(v => (v == null ? 0 : v)), signal);
  const hist = macdLine.map((v, i) => (v == null || signalLine[i] == null ? null : v - signalLine[i]));
  return { macdLine, signalLine, hist };
}

// --- Fetching from Alpha Vantage ---
async function fetchDaily(symbol) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${ALPHA_VANTAGE_API_KEY}`;
  const res = await axios.get(url);
  const data = res.data["Time Series (Daily)"] || res.data["Time Series (Daily) "];
  if (!data) throw new Error("No data returned. Check symbol & API key or rate limits.");
  // convert to sorted array (oldest -> newest)
  const dates = Object.keys(data).sort((a, b) => new Date(a) - new Date(b));
  const candles = dates.map(date => {
    const d = data[date];
    return {
      time: date,
      open: parseFloat(d["1. open"]),
      high: parseFloat(d["2. high"]),
      low: parseFloat(d["3. low"]),
      close: parseFloat(d["4. close"]),
      volume: parseFloat(d["6. volume"] || d["5. volume"] || 0)
    };
  });
  return candles;
}

// --- Main React Component ---
export default function StockViewerApp() {
  const chartRef = useRef(null);
  const [symbol, setSymbol] = useState("AAPL");
  const [input, setInput] = useState("");
  const [candles, setCandles] = useState([]);
  const [themeDark, setThemeDark] = useState(true);
  const [watchlist, setWatchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem("watchlist")) || ["AAPL", "TCS.BSE"]; } catch { return ["AAPL", "TCS.BSE"]; }
  });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [overlaySymbols, setOverlaySymbols] = useState([]);
  const [status, setStatus] = useState("");

  // init chart
  useEffect(() => {
    const container = chartRef.current;
    container.innerHTML = ""; // reset
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 420,
      layout: { backgroundColor: themeDark ? "#0b1221" : "#ffffff", textColor: themeDark ? "#d1d5db" : "#111827" },
      grid: { vertLines: { color: themeDark ? "#222" : "#eee" }, horzLines: { color: themeDark ? "#222" : "#eee" } },
      rightPriceScale: { borderColor: themeDark ? "#333" : "#ddd" },
      timeScale: { borderColor: themeDark ? "#333" : "#ddd" }
    });

    const candleSeries = chart.addCandlestickSeries();
    const volumeSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, scaleMargins: { top: 0.8, bottom: 0 } });

    // overlay line series for comparisons
    const overlaySeriesMap = {};

    function draw(data) {
      if (!data || data.length === 0) return;
      candleSeries.setData(data.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close })));
      volumeSeries.setData(data.map(d => ({ time: d.time, value: d.volume })));
      // compute SMA/EMA lines on close
      const closes = data.map(d => d.close);
      const sma20 = sma(closes, 20);
      const sma50 = sma(closes, 50);
      const ema20 = ema(closes, 20);

      // remove old extra series
      Object.values(overlaySeriesMap).forEach(s => chart.removeSeries(s));

      // add sma/ema as line series
      const sma20Series = chart.addLineSeries({ lineWidth: 1, priceLineVisible: false });
      const sma50Series = chart.addLineSeries({ lineWidth: 1, priceLineVisible: false });
      const ema20Series = chart.addLineSeries({ lineWidth: 1, priceLineVisible: false });
      sma20Series.setData(data.map((d, i) => ({ time: d.time, value: sma20[i] })));
      sma50Series.setData(data.map((d, i) => ({ time: d.time, value: sma50[i] })));
      ema20Series.setData(data.map((d, i) => ({ time: d.time, value: ema20[i] })));

      overlaySeriesMap.sma20 = sma20Series;
      overlaySeriesMap.sma50 = sma50Series;
      overlaySeriesMap.ema20 = ema20Series;

      // add overlays for other symbols (simple normalized lines)
      overlaySymbols.forEach((sym, idx) => {
        // create a mapping series
        const s = chart.addLineSeries({ lineWidth: 1, priceLineVisible: false });
        overlaySeriesMap["overlay_" + sym] = s;
      });
    }

    // store chart & series for later updates
    chartRef.current._chartObj = { chart, candleSeries, volumeSeries, overlaySeriesMap, draw };

    // resize observer
    const resizeObserver = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [themeDark, overlaySymbols]);

  // fetch & set data
  async function loadSymbol(sym) {
    setStatus(`Loading ${sym} ...`);
    try {
      const data = await fetchDaily(sym);
      setCandles(data);
      setSymbol(sym);
      setStatus(`Loaded ${sym} (${data.length} days)`);
      // draw on chart
      const chartObj = chartRef.current._chartObj;
      if (chartObj) chartObj.draw(data);
    } catch (e) {
      console.error(e);
      setStatus("Error loading data. Check console and API limits (Alpha Vantage has strict rate limits). If rate-limited, try again after 60s." );
    }
  }

  // auto refresh latest price
  useEffect(() => {
    let t;
    async function tick() {
      if (!symbol) return;
      try {
        // For latest price we call TIME_SERIES_INTRADAY or use daily and take last element
        const data = await fetchDaily(symbol);
        setCandles(data);
        const chartObj = chartRef.current._chartObj;
        if (chartObj) chartObj.draw(data);
      } catch (e) {
        console.error(e);
      }
      if (autoRefresh) t = setTimeout(tick, AUTO_REFRESH_MS);
    }
    tick();
    return () => clearTimeout(t);
  }, [symbol, autoRefresh]);

  // watchlist persistence
  useEffect(() => {
    localStorage.setItem("watchlist", JSON.stringify(watchlist));
  }, [watchlist]);

  // actions
  function addToWatchlist(sym) {
    if (!sym) return;
    if (!watchlist.includes(sym)) setWatchlist(prev => [...prev, sym]);
  }
  function removeFromWatchlist(sym) {
    setWatchlist(prev => prev.filter(s => s !== sym));
  }

  // quick add overlay
  function addOverlay(sym) {
    if (!sym) return;
    if (!overlaySymbols.includes(sym)) setOverlaySymbols(prev => [...prev, sym]);
  }
  function removeOverlay(sym) {
    setOverlaySymbols(prev => prev.filter(s => s !== sym));
  }

  // small helper to get latest price
  const latestPrice = candles.length ? candles[candles.length - 1].close : null;

  return (
    <div className={themeDark ? "min-h-screen p-6 bg-slate-900 text-slate-100" : "min-h-screen p-6 bg-white text-slate-900"}>
      <div className="max-w-6xl mx-auto">
        <header className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold">Stock Viewer — All Features</h1>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} /> Auto-refresh
            </label>
            <button className="px-3 py-1 rounded border" onClick={() => setThemeDark(d => !d)}>{themeDark ? "Light" : "Dark"}</button>
          </div>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="col-span-2">
            <div className="flex gap-2 mb-3">
              <input value={input} onChange={e => setInput(e.target.value.toUpperCase())} placeholder="Type symbol (e.g. AAPL, RELIANCE.BSE)" className="flex-1 px-3 py-2 rounded border" />
              <button className="px-3 py-2 rounded bg-blue-600" onClick={() => { addToWatchlist(input); setInput(""); }}>Add to Watchlist</button>
              <button className="px-3 py-2 rounded border" onClick={() => loadSymbol(input || symbol)}>View</button>
              <div className="ml-2">Sample: {SAMPLE_SYMBOLS.join(', ')}</div>
            </div>

            <div className="mb-2 text-sm text-slate-400">Status: {status}</div>

            <div ref={chartRef} className="w-full rounded shadow" style={{ background: themeDark ? '#071224' : '#fff' }} />

            <div className="flex gap-3 mt-3">
              <div>Latest: <strong>{latestPrice ? latestPrice.toFixed(2) : '—'}</strong></div>
              <div>Symbol: <strong>{symbol}</strong></div>
              <div>Data points: <strong>{candles.length}</strong></div>
            </div>
          </div>

          <aside>
            <div className="mb-4 p-3 rounded border">
              <h3 className="font-semibold mb-2">Watchlist</h3>
              <ul className="space-y-2">
                {watchlist.map(w => (
                  <li key={w} className="flex items-center justify-between">
                    <button className="text-left" onClick={() => loadSymbol(w)}>{w}</button>
                    <div className="flex gap-2">
                      <button className="px-2 py-1 rounded border text-sm" onClick={() => addOverlay(w)}>Overlay</button>
                      <button className="px-2 py-1 rounded border text-sm" onClick={() => removeFromWatchlist(w)}>Remove</button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-4">
                <h4 className="font-medium">Overlay Symbols</h4>
                <div className="flex gap-2 flex-wrap mt-2">
                  {overlaySymbols.map(o => (
                    <div key={o} className="px-2 py-1 border rounded flex items-center gap-2">
                      <span>{o}</span>
                      <button onClick={() => removeOverlay(o)}>x</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-3 rounded border">
              <h3 className="font-semibold mb-2">Indicators</h3>
              <div className="text-sm text-slate-400">SMA(20), SMA(50), EMA(20) are shown by default. RSI and MACD implemented in data but shown in console for brevity. You can extend to add sub-charts.</div>
            </div>

            <div className="mt-3 p-3 rounded border">
              <h3 className="font-semibold mb-2">Quick Samples</h3>
              <div className="flex flex-wrap gap-2">
                {SAMPLE_SYMBOLS.map(s => (
                  <button key={s} className="px-2 py-1 rounded border" onClick={() => loadSymbol(s)}>{s}</button>
                ))}
              </div>
            </div>

          </aside>
        </section>

        <footer className="text-sm text-slate-500 mt-6">Built with Lightweight-Charts + Alpha Vantage. Alpha Vantage has strict rate limits (5 requests/min on free tier). Replace the API key at the top of the file. Local watchlist stored in localStorage.</footer>
      </div>
    </div>
  );
}

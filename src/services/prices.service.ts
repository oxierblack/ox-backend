import { logger } from "../lib/logger";
import MarketSetting from "../models/MarketSetting";

/* ════════════════════════════════════════════════════════════
   REAL MARKET DATA — Binance public API
   Mirrors the same source the frontend chart uses, so prices,
   pairs and payouts always match what the user sees on the chart.
   ════════════════════════════════════════════════════════════ */

const BINANCE_BASE = "https://api.binance.com/api/v3";

// Manual icon overrides for assets whose CoinCap icon is missing/wrong.
// Keep this in sync with the frontend's getFlagUrl() overrides.
const ICON_OVERRIDES: Record<string, string> = {
  ton: "https://i.ibb.co/S4RSYZjM/image.png",
  xlm: "https://i.ibb.co/k2v65TWY/image.png",
  hmstr: "https://i.ibb.co/3ynGyxFd/image.png",
  jto: "https://i.ibb.co/xSmTQrKx/image.png",
  sto: "https://i.ibb.co/SDjfgTjx/image.png",
  bfusd: "https://i.ibb.co/wZscBNdr/image.png",
  mega: "https://i.ibb.co/r1WqGKx/image.png",
  bio: "https://i.ibb.co/mFHtKm2M/image.png",
  chib: "https://i.ibb.co/d068g75s/image.png",
  u: "https://i.ibb.co/Kp7F36tp/image.png",
  resolve: "https://i.ibb.co/HSsC4xz/image.png",
  home: "https://i.ibb.co/V0kwYh8Y/image.png",
  opg: "https://i.ibb.co/4R6wgtHP/image.png",
  vic: "https://i.ibb.co/W4mpQMP0/image.png",
  aster: "https://i.ibb.co/kgYKK2dD/image.png",
  saga: "https://i.ibb.co/YFm1FpZB/image.png",
  re: "https://i.ibb.co/8ngF25Zt/image.png",
  io: "https://i.ibb.co/qYxfvk6n/image.png",
  bico: "https://i.ibb.co/Q7856V58/image.png",
  mmt: "https://i.ibb.co/qY633mcT/image.png",
  zro: "https://i.ibb.co/Gvr99ff7/image.png",
  syn: "https://i.ibb.co/rJfq6sK/image.png",
  lumia: "https://i.ibb.co/spjgrhz8/image.png",
  xpl: "https://i.ibb.co/vv3rQNv5/image.png",
  spcxb: "https://i.ibb.co/vx2xb3bg/image.png",
  allo: "https://i.ibb.co/mFTnzcSx/image.png",
  w: "https://i.ibb.co/5x6yDwtp/image.png",
  tnsr: "https://i.ibb.co/ksmGxYTr/image.png",
};

const GOLD_BASES = new Set(["PAXG", "XAUT"]);
const FOREX_BASES = new Set(["EUR", "GBP", "AUD", "CAD", "CHF", "JPY", "NZD", "TRY", "BRL", "MXN"]);

function getCategory(base: string): "crypto" | "gold" | "forex" {
  if (GOLD_BASES.has(base)) return "gold";
  if (FOREX_BASES.has(base)) return "forex";
  return "crypto";
}

function getIconUrl(base: string): string {
  const lower = base.toLowerCase();
  if (ICON_OVERRIDES[lower]) return ICON_OVERRIDES[lower];
  return `https://assets.coincap.io/assets/icons/${lower}@2x.png`;
}

function getDecimals(price: number): number {
  if (price >= 100) return 2;
  if (price >= 10) return 3;
  if (price >= 1) return 4;
  if (price >= 0.1) return 5;
  if (price >= 0.01) return 6;
  return 8;
}

interface BinanceExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

interface BinanceTicker24hr {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
}

export const latestPrices: Map<string, { price: number; timestamp: number }> = new Map();

type BroadcastFn = (event: string, data: unknown) => void;
let broadcastFn: BroadcastFn | null = null;

export function setBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

/**
 * Pulls the full list of live USDT trading pairs from Binance and
 * upserts them into MarketSetting. Existing admin overrides
 * (isActive, payoutPct, etc.) on already-known symbols are preserved —
 * only new symbols get defaults inserted.
 */
export async function syncMarketsFromBinance(): Promise<void> {
  try {
    const [exchangeInfoRes, tickersRes] = await Promise.all([
      fetch(`${BINANCE_BASE}/exchangeInfo`, { signal: AbortSignal.timeout(10000) }),
      fetch(`${BINANCE_BASE}/ticker/24hr`, { signal: AbortSignal.timeout(10000) }),
    ]);

    if (!exchangeInfoRes.ok || !tickersRes.ok) {
      throw new Error(`Binance responded with ${exchangeInfoRes.status}/${tickersRes.status}`);
    }

    const exchangeInfo = (await exchangeInfoRes.json()) as { symbols: BinanceExchangeSymbol[] };
    const tickers = (await tickersRes.json()) as BinanceTicker24hr[];
    const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));

    const pairs = exchangeInfo.symbols
      .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT" && /^[A-Z0-9]+$/.test(s.baseAsset))
      .map((s) => {
        const ticker = tickerMap.get(s.symbol);
        const price = parseFloat(ticker?.lastPrice || "0");
        const volume = parseFloat(ticker?.quoteVolume || "0");
        return { symbol: s.symbol, baseAsset: s.baseAsset, price, volume };
      })
      .sort((a, b) => b.volume - a.volume);

    if (pairs.length === 0) {
      logger.warn("Binance returned zero tradable USDT pairs — skipping sync");
      return;
    }

    // Only the top-volume pairs are activated for trading by default.
    // The full Binance pair list is still synced into MarketSetting
    // (so the admin panel can browse/activate any of them), but only
    // these start out tradable — activating every single USDT pair
    // (2000+) would flood the price feed, signals engine and every
    // connected client's WebSocket with thousands of updates a second.
    const DEFAULT_ACTIVE_COUNT = 30;
    const activeSymbols = new Set(pairs.slice(0, DEFAULT_ACTIVE_COUNT).map((p) => p.symbol));

    const ops = pairs.map((p) => ({
      updateOne: {
        filter: { symbol: p.symbol },
        update: {
          $setOnInsert: {
            symbol: p.symbol,
            baseAsset: p.baseAsset,
            displayName: `${p.baseAsset}/USDT`,
            category: getCategory(p.baseAsset),
            icon: getIconUrl(p.baseAsset),
            decimals: getDecimals(p.price),
            payoutPct: 82 + Math.floor(Math.random() * 12),
            isActive: activeSymbols.has(p.symbol),
            source: "binance",
          },
        },
        upsert: true,
      },
    }));

    await MarketSetting.bulkWrite(ops, { ordered: false });

    // Seed initial prices immediately so trades aren't blocked waiting for the first poll.
    for (const p of pairs) {
      if (p.price > 0) {
        latestPrices.set(p.symbol, { price: p.price, timestamp: Date.now() });
      }
    }

    logger.info({ count: pairs.length }, "Markets synced from Binance");
  } catch (err) {
    logger.error({ err }, "Failed to sync markets from Binance");
  }
}

async function fetchAllPrices(symbols: string[]): Promise<void> {
  try {
    const res = await fetch(`${BINANCE_BASE}/ticker/price`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Array<{ symbol: string; price: string }>;
    const wanted = new Set(symbols);
    const now = Date.now();
    for (const row of data) {
      if (!wanted.has(row.symbol)) continue;
      const price = parseFloat(row.price);
      if (Number.isFinite(price) && price > 0) {
        latestPrices.set(row.symbol, { price, timestamp: now });
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to fetch prices from Binance");
  }
}

/**
 * Starts the live price feed: re-syncs the market/pair list from Binance
 * periodically (new listings, delistings) and polls live prices for all
 * active markets, broadcasting them over WebSocket.
 */
export function startPriceFeed(): void {
  logger.info("Price feed started (Binance)");

  const broadcastPrices = async (): Promise<void> => {
    if (!broadcastFn) return;
    const markets = await MarketSetting.find({ isActive: true }).select("symbol").lean();
    const symbols = markets.map((m) => m.symbol);
    if (symbols.length === 0) return;

    await fetchAllPrices(symbols);

    for (const symbol of symbols) {
      const data = latestPrices.get(symbol);
      if (data) {
        broadcastFn("price_update", { symbol, price: data.price, timestamp: data.timestamp });
      }
    }
  };

  // Initial sync, then poll prices every 2s and re-sync the pair list every hour.
  void broadcastPrices();
  setInterval(() => void broadcastPrices(), 2000);
  setInterval(() => void syncMarketsFromBinance(), 60 * 60 * 1000);
}

export function getLatestPrice(symbol: string): number | null {
  return latestPrices.get(symbol)?.price ?? null;
}

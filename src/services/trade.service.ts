import mongoose from "mongoose";
import Trade from "../models/Trade";
import User from "../models/User";
import MarketSetting from "../models/MarketSetting";
import { getLatestPrice } from "./prices.service";
import { processTurnoverCommission } from "./commission.service";
import { logger } from "../lib/logger";

type BroadcastFn = (event: string, data: unknown, userId?: string) => void;
let broadcastFn: BroadcastFn | null = null;

export function setTradeBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

export async function openTrade(params: {
  userId: string;
  marketSymbol: string;
  side: "buy" | "sell";
  amount: number;
  expirySeconds: number;
  walletType: "demo" | "real";
}): Promise<{ trade: InstanceType<typeof Trade>; error?: string }> {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error("Trade amount must be a positive number");
  }
  if (!Number.isFinite(params.expirySeconds) || params.expirySeconds < 15 || params.expirySeconds > 3600) {
    throw new Error("Expiry must be between 15 seconds and 1 hour");
  }
  if (params.side !== "buy" && params.side !== "sell") {
    throw new Error("Invalid trade side");
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const user = await User.findById(params.userId).session(session);
    if (!user) throw new Error("User not found");

    const market = await MarketSetting.findOne({ symbol: params.marketSymbol, isActive: true });
    if (!market) throw new Error("Market not found or inactive");

    const balanceField = params.walletType === "demo" ? "demoBalance" : "realBalance";

    // Atomic check-and-deduct inside the transaction: the update only
    // matches (and applies) if the balance is still sufficient, closing
    // the race where two concurrent trades both read a balance that's
    // enough for one but not both.
    const debited = await User.findOneAndUpdate(
      { _id: params.userId, [balanceField]: { $gte: params.amount } },
      { $inc: { [balanceField]: -params.amount } },
      { session, new: true }
    );
    if (!debited) throw new Error("Insufficient balance");

    const entryPrice = getLatestPrice(params.marketSymbol);
    if (!entryPrice) throw new Error("Price not available");

    const expiryAt = new Date(Date.now() + params.expirySeconds * 1000);
    const [trade] = await Trade.create(
      [
        {
          userId: user._id,
          marketSymbol: params.marketSymbol,
          marketName: market.displayName,
          side: params.side,
          amount: params.amount,
          entryPrice,
          payoutPct: market.payoutPct,
          expirySeconds: params.expirySeconds,
          openedAt: new Date(),
          expiryAt,
          status: "open",
          walletType: params.walletType,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    scheduleTradeClosure(trade._id.toString(), params.expirySeconds * 1000);

    return { trade };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

export function scheduleTradeClosure(tradeId: string, delayMs: number): void {
  setTimeout(async () => {
    try {
      await resolveTrade(tradeId);
    } catch (err) {
      logger.error({ err, tradeId }, "Error resolving trade");
    }
  }, delayMs);
}

export async function resolveTrade(tradeId: string): Promise<void> {
  const trade = await Trade.findById(tradeId);
  if (!trade || trade.status !== "open") return;

  const exitPrice = getLatestPrice(trade.marketSymbol) || trade.entryPrice;
  const priceWentUp = exitPrice > trade.entryPrice;
  const won =
    (trade.side === "buy" && priceWentUp) || (trade.side === "sell" && !priceWentUp);

  const status: "won" | "lost" = won ? "won" : "lost";
  const profit = won ? trade.amount * (trade.payoutPct / 100) : -trade.amount;

  await trade.updateOne({ status, exitPrice, profit, resolvedAt: new Date() });

  if (won) {
    const payout = trade.amount + profit;
    const balanceField = trade.walletType === "demo" ? "demoBalance" : "realBalance";
    await User.findByIdAndUpdate(trade.userId, { $inc: { [balanceField]: payout } });
  } else if (trade.walletType === "real") {
    await processTurnoverCommission(
      trade.userId as mongoose.Types.ObjectId,
      trade.amount
    );
  }

  if (broadcastFn) {
    broadcastFn(
      "trade_result",
      { tradeId, result: status, profit, exitPrice },
      trade.userId.toString()
    );
  }
}

export async function earlyCloseTrade(tradeId: string, userId: string): Promise<void> {
  const trade = await Trade.findOne({ _id: tradeId, userId, status: "open" });
  if (!trade) throw new Error("Trade not found");

  const elapsed = Date.now() - trade.openedAt.getTime();
  if (elapsed > 30000) throw new Error("Early close only allowed within 30 seconds of opening");

  const refund = trade.amount * 0.5;
  const balanceField = trade.walletType === "demo" ? "demoBalance" : "realBalance";

  await trade.updateOne({ status: "closed_early", exitPrice: trade.entryPrice, profit: -refund, resolvedAt: new Date() });
  await User.findByIdAndUpdate(userId, { $inc: { [balanceField]: refund } });
}

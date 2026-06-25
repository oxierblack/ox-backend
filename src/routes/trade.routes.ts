import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { openTrade, earlyCloseTrade } from "../services/trade.service";
import Trade from "../models/Trade";
import User from "../models/User";

const router = Router();

router.use(authMiddleware);
router.use(requireRole("client"));

router.post("/open", async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { marketSymbol, side, amount, expirySeconds } = req.body;
    const user = await User.findById(req.user!.id).select("walletType");
    const result = await openTrade({
      userId: req.user!.id,
      marketSymbol,
      side,
      amount: Number(amount),
      expirySeconds: Number(expirySeconds),
      walletType: user?.walletType || "demo",
    });
    res.json({ trade: result.trade });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to open trade" });
  }
});

router.post("/close-early/:tradeId", async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await earlyCloseTrade(req.params["tradeId"]!, req.user!.id);
    res.json({ message: "Trade closed early — 50% refunded" });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to close trade" });
  }
});

router.get("/history", async (req: AuthRequest, res: Response): Promise<void> => {
  const { page = 1, limit = 20, status } = req.query;
  const filter: Record<string, unknown> = { userId: req.user!.id };
  if (status) filter["status"] = status;

  const trades = await Trade.find(filter)
    .sort({ openedAt: -1 })
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit));

  const total = await Trade.countDocuments(filter);
  res.json({ trades, total, page: Number(page) });
});

router.get("/active", async (req: AuthRequest, res: Response): Promise<void> => {
  const trades = await Trade.find({ userId: req.user!.id, status: "open" });
  res.json({ trades });
});

router.post("/switch-wallet", async (req: AuthRequest, res: Response): Promise<void> => {
  const { walletType } = req.body;
  if (!["demo", "real"].includes(walletType)) {
    res.status(400).json({ error: "Invalid wallet type" });
    return;
  }
  await User.findByIdAndUpdate(req.user!.id, { walletType });
  res.json({ message: `Switched to ${walletType} wallet` });
});

router.get("/balance", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await User.findById(req.user!.id).select("demoBalance realBalance bonusBalance walletType");
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json({
    demoBalance: user.demoBalance,
    realBalance: user.realBalance,
    bonusBalance: user.bonusBalance,
    walletType: user.walletType,
  });
});

export default router;

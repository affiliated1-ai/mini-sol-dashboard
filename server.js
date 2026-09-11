/**
 * ═══════════════════════════════════════════════════════════════════
 *  SOL AUTO-TRADER — Backend Server v10
 *
 *  Receives signals from the Reversal Adaptive Sniper v10 dashboard,
 *  executes limit orders on Jupiter Perpetuals via the Solana RPC,
 *  manages positions with ATR-based SL/TP, and compounds margin
 *  based on balance growth and confidence score.
 *
 *  Stack:   Node.js 18+ · Express · cors · dotenv · telegraf
 *  Run:     node server.js
 *  Config:  .env  (never commit)
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { Telegraf } = require('telegraf');
const jupiter    = require('./jupiter');
const { log, loadState, saveState } = require('./utils');


// ── Config from .env ──────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT            || '3001');
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN           || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID         || '';
const MAX_POSITIONS    = parseInt(process.env.MAX_POSITIONS   || '3');
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || '50');
const STARTING_BALANCE = parseFloat(process.env.STARTING_BALANCE || '240');
const FILL_TIMEOUT_MS  = parseInt(process.env.FILL_TIMEOUT_MS || '120000'); // 2 min

// Load environment variables with Devnet as default fallback
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

console.log(`[\({SOLANA_NETWORK.toUpperCase()}] Connected to RPC:\){SOLANA_RPC_URL}`);

function getPullbackOffset(timeframe, atr) {
  const limits = {
    '5m': [0.03, 0.20],
    '15m': [0.05, 0.20],
    '30m': [0.05, 0.20],
    '1h': [0.15, 0.40],
    '4h': [0.20, 0.40],
  };
  const [min, max] = limits[timeframe] || limits['15m'];
  const value = Number.isFinite(Number(atr)) ? Number(atr) * 0.25 : min;
  return Math.min(max, Math.max(min, value));
}

// ── State file ────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function freshDay() {
  return {
    date:        new Date().toISOString().slice(0, 10),
    balance:     STARTING_BALANCE,
    positions:   [],
    closedToday: [],
    dailyPnL:    0,
    halted:      false,
    signalLog:   [],
  };
}

let S = loadState(STATE_FILE, freshDay);

// Day rollover check
function checkRollover() {
  const today = new Date().toISOString().slice(0, 10);
  if (S.date !== today) {
    log(`Day rollover → ${today}. Carrying balance $${S.balance.toFixed(2)}`);
    const bal = S.balance;
    S = freshDay();
    S.date    = today;
    S.balance = bal;
    saveState(STATE_FILE, S);
  }
}
setInterval(checkRollover, 60_000);

// ── Telegram ──────────────────────────────────────────────────────
const tg = TELEGRAM_TOKEN ? new Telegraf(TELEGRAM_TOKEN) : null;

async function notify(msg) {
  log('[TG] ' + msg.replace(/<[^>]+>/g, ''));
  if (!tg || !TELEGRAM_CHAT_ID) return;
  try { await tg.telegram.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' }); }
  catch (e) { log('[TG ERR] ' + e.message); }
}

// ── Margin Sizing — compounding + confidence + regime ────────────
/**
 * v10 margin formula:
 *   Base percentage from confidence score (0-5)
 *   × regime multiplier (FLASH_CRASH scales down, BULL_DRIFT full size)
 *   × compounding balance
 *   Clamped to [minMargin, maxMargin]
 *
 * LSD safety: if balance < $12.50 → use flat $10.50 margin, 10x leverage
 */
function calcMargin(confidenceScore, regime, recommendedMargin) {
  const bal = S.balance;

  // LSD (Low-Stake Defence) mode from v10
  if (bal < 12.50) {
    return { margin: Math.min(10.50, bal - 0.05), leverage: 10, lsd: true };
  }

  // If dashboard sends a regime-derived recommendation, use it as a guide
  // but scale it proportionally to current balance vs $240 baseline
  const scaleFactor = bal / 240;
  let base = (recommendedMargin || 100) * scaleFactor;

  // Confidence modifier: 5=100%, 4=75%, 3=50%, ≤2=25%
  const confMod = { 5: 1.0, 4: 0.75, 3: 0.50 }[confidenceScore] || 0.25;
  base *= confMod;

  // Regime hard caps
  if (regime === 'MARKET_CHOP') return { margin: 0, leverage: 40, lsd: false }; // standby
  if (regime === 'FLASH_CRASH') base = Math.min(base, 25 * scaleFactor);

  const margin = Math.max(10.50, Math.min(base, bal * 0.15)); // 15% max of balance
  return { margin: parseFloat(margin.toFixed(2)), leverage: 40, lsd: false };
}

// ── Handle incoming signal ────────────────────────────────────────
async function handleSignal(sig) {
  const {
    direction, price, atr, confidenceScore,
    asset, timeframe, reason, regime,
    entryOffset, tp1, tp2, slCoeff, recommendedMargin,
  } = sig;

  // Log it
  S.signalLog.unshift({ ...sig, ts: new Date().toISOString() });
  if (S.signalLog.length > 50) S.signalLog.pop();
  saveState(STATE_FILE, S);

  log(`Signal: ${direction} | ${asset} @ $${price} | ${regime} | conf ${confidenceScore}/5 | ${reason}`);

  // ── Guards ────────────────────────────────────────────────────
  if (S.halted)
    return { status: 'halted', message: 'Daily loss limit hit. Trading suspended.' };

  if (direction === 'yellow')
    return { status: 'skip', message: 'Yellow — standby.' };

  if (regime === 'MARKET_CHOP')
    return { status: 'skip', message: 'Market Chop regime — sitting on hands.' };

  if (S.positions.length >= MAX_POSITIONS)
    return { status: 'skip', message: `Max ${MAX_POSITIONS} positions open.` };

  const dup = S.positions.find(p => p.asset === asset && p.direction === direction);
  if (dup)
    return { status: 'skip', message: `Existing ${direction} on ${asset}.` };

  // ── Compute entry / SL / TP ───────────────────────────────────
  const isLong    = direction === 'green';
  const atrVal    = parseFloat(atr) || 0.35;
  const off       = entryOffset != null && Number.isFinite(Number(entryOffset))
    ? Number(entryOffset)
    : getPullbackOffset(timeframe, atrVal);
  const sl        = (slCoeff  || 1.8);
  const _tp1      = tp1 || 0.25;
  const _tp2      = tp2 || 0.75;

  const entryPrice = isLong ? price - off : price + off;
  const stopLoss   = isLong ? entryPrice - (sl * atrVal) : entryPrice + (sl * atrVal);
  const takeProfit = isLong ? entryPrice + _tp2          : entryPrice - _tp2;

  const { margin, leverage, lsd } = calcMargin(confidenceScore, regime, recommendedMargin);

  if (margin <= 0)
    return { status: 'skip', message: 'Zero margin — regime says standby.' };

  log(`Order: ${isLong?'LONG':'SHORT'} | Entry $${entryPrice} | SL $${stopLoss} | TP $${takeProfit} | Margin $${margin} ${lsd?'[LSD]':''}`);

  // ── Place on Jupiter ──────────────────────────────────────────
  let orderId;
  try {
    orderId = await jupiter.placeLimitOrder({
      asset, side: isLong ? 'Long' : 'Short',
      marginUSDC: margin, limitPrice: entryPrice,
      stopLoss, takeProfit, leverage,
    });
  } catch (err) {
    log('[ERR] jupiter.placeLimitOrder: ' + err.message);
    await notify(`❌ <b>Order Failed</b>\n${isLong?'LONG':'SHORT'} ${asset} @ $${entryPrice.toFixed(2)}\n${err.message}`);
    return { status: 'error', message: err.message };
  }

  const position = {
    id: orderId, asset, direction,
    side: isLong ? 'Long' : 'Short',
    margin, leverage, lsd, entryPrice,
    stopLoss, takeProfit, atr: atrVal,
    confidence: confidenceScore, regime, reason, timeframe,
    status: 'pending', openedAt: new Date().toISOString(),
    fillPrice: null, closedAt: null, pnl: null,
  };

  S.positions.push(position);
  saveState(STATE_FILE, S);

  const regimeLabel = (regime||'').replace(/_/g,' ');
  await notify([
    `🎯 <b>Limit Order Placed</b>`,
    `${isLong?'🟢':'🔴'} <b>${position.side} ${asset}</b> · ${regimeLabel}${lsd?' [LSD 10×]':''}`,
    `Entry:  $${entryPrice.toFixed(2)} (${Math.round(off*100)}¢ pullback)`,
    `TP1:    $${(isLong?entryPrice+_tp1:entryPrice-_tp1).toFixed(2)} (+${Math.round(_tp1*100)}¢)`,
    `TP2:    $${takeProfit.toFixed(2)} (+${Math.round(_tp2*100)}¢)`,
    `Stop:   $${stopLoss.toFixed(2)} (${sl}×ATR)`,
    `Margin: $${margin} | Conf: ${confidenceScore}/5 | ${reason}`,
  ].join('\n'));

  setTimeout(() => checkFillOrCancel(orderId), FILL_TIMEOUT_MS);

  return { status: 'placed', orderId, entryPrice, stopLoss, takeProfit, margin, leverage };
}

// ── Fill/cancel ───────────────────────────────────────────────────
async function checkFillOrCancel(orderId) {
  const pos = S.positions.find(p => p.id === orderId);
  if (!pos || pos.status !== 'pending') return;
  try {
    const st = await jupiter.getOrderStatus(orderId);
    if (st.filled) {
      pos.status = 'open'; pos.fillPrice = st.fillPrice;
      log(`Filled: ${orderId} @ $${pos.fillPrice}`);
      await notify(`✅ <b>Position Open</b>\n${pos.side} ${pos.asset} @ $${pos.fillPrice}`);
    } else {
      await jupiter.cancelOrder(orderId);
      S.positions = S.positions.filter(p => p.id !== orderId);
      log(`Cancelled (no fill): ${orderId}`);
      await notify(`⏱ <b>Cancelled</b> — no fill: ${pos.side} ${pos.asset} @ $${pos.entryPrice}`);
    }
    saveState(STATE_FILE, S);
  } catch (e) { log('[ERR] checkFillOrCancel: ' + e.message); }
}

// ── Close position ────────────────────────────────────────────────
async function closePosition(posId, exitPrice, closeReason) {
  const pos = S.positions.find(p => p.id === posId);
  if (!pos) return;
  try { await jupiter.closePosition(posId); } catch (e) { log('[ERR] closePosition: ' + e.message); }

  const pricePct = pos.side === 'Long'
    ? (exitPrice - pos.fillPrice) / pos.fillPrice
    : (pos.fillPrice - exitPrice) / pos.fillPrice;
  const pnl = pricePct * pos.margin * pos.leverage;

  pos.status = 'closed'; pos.closedAt = new Date().toISOString();
  pos.exitPrice = exitPrice; pos.pnl = parseFloat(pnl.toFixed(2));
  S.dailyPnL += pos.pnl;
  S.balance  += pos.pnl;  // compound
  S.closedToday.push(pos);
  S.positions = S.positions.filter(p => p.id !== posId);

  if (S.dailyPnL <= -Math.abs(DAILY_LOSS_LIMIT)) {
    S.halted = true;
    await notify(`🚨 <b>Daily Loss Limit</b>\nLoss $${Math.abs(S.dailyPnL).toFixed(2)} ≥ limit $${DAILY_LOSS_LIMIT}. Trading halted.`);
  }
  saveState(STATE_FILE, S);

  const emoji = pos.pnl >= 0 ? '✅' : '❌';
  await notify([
    `${emoji} <b>Closed</b> — ${closeReason}`,
    `${pos.side} ${pos.asset} | Fill $${pos.fillPrice} → $${exitPrice}`,
    `PnL: ${pos.pnl>=0?'+':''}$${pos.pnl.toFixed(2)} (${(pricePct*100).toFixed(2)}%)`,
    `Balance: $${S.balance.toFixed(2)} | Day: ${S.dailyPnL>=0?'+':''}$${S.dailyPnL.toFixed(2)}`,
  ].join('\n'));
}

// ── Position monitor (polls for SL/TP hits) ───────────────────────
async function monitorPositions() {
  for (const pos of S.positions.filter(p => p.status === 'open')) {
    try {
      const st = await jupiter.getPositionStatus(pos.id);
      if (st.closed) await closePosition(pos.id, st.exitPrice, st.closeReason || 'SL/TP');
    } catch (e) { log(`[MONITOR] ${pos.id}: ${e.message}`); }
  }
}
setInterval(monitorPositions, 30_000);

// ── Express routes ────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js')));

// Dashboard posts here on every signal change
app.post('/signal', async (req, res) => {
  try { res.json(await handleSignal(req.body)); }
  catch (e) { log('[API] ' + e.message); res.status(500).json({ error: e.message }); }
});

// Manual close
app.post('/close', async (req, res) => {
  try { await closePosition(req.body.positionId, req.body.exitPrice, 'Manual'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Dashboard polls for position data
app.get('/state', (req, res) => {
  checkRollover();
  res.json({
    positions:   S.positions,
    closedToday: S.closedToday.slice(-20),
    dailyPnL:    S.dailyPnL,
    balance:     S.balance,
    halted:      S.halted,
    signalLog:   S.signalLog.slice(0, 20),
    config: { MAX_POSITIONS, DAILY_LOSS_LIMIT },
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, positions: S.positions.length, balance: S.balance }));

// Emergency stop
app.post('/halt',   async (_req, res) => { S.halted = true;  saveState(STATE_FILE, S); await notify('🛑 <b>Manual halt</b>'); res.json({ halted: true }); });
app.post('/resume', async (_req, res) => { S.halted = false; saveState(STATE_FILE, S); await notify('▶️ <b>Resumed</b>');   res.json({ halted: false }); });

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`╔══════════════════════════════════════════╗`);
  log(`║  SOL Auto-Trader v10  :${PORT}              ║`);
  log(`║  Balance:    $${String(S.balance.toFixed(2)).padEnd(26)}║`);
  log(`║  Max pos:    ${String(MAX_POSITIONS).padEnd(28)}║`);
  log(`║  Loss limit: $${String(DAILY_LOSS_LIMIT).padEnd(25)}║`);
  log(`╚══════════════════════════════════════════╝`);
});

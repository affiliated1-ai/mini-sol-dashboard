/**
 * ═══════════════════════════════════════════════════════════════════
 *  SOL AUTO-TRADER — Backend Server v10
 *
 *  Receives signals from the Reversal Adaptive Sniper v10 dashboard,
 *  executes on-chain position requests via Jupiter Perps Anchor program,
 *  monitors position state via on-chain account polling,
 *  compounds margin based on balance × confidence × regime.
 *
 *  Stack:   Node.js 18+ · Express · @coral-xyz/anchor · telegraf
 *  Run:     node server.js
 *  Config:  .env  (never commit)
 *
 *  Key Anchor changes vs old REST version:
 *  - placeLimitOrder() returns { requestPDA, positionPDA }
 *  - Fill detection: PositionRequest account closes when keeper executes
 *  - Position monitoring: Position account closes when SL/TP/liquidation hits
 *  - PnL on close: queried from on-chain Position account before it closes
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Telegraf } = require('telegraf');
const jupiter = require('./jupiter');
const { log, loadState, saveState } = require('./utils');

// ── Config ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '3');
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || '50');
const STARTING_BALANCE = parseFloat(process.env.STARTING_BALANCE || '240');
const FILL_TIMEOUT_MS = parseInt(process.env.FILL_TIMEOUT_MS || '30000'); // 30s — keepers are fast
const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL || '15000'); // 15s on-chain poll

const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
console.log(`[${SOLANA_NETWORK.toUpperCase()}] Connected to RPC: ${SOLANA_RPC_URL}`);

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

// ── State ─────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function freshDay() {
  return {
    date: new Date().toISOString().slice(0, 10),
    balance: STARTING_BALANCE,
    positions: [],
    closedToday: [],
    dailyPnL: 0,
    halted: false,
    signalLog: [],
  };
}

let S = loadState(STATE_FILE, freshDay);

function checkRollover() {
  const today = new Date().toISOString().slice(0, 10);
  if (S.date !== today) {
    log(`Day rollover → ${today}. Balance carried: $${S.balance.toFixed(2)}`);
    const bal = S.balance;
    S = freshDay();
    S.date = today;
    S.balance = bal;
    saveState(STATE_FILE, S);
  }
}
setInterval(checkRollover, 60_000);

// ── Telegram ──────────────────────────────────────────────────────
const tg = TELEGRAM_TOKEN ? new Telegraf(TELEGRAM_TOKEN) : null;

async function sendTelegramMessage(msg) {
  log('[TG] ' + msg.replace(/<[^>]+>/g, ''));
  if (!tg || !TELEGRAM_CHAT_ID) {
    throw new Error('Telegram is not configured on the backend');
  }
  try {
    await tg.telegram.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' });
  } catch (e) {
    log('[TG ERR] ' + e.message);
    throw e;
  }
}

async function notify(msg) {
  try { await sendTelegramMessage(msg); }
  catch (e) { log('[TG] ' + e.message); }
}

// ── Margin sizing ─────────────────────────────────────────────────
function calcMargin(confidenceScore, regime, recommendedMargin) {
  const bal = S.balance;

  if (bal < 12.50) {
    return { margin: parseFloat(Math.min(10.50, Math.max(0, bal - 0.05)).toFixed(2)), leverage: 10, mode: 'LSD' };
  }

  if (bal < 22.00) {
    return { margin: 11.00, leverage: 20, mode: 'DEB' };
  }

  if (regime === 'MARKET_CHOP')
    return { margin: 0, leverage: 40, mode: 'STANDBY' };

  const scale = bal / 240;
  let base = (recommendedMargin || 100) * scale;

  const confMod = { 5: 1.0, 4: 0.75, 3: 0.50 }[confidenceScore] || 0.25;
  base *= confMod;

  if (regime === 'FLASH_CRASH') base = Math.min(base, 25 * scale);

  const margin = Math.max(10.50, Math.min(base, bal * 0.15));
  return { margin: parseFloat(margin.toFixed(2)), leverage: 40, mode: 'STANDARD' };
}

function validateSignal(sig) {
  if (!sig || typeof sig !== 'object') throw new Error('Signal payload must be an object');

  const required = ['direction', 'asset', 'price'];
  const missing = required.filter(key => sig[key] === undefined || sig[key] === null || sig[key] === '');
  if (missing.length) throw new Error(`Signal missing required field(s): ${missing.join(', ')}`);

  if (!['green', 'red', 'yellow'].includes(sig.direction))
    throw new Error(`Invalid signal direction: ${sig.direction}`);

  const numericFields = ['price', 'atr', 'tp1', 'tp2', 'slCoeff', 'recommendedMargin'];
  for (const field of numericFields) {
    if (sig[field] !== undefined && !Number.isFinite(Number(sig[field])))
      throw new Error(`Signal field ${field} must be a finite number`);
  }
}

// ── Handle signal ─────────────────────────────────────────────────
async function handleSignal(sig) {
  validateSignal(sig);

  const {
    direction, price, atr, confidenceScore,
    asset, timeframe, reason, regime,
    entryOffset, tp1, tp2, slCoeff, recommendedMargin,
  } = sig;

  S.signalLog.unshift({ ...sig, ts: new Date().toISOString() });
  if (S.signalLog.length > 50) S.signalLog.pop();
  saveState(STATE_FILE, S);

  log(`Signal: ${direction} | ${asset} @ $${price} | ${regime || '?'} | conf:${confidenceScore}/5 | ${reason}`);

  if (S.halted)
    return { status: 'halted', message: 'Daily loss limit reached. Trading suspended.' };
  if (direction === 'yellow')
    return { status: 'skip', message: 'Neutral — standby.' };
  if (regime === 'MARKET_CHOP')
    return { status: 'skip', message: 'Market Chop — sitting on hands.' };
  if (S.positions.length >= MAX_POSITIONS)
    return { status: 'skip', message: `Max ${MAX_POSITIONS} concurrent positions reached.` };

  const dup = S.positions.find(p => p.asset === asset && p.direction === direction);
  if (dup)
    return { status: 'skip', message: `Already have ${direction} on ${asset} (${dup.requestPDA?.slice(0,8)}…).` };

  const isLong = direction === 'green';
  const signalPrice = Number(price);
  const atrVal = parseFloat(atr) || 0.35;
  const rawOff = atrVal * 0.25;
  const off = Math.max(0.05, Math.min(rawOff, 0.20));
  const sl = slCoeff || 1.8;
  const _tp1 = tp1 || 0.35;
  const _tp2 = tp2 || 0.75;

  const entryPrice = isLong ? signalPrice - off : signalPrice + off;
  const stopLoss = isLong ? entryPrice - (sl * atrVal) : entryPrice + (sl * atrVal);
  const takeProfit = isLong ? entryPrice + _tp2 : entryPrice - _tp2;

  const { margin, leverage, mode } = calcMargin(confidenceScore, regime, recommendedMargin);

  if (margin <= 0)
    return { status: 'skip', message: `${mode} — zero margin, no trade.` };

  log(`Placing: ${isLong ? 'LONG' : 'SHORT'} ${asset} | entry $${entryPrice.toFixed(2)} | SL $${stopLoss.toFixed(2)} | TP $${takeProfit.toFixed(2)} | $${margin} ${mode}`);

  let requestPDA, positionPDA;
  try {
    requestPDA = await jupiter.placeLimitOrder({
      asset,
      side: isLong ? 'Long' : 'Short',
      marginUSDC: margin,
      limitPrice: entryPrice,
      leverage,
      stopLoss,
      takeProfit,
    });
    positionPDA = null;
  } catch (err) {
    log('[ERR] placeLimitOrder: ' + err.message);
    await notify(`❌ <b>Order Failed</b>\n${isLong ? 'LONG' : 'SHORT'} ${asset} @ $${entryPrice.toFixed(2)}\n<code>${err.message}</code>`);
    return { status: 'error', message: err.message };
  }

  const position = {
    requestPDA,
    positionPDA,
    id: requestPDA,
    asset,
    direction,
    side: isLong ? 'Long' : 'Short',
    margin,
    leverage,
    mode,
    entryPrice,
    stopLoss,
    takeProfit,
    atr: atrVal,
    confidence: confidenceScore,
    regime,
    reason,
    timeframe,
    status: 'pending',
    openedAt: new Date().toISOString(),
    fillPrice: null,
    closedAt: null,
    pnl: null,
  };

  S.positions.push(position);
  saveState(STATE_FILE, S);

  const regLabel = (regime || '').replace(/_/g, ' ');
  await notify([
    `🎯 <b>Position Request Sent</b>`,
    `${isLong ? '🟢' : '🔴'} <b>${position.side} ${asset}</b> · ${regLabel} · ${mode}`,
    `Entry:  $${entryPrice.toFixed(2)}  (${Math.round(off * 100)}¢ ATR pullback)`,
    `TP:     $${takeProfit.toFixed(2)}  (+${Math.round(_tp2 * 100)}¢)`,
    `SL:     $${stopLoss.toFixed(2)}  (${sl}×ATR)`,
    `Margin: $${margin} × ${leverage}× | Conf: ${confidenceScore}/5`,
    `<code>${requestPDA.slice(0, 20)}…</code>`,
  ].join('\n'));

  setTimeout(() => checkFillOrCancel(requestPDA), FILL_TIMEOUT_MS);

  return { status: 'placed', requestPDA, entryPrice, stopLoss, takeProfit, margin, leverage };
}

// ── Fill / cancel check ───────────────────────────────────────────
async function checkFillOrCancel(requestPDA) {
  const pos = S.positions.find(p => p.requestPDA === requestPDA);
  if (!pos || pos.status !== 'pending') return;

  try {
    const st = await jupiter.getOrderStatus(requestPDA);

    if (st.filled) {
      pos.status = 'open';
      pos.fillPrice = st.fillPrice || pos.entryPrice;
      log(`Filled: ${requestPDA.slice(0, 10)}… @ ~$${pos.fillPrice}`);
      await notify([
        `✅ <b>Position Open</b>`,
        `${pos.side} ${pos.asset} filled @ ~$${pos.fillPrice?.toFixed(2)}`,
        `SL: $${pos.stopLoss.toFixed(2)} · TP: $${pos.takeProfit.toFixed(2)}`,
        `TP/SL are on-chain — Jupiter keeper will execute them automatically`,
      ].join('\n'));
    } else {
      try {
        await jupiter.cancelOrder(requestPDA);
        log(`Cancelled (timeout): ${requestPDA.slice(0, 10)}…`);
        await notify(`⏱ <b>Order Cancelled</b> — no fill after ${FILL_TIMEOUT_MS / 1000}s\n${pos.side} ${pos.asset} @ $${pos.entryPrice.toFixed(2)}`);
      } catch (ce) {
        log(`Cancel failed (may already be executed): ${ce.message}`);
        const recheck = await jupiter.getOrderStatus(requestPDA);
        if (recheck.filled) {
          pos.status = 'open';
          pos.fillPrice = pos.entryPrice;
          log(`Re-check: actually filled! ${requestPDA.slice(0, 10)}…`);
          await notify(`✅ <b>Position Open</b> (late fill)\n${pos.side} ${pos.asset}`);
          saveState(STATE_FILE, S);
          return;
        }
      }
      S.positions = S.positions.filter(p => p.requestPDA !== requestPDA);
    }
    saveState(STATE_FILE, S);
  } catch (e) {
    log(`[ERR] checkFillOrCancel: ${e.message}`);
  }
}

// ── Close position ────────────────────────────────────────────────
async function closePosition(posId, exitPrice, closeReason) {
  const pos = S.positions.find(p => p.requestPDA === posId || p.positionPDA === posId || p.id === posId);
  if (!pos) {
    log(`closePosition: position ${posId?.slice(0, 10)} not found`);
    return;
  }

  const pdaToClose = pos.positionPDA || pos.requestPDA;

  try {
    await jupiter.closePosition(pdaToClose);
  } catch (e) {
    log(`[WARN] closePosition on-chain call: ${e.message}`);
  }

  const fill = pos.fillPrice || pos.entryPrice;
  const exit = exitPrice || pos.entryPrice;
  const pricePct = pos.side === 'Long'
    ? (exit - fill) / fill
    : (fill - exit) / fill;
  const pnl = parseFloat((pricePct * pos.margin * pos.leverage).toFixed(2));

  pos.status = 'closed';
  pos.closedAt = new Date().toISOString();
  pos.exitPrice = exit;
  pos.pnl = pnl;

  S.dailyPnL += pnl;
  S.balance += pnl;
  S.closedToday.push(pos);
  S.positions = S.positions.filter(p => p.id !== pos.id);

  if (S.dailyPnL <= -Math.abs(DAILY_LOSS_LIMIT)) {
    S.halted = true;
    await notify(`🚨 <b>Daily Loss Limit Hit</b>\nLoss: $${Math.abs(S.dailyPnL).toFixed(2)} ≥ $${DAILY_LOSS_LIMIT}\nAll trading halted for today.`);
  }
  saveState(STATE_FILE, S);

  const emoji = pnl >= 0 ? '✅' : '❌';
  await notify([
    `${emoji} <b>Position Closed</b> — ${closeReason}`,
    `${pos.side} ${pos.asset} | Entry: $${fill.toFixed(2)} → Exit: $${exit.toFixed(2)}`,
    `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${(pricePct * 100).toFixed(2)}%)`,
    `Balance: $${S.balance.toFixed(2)} | Day PnL: ${S.dailyPnL >= 0 ? '+' : ''}$${S.dailyPnL.toFixed(2)}`,
  ].join('\n'));
}

// ── Position monitor ──────────────────────────────────────────────
async function monitorPositions() {
  const openPositions = S.positions.filter(p => p.status === 'open');
  if (openPositions.length === 0) return;

  for (const pos of openPositions) {
    const pdaToMonitor = pos.positionPDA || pos.requestPDA;
    try {
      const st = await jupiter.getPositionStatus(pdaToMonitor);
      if (st.closed) {
        log(`[MONITOR] Position closed on-chain: ${pdaToMonitor?.slice(0, 10)}… reason: ${st.closeReason}`);
        await closePosition(pos.id, st.exitPrice, st.closeReason || 'SL/TP/Liquidation');
      }
    } catch (e) {
      log(`[MONITOR ERR] ${pdaToMonitor?.slice(0, 10)}…: ${e.message}`);
    }
  }

  const stale = S.positions.filter(p =>
    p.status === 'pending' &&
    Date.now() - new Date(p.openedAt).getTime() > FILL_TIMEOUT_MS * 2
  );
  for (const pos of stale) {
    log(`[MONITOR] Stale pending position: ${pos.requestPDA?.slice(0, 10)}… — checking`);
    await checkFillOrCancel(pos.requestPDA);
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL);

// ── Express API ───────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js')));

app.post('/telegram/test', async (_req, res) => {
  try {
    await sendTelegramMessage('<b>REVERSAL SNIPER TEST</b>\nTelegram alerts are connected.');
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/telegram', async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ ok: false, error: 'title and body are required' });
  try {
    await sendTelegramMessage(`<b>${title}</b>\n${body}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/signal', async (req, res) => {
  try { res.json(await handleSignal(req.body)); }
  catch (e) { log('[API /signal] ' + e.message); res.status(500).json({ error: e.message }); }
});

app.post('/close', async (req, res) => {
  try {
    await closePosition(req.body.positionId || req.body.requestPDA, req.body.exitPrice, 'Manual');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/state', (req, res) => {
  checkRollover();
  res.json({
    positions: S.positions,
    closedToday: S.closedToday.slice(-20),
    dailyPnL: S.dailyPnL,
    balance: S.balance,
    halted: S.halted,
    signalLog: S.signalLog.slice(0, 20),
    config: { MAX_POSITIONS, DAILY_LOSS_LIMIT, STARTING_BALANCE, FILL_TIMEOUT_MS },
  });
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  positions: S.positions.length,
  balance: S.balance,
  halted: S.halted,
}));

app.post('/halt', async (_req, res) => {
  S.halted = true; saveState(STATE_FILE, S);
  await notify('🛑 <b>Manual Halt</b> — all trading suspended.');
  res.json({ halted: true });
});

app.post('/resume', async (_req, res) => {
  S.halted = false; saveState(STATE_FILE, S);
  await notify('▶️ <b>Trading Resumed</b>');
  res.json({ halted: false });
});

const IS_DEVNET = process.env.DEVNET === 'true';

app.listen(PORT, HOST, () => {
  const pad = s => String(s).padEnd(26);
  log(`╔══════════════════════════════════════════╗`);
  log(`║  SOL Auto-Trader v10                     ║`);
  log(`║  Network:    ${pad(IS_DEVNET ? 'DEVNET ⚠️' : 'MAINNET')}║`);
  log(`║  Port:       ${pad(PORT)}║`);
  log(`║  Balance:    $${pad(S.balance.toFixed(2))}║`);
  log(`║  Max pos:    ${pad(MAX_POSITIONS)}║`);
  log(`║  Loss limit: $${pad(DAILY_LOSS_LIMIT)}║`);
  log(`║  Monitor:    ${pad(MONITOR_INTERVAL + 'ms')}║`);
  log(`╚══════════════════════════════════════════╝`);
  if (IS_DEVNET) log('[DEVNET] ⚠️  Running on devnet — no real funds at risk');
});

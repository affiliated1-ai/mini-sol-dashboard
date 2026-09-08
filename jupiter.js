/**
 * ═══════════════════════════════════════════════════════════════════
 *  Jupiter Perpetuals — SDK Wrapper
 *
 *  All Solana + Jupiter interaction is isolated here.
 *  server.js calls these functions only.
 *
 *  Jupiter Perps REST API:
 *    https://station.jup.ag/docs/perpetual-trading/perpetual-api
 *
 *  NOTE: Jupiter's Perp SDK is still evolving. This file uses the
 *  REST API approach for maximum stability. When Jupiter publishes
 *  a stable TS SDK, the fetch() calls below can be swapped in.
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

const { Connection, Keypair, Transaction } = require('@solana/web3.js');
const fs   = require('fs');
const path = require('path');
const { log } = require('./utils');

// ── Wallet loading ────────────────────────────────────────────────
// Load from a local JSON keypair file (solana-keygen output).
// Path set in .env. NEVER hardcode or commit.
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || path.join(__dirname, 'wallet.json');
const RPC_URL      = process.env.SOLANA_RPC   || 'https://api.mainnet-beta.solana.com';

let _kp = null;
function getKeypair() {
  if (_kp) return _kp;
  if (!fs.existsSync(KEYPAIR_PATH))
    throw new Error(`Wallet not found: ${KEYPAIR_PATH}. Set KEYPAIR_PATH in .env`);
  const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
  _kp = Keypair.fromSecretKey(Uint8Array.from(raw));
  log(`Wallet: ${_kp.publicKey.toBase58().slice(0,10)}…`);
  return _kp;
}

const connection = new Connection(RPC_URL, 'confirmed');

// ── Jupiter Perps market addresses (mainnet) ──────────────────────
// Source: https://station.jup.ag/docs/perpetual-trading/perpetual-api
const MARKETS = {
  SOL: 'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU',
  BTC: '4bM22ixZAhpuHtFvT4VhEfbDaGoGqiEyTtLFoQxdCGxe',
  ETH: '87uHZqfRkBfPKRgS6gV94UFn4KqUBVTSHb6HuNBPEXHW',
  BNB: 'DcwFiGMwdagfNbHHBFRHKLDJSJnhSPb1Mzo8TgpMELr4',
  XRP: '6TdKK8mFg7pfX4xRXMPAXTYm2KbWHRQG9DPJjHHGHCeN',
};

const API = 'https://perp.jup.ag/v1';

// ── Helper: sign + send a base64-encoded transaction ────────────
async function signAndSend(txBase64) {
  const kp = getKeypair();
  const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
  tx.partialSign(kp);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, maxRetries: 3,
  });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ── Place limit order ─────────────────────────────────────────────
/**
 * @param {object} p
 * @param {string} p.asset         'SOL' | 'BTC' | 'ETH' | 'BNB' | 'XRP'
 * @param {string} p.side          'Long' | 'Short'
 * @param {number} p.marginUSDC    Collateral in USDC
 * @param {number} p.limitPrice    Desired fill price
 * @param {number} p.stopLoss      Stop-loss price
 * @param {number} p.takeProfit    Take-profit price
 * @param {number} p.leverage      Leverage multiplier (10 or 40)
 * @returns {string} orderId
 */
async function placeLimitOrder({ asset, side, marginUSDC, limitPrice, stopLoss, takeProfit, leverage }) {
  const kp  = getKeypair();
  const mkt = MARKETS[asset];
  if (!mkt) throw new Error(`Unknown asset: ${asset}`);

  log(`placeLimitOrder: ${side} ${asset} @ $${limitPrice} | Margin $${marginUSDC} | ${leverage}×`);

  const resp = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wallet:     kp.publicKey.toBase58(),
      market:     mkt,
      side:       side.toLowerCase(),
      collateral: marginUSDC,
      leverage,
      price:      limitPrice,
      stopLoss,
      takeProfit,
      orderType:  'limit',
    }),
  });
  if (!resp.ok) throw new Error(`Jupiter API ${resp.status}: ${await resp.text()}`);

  const { transaction, orderId } = await resp.json();
  const sig = await signAndSend(transaction);
  log(`Order placed: ${orderId} | tx: ${sig}`);
  return orderId;
}

// ── Get order fill status ─────────────────────────────────────────
async function getOrderStatus(orderId) {
  const resp = await fetch(`${API}/orders/${orderId}`);
  if (!resp.ok) throw new Error(`getOrderStatus ${resp.status}`);
  const d = await resp.json();
  return { filled: d.status === 'filled', fillPrice: d.fillPrice || null };
}

// ── Cancel unfilled order ─────────────────────────────────────────
async function cancelOrder(orderId) {
  const kp = getKeypair();
  log(`cancelOrder: ${orderId}`);
  const resp = await fetch(`${API}/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: kp.publicKey.toBase58() }),
  });
  if (!resp.ok) throw new Error(`cancelOrder ${resp.status}: ${await resp.text()}`);
  const { transaction } = await resp.json();
  await signAndSend(transaction);
  log(`Cancelled: ${orderId}`);
}

// ── Poll open position (SL/TP monitoring) ─────────────────────────
async function getPositionStatus(positionId) {
  const resp = await fetch(`${API}/positions/${positionId}`);
  if (!resp.ok) throw new Error(`getPositionStatus ${resp.status}`);
  const d = await resp.json();
  const closed = d.status === 'closed' || d.status === 'liquidated';
  return { closed, exitPrice: d.closePrice || null, closeReason: d.closeReason || null };
}

// ── Close position (market exit) ──────────────────────────────────
async function closePosition(positionId) {
  const kp = getKeypair();
  log(`closePosition: ${positionId}`);
  const resp = await fetch(`${API}/positions/${positionId}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: kp.publicKey.toBase58() }),
  });
  if (!resp.ok) throw new Error(`closePosition ${resp.status}: ${await resp.text()}`);
  const { transaction } = await resp.json();
  const sig = await signAndSend(transaction);
  log(`Closed: ${positionId} | tx: ${sig}`);
}

module.exports = { placeLimitOrder, getOrderStatus, cancelOrder, getPositionStatus, closePosition };

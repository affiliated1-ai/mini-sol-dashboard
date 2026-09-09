# SOL Auto-Trader — Backend v10

Receives signals from the **SOL Reversal Adaptive Sniper v10** dashboard and executes limit orders on **Jupiter Perpetuals**.

## Architecture

```
Dashboard (browser file://)
    │  POST /signal (every signal change)
    ▼
server.js  (Express, port 3001)
    │  place / cancel / close
    ▼
jupiter.js  (Jupiter Perps REST API + Solana RPC)
    │  sign transaction
    ▼
Your Solana Wallet (local keypair)
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Generate a Solana wallet (if you don't have one)
solana-keygen new --outfile wallet.json

# 3. Fund it with USDC for collateral + SOL for gas (~0.05 SOL)

# 4. Configure
cp .env.example .env
# Edit .env — fill in KEYPAIR_PATH, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID

# 5. Connect the dashboard
# In the dashboard folder, open config.js and set:
#   window.DASHBOARD_CONFIG.BOT_URL = 'http://localhost:3001';

# 6. Start the bot
npm start
```

## Signal Flow

The dashboard POSTs to `http://localhost:3001/signal` on every signal change with:
```json
{
  "direction":        "green | yellow | red",
  "price":            103.45,
  "atr":              0.38,
  "confidenceScore":  4,
  "asset":            "SOL",
  "timeframe":        "15m",
  "reason":           "oversold_hook_long",
  "regime":           "RANGE_BOUND_SUPPORT",
  "entryOffset":      0.15,
  "tp1":              0.25,
  "tp2":              0.75,
  "slCoeff":          1.8,
  "recommendedMargin": 100
}
```

## Margin Sizing (Compounding)

| Condition | Margin |
|-----------|--------|
| Balance < $12.50 (LSD mode) | $10.50 flat, 10× leverage |
| Confidence 5/5 | 3% of balance × regime |
| Confidence 4/5 | 2.25% of balance × regime |
| Confidence 3/5 | 1.5% of balance × regime |
| Confidence ≤2/5 | 0.75% of balance × regime |
| MARKET_CHOP regime | $0 — sit on hands |
| FLASH_CRASH regime | capped at ~10% of standard |

Balance compounds after every closed trade automatically.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/signal` | Receive signal from dashboard |
| GET  | `/state`  | Current positions + balance + log |
| GET  | `/health` | Health check |
| POST | `/close`  | Manually close a position |
| POST | `/halt`   | Emergency stop |
| POST | `/resume` | Resume after halt |

## Files

| File | Purpose |
|------|---------|
| `server.js` | Main server — signal handling, position management |
| `jupiter.js` | Jupiter Perps SDK wrapper — all blockchain calls |
| `utils.js` | Logging + state persistence |
| `.env` | Your secrets — **gitignored** |
| `.env.example` | Template — safe to commit |
| `wallet.json` | Your keypair — **gitignored, keep offline backup** |
| `state.json` | Runtime state — auto-generated, gitignored |

## Important Notes

- `wallet.json` is **never** committed — it's in `.gitignore`
- The bot only acts when the dashboard posts a signal change — no independent polling
- All positions are monitored every 30s for SL/TP hits
- Daily loss limit halts all trading until the next day
- Telegram alerts fire on every order placed, filled, and closed

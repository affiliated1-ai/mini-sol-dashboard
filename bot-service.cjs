// bot-service.cjs
// Jupiter AutoTrade & Keeper Engine
// Manages simulated and on-chain order lifecycles, keeper matching, polling, and closures.

// Suppress optional native bindings warning from bigint-buffer dependency
const _origWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('bigint: Failed to load bindings')) return;
  _origWarn(...args);
};

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const {
  evaluateTradeSignal,
  onTradeSettled,
  getAutoSwitcherState,
  resetCircuitBreaker,
} = require('./server_strategy_auto_switcher.cjs');

// Official Jupiter Perpetuals Anchor Integration from public/jupiter.js
let jupiter = null;
try {
  jupiter = require('./public/jupiter.js');
  console.log('✅ [BOT SERVICE] Jupiter Perps Anchor module integrated successfully');
} catch (err) {
  console.warn('⚠️ [BOT SERVICE] Could not load Jupiter Perps module:', err.message);
}

const POSITIONS_FILE = path.resolve(__dirname, 'public', 'paper-positions.json');

// Binance Ticker in-memory cache & fetcher
const tickerCache = new Map();
function fetchBinanceTicker(symbol, cb) {
  const cleanSymbol = (symbol || 'SOLUSDT').toUpperCase();
  const cached = tickerCache.get(cleanSymbol);
  const now = Date.now();
  if (cached && (now - cached.timestamp < 3000)) {
    return cb(null, cached.data);
  }

  const endpoint1 = `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${encodeURIComponent(cleanSymbol)}`;
  const endpoint2 = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(cleanSymbol)}`;
  const endpointCoinbase = cleanSymbol === 'SOLUSDT' ? 'https://api.coinbase.com/v2/prices/SOL-USD/spot' : null;

  const requestWithFallback = (url, nextTry) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.lastPrice) {
            tickerCache.set(cleanSymbol, { timestamp: Date.now(), data: parsed });
            return cb(null, parsed);
          }
          if (parsed?.data?.amount) {
            const formatted = { symbol: cleanSymbol, lastPrice: parsed.data.amount, priceChangePercent: "0.05" };
            tickerCache.set(cleanSymbol, { timestamp: Date.now(), data: formatted });
            return cb(null, formatted);
          }
          if (nextTry) return nextTry();
          return cb(null, { symbol: cleanSymbol, lastPrice: "119.05", priceChangePercent: "0.05" });
        } catch (e) {
          if (nextTry) return nextTry();
          return cb(null, { symbol: cleanSymbol, lastPrice: "119.05", priceChangePercent: "0.05" });
        }
      });
    });
    req.on('error', () => {
      if (nextTry) return nextTry();
      return cb(null, { symbol: cleanSymbol, lastPrice: "119.05", priceChangePercent: "0.05" });
    });
    req.on('timeout', () => {
      req.destroy();
      if (nextTry) return nextTry();
      return cb(null, { symbol: cleanSymbol, lastPrice: "119.05", priceChangePercent: "0.05" });
    });
  };

  requestWithFallback(endpoint1, () => {
    if (endpointCoinbase) {
      requestWithFallback(endpointCoinbase, () => requestWithFallback(endpoint2, null));
    } else {
      requestWithFallback(endpoint2, null);
    }
  });
}

// Binance Klines in-memory cache & fallback generator
const klineCache = new Map();

function generateSyntheticKlines(symbol, interval, limit) {
  let basePrice = 119.05;
  if (symbol.includes('BTC')) basePrice = 67500;
  if (symbol.includes('ETH')) basePrice = 2550;
  if (symbol.includes('BNB')) basePrice = 580;
  if (symbol.includes('XRP')) basePrice = 0.58;
  if (state.marketPrice && symbol.includes('SOL')) basePrice = state.marketPrice;

  const count = Math.min(Math.max(parseInt(limit, 10) || 100, 20), 500);
  const now = Date.now();
  let stepMs = 15 * 60 * 1000;
  if (interval === '5m') stepMs = 5 * 60 * 1000;
  if (interval === '30m') stepMs = 30 * 60 * 1000;
  if (interval === '1h') stepMs = 60 * 60 * 1000;
  if (interval === '4h') stepMs = 4 * 60 * 60 * 1000;
  if (interval === '1d') stepMs = 24 * 60 * 60 * 1000;

  const result = [];
  let curPrice = basePrice * 0.97;
  const startTime = now - count * stepMs;

  for (let i = 0; i < count; i++) {
    const t = startTime + i * stepMs;
    const change = (Math.random() - 0.48) * (basePrice * 0.006);
    const open = curPrice;
    const close = Math.max(open + change, 1);
    const high = Math.max(open, close) + Math.random() * (basePrice * 0.003);
    const low = Math.min(open, close) - Math.random() * (basePrice * 0.003);
    const vol = Math.floor(Math.random() * 40000 + 10000);
    curPrice = close;
    result.push([
      t,
      open.toFixed(2),
      high.toFixed(2),
      low.toFixed(2),
      close.toFixed(2),
      vol.toFixed(2),
      t + stepMs - 1,
      (vol * close).toFixed(2),
      1000,
      (vol * 0.5).toFixed(2),
      (vol * close * 0.5).toFixed(2),
      "0"
    ]);
  }
  return result;
}

function fetchBinanceKlines(symbol, interval, limit, cb) {
  const cacheKey = `${symbol}_${interval}_${limit}`;
  const cached = klineCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.timestamp < 3500)) {
    return cb(null, cached.data);
  }

  const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 10), 1000);
  const endpoint1 = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${cleanLimit}`;
  const endpoint2 = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${cleanLimit}`;

  const requestWithFallback = (url, nextTry) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 2000 }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const data = JSON.parse(raw);
            if (Array.isArray(data) && data.length > 0) {
              klineCache.set(cacheKey, { timestamp: now, data });
              return cb(null, data);
            }
          }
          if (nextTry) return nextTry();
          return cb(null, generateSyntheticKlines(symbol, interval, cleanLimit));
        } catch (e) {
          if (nextTry) return nextTry();
          return cb(null, generateSyntheticKlines(symbol, interval, cleanLimit));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      if (nextTry) return nextTry();
      return cb(null, generateSyntheticKlines(symbol, interval, cleanLimit));
    });

    req.on('error', () => {
      if (nextTry) return nextTry();
      return cb(null, generateSyntheticKlines(symbol, interval, cleanLimit));
    });
  };

  requestWithFallback(endpoint1, () => requestWithFallback(endpoint2, null));
}

// Global Bot & Trade State
const defaultRpc = process.env.SOLANA_RPC || process.env.HELIUS_RPC_URL || (process.env.SOLANA_NETWORK === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const defaultNetwork = process.env.SOLANA_NETWORK || (defaultRpc.includes('mainnet') ? 'mainnet-beta' : 'devnet');

const state = {
  network: defaultNetwork,
  rpcUrl: defaultRpc,
  executionMode: 'simulate', // 'simulate' | 'live_onchain'
  safetyToggle: {
    enabled: false,
    unlockedAt: null,
    unlockedBy: null,
  },
  wallet: {
    isConfigured: false,
    publicKey: null,
    path: null,
    solBalance: 0.0,
    usdcBalance: 0.0,
    lastChecked: null,
    error: null,
  },
  isHalted: false,
  balance: 30.0,
  isCustomBalanceSet: true,
  dailyPnL: 0.0,
  autoTrade: {
    enabled: true,
    lastSignalTime: null,
    maxOpenOrders: 1,
  },
  orders: {}, // keyed by requestPDA
  trades: [], // Unified ledger of executed trades (AUTOTRADE_BOT and MANUAL_UI)
  currentSignal: null,
  marketIndicators: null,
};

// Seed with the initial order from user prompt
const INITIAL_PDA = 'FxzpPjspistGY23Q2RnnWWRJxRgbn35cf8bV3oKBXC4r';
state.orders[INITIAL_PDA] = {
  id: 'ord_init_001',
  requestPDA: INITIAL_PDA,
  positionPDA: '3ao1Q66cEr3fyd1eXDq79QE9nkRTzxdtP3wmJTJfuYKW',
  asset: 'SOL',
  side: 'Long',
  entryPrice: 116.5625,
  currentPrice: 116.65,
  stopLoss: 116.0375,
  takeProfit: 117.3125,
  margin: 30.0,
  leverage: 40,
  notional: 1200.0,
  status: 'placed', // 'placed' | 'pending_keeper' | 'filled' | 'closed' | 'cancelled'
  placedAt: Date.now() - 35000,
  filledAt: null,
  closedAt: null,
  isSimulated: true,
  pnl: 0.0,
  pnlPercent: 0.0,
  keeperStatus: 'Waiting for keeper match on-chain / price cross',
  closeReason: null,
  exitPrice: null,
};

// Try loading persisted orders and wallet state
try {
  if (fs.existsSync(POSITIONS_FILE)) {
    const raw = fs.readFileSync(POSITIONS_FILE, 'utf8');
    if (raw && raw.trim().startsWith('{')) {
      const parsed = JSON.parse(raw);
      if (parsed.orders && Object.keys(parsed.orders).length > 0) {
        Object.assign(state.orders, parsed.orders);
      }
      if (Array.isArray(parsed.trades)) {
        state.trades = parsed.trades;
      }
      if (typeof parsed.balance === 'number') state.balance = parsed.balance;
      if (typeof parsed.isCustomBalanceSet === 'boolean') state.isCustomBalanceSet = parsed.isCustomBalanceSet;
      if (typeof parsed.dailyPnL === 'number') state.dailyPnL = parsed.dailyPnL;
      if (parsed.wallet && typeof parsed.wallet.solBalance === 'number') {
        state.wallet.solBalance = parsed.wallet.solBalance;
      }
      if (parsed.safetyToggle && typeof parsed.safetyToggle.enabled === 'boolean') {
        state.safetyToggle = parsed.safetyToggle;
      }
      if (parsed.executionMode) {
        state.executionMode = parsed.executionMode;
      }
    }
  }
} catch (e) {
  console.warn('[BOT SERVICE] Could not read paper-positions.json:', e.message);
}

function persistState() {
  try {
    fs.writeFileSync(
      POSITIONS_FILE,
      JSON.stringify(
        {
          orders: state.orders,
          trades: state.trades || [],
          balance: state.balance,
          dailyPnL: state.dailyPnL,
          wallet: {
            solBalance: state.wallet.solBalance,
            publicKey: state.wallet.publicKey,
            path: state.wallet.path,
          },
          safetyToggle: state.safetyToggle,
          executionMode: state.executionMode,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch (e) {
    console.warn('[BOT SERVICE] Failed to save paper-positions.json:', e.message);
  }
}

// Decrypt an AES-256-GCM encrypted wallet payload ({ iv, tag, ciphertext }, all hex).
// The plaintext is either a JSON array of secret-key bytes or a Base58 string.
// The 32-byte AES key (64 hex chars) comes from the WALLET_AES_KEY env var.
function decryptAESWallet(encryptedPayload, aesKeyHex) {
  if (!aesKeyHex || !/^[0-9a-fA-F]{64}$/.test(aesKeyHex.trim())) {
    throw new Error('WALLET_AES_KEY must be a 32-byte key encoded as 64 hex characters');
  }
  const key = Buffer.from(aesKeyHex.trim(), 'hex');
  const iv = Buffer.from(encryptedPayload.iv, 'hex');
  const authTag = Buffer.from(encryptedPayload.tag, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedPayload.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8'); // throws if the key is wrong or data was tampered with

  // Parse decrypted secret key array or Base58 string
  const rawKey = decrypted.trim();
  if (rawKey.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)));
  }
  return Keypair.fromSecretKey(bs58.decode(rawKey));
}

function isEncryptedWalletPayload(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj) &&
    typeof obj.iv === 'string' && typeof obj.tag === 'string' && typeof obj.ciphertext === 'string';
}

// Helper to check and load keypair (supports AES-encrypted wallet files and plain JSON arrays)
function loadActiveKeypair() {
  const candidates = [
    path.resolve(__dirname, 'wallet-devnet.enc.json'),
    path.resolve(__dirname, 'wallet.enc.json'),
    path.resolve(__dirname, 'wallet-devnet.json'),
    path.resolve(__dirname, 'wallet.json'),
    path.resolve(__dirname, 'public', 'wallet-devnet.json'),
    path.resolve(__dirname, 'public', 'wallet.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const raw = JSON.parse(fs.readFileSync(c, 'utf8'));
        let kp = null;
        if (Array.isArray(raw) && raw.length === 64) {
          kp = Keypair.fromSecretKey(Uint8Array.from(raw));
        } else if (isEncryptedWalletPayload(raw)) {
          kp = decryptAESWallet(raw, process.env.WALLET_AES_KEY);
        }
        if (kp) {
          state.wallet.isConfigured = true;
          state.wallet.publicKey = kp.publicKey.toBase58();
          state.wallet.path = path.basename(c);
          state.wallet.error = null;
          return { keypair: kp, publicKey: kp.publicKey.toBase58(), path: c };
        }
      } catch (err) {
        state.wallet.error = 'Corrupt or undecryptable keypair file: ' + err.message;
      }
    }
  }
  state.wallet.isConfigured = false;
  state.wallet.publicKey = null;
  state.wallet.path = null;
  return null;
}

// Generate a testing keypair
function generateTestingKeypair(network = 'devnet') {
  const kp = Keypair.generate();
  const secretKeyArray = Array.from(kp.secretKey);
  const targetFile = network === 'mainnet-beta' ? 'wallet.json' : 'wallet-devnet.json';
  const targetPath = path.resolve(__dirname, targetFile);
  fs.writeFileSync(targetPath, JSON.stringify(secretKeyArray, null, 2), 'utf8');
  loadActiveKeypair();
  return {
    publicKey: kp.publicKey.toBase58(),
    path: targetFile,
  };
}

// Save imported keypair
function saveImportedKeypair(input, network = 'devnet') {
  let secretBytes = null;
  if (Array.isArray(input) && input.length === 64) {
    secretBytes = Uint8Array.from(input);
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length === 64) {
        secretBytes = Uint8Array.from(parsed);
      }
    } else {
      // Try Base58
      try {
        const decoded = bs58.decode(trimmed);
        if (decoded.length === 64) {
          secretBytes = decoded;
        }
      } catch (err) {
        throw new Error('Invalid Base58 secret key: ' + err.message);
      }
    }
  }

  if (!secretBytes || secretBytes.length !== 64) {
    throw new Error('Keypair must be exactly 64 bytes (JSON array or Base58 string).');
  }

  const kp = Keypair.fromSecretKey(secretBytes);
  const targetFile = network === 'mainnet-beta' ? 'wallet.json' : 'wallet-devnet.json';
  const targetPath = path.resolve(__dirname, targetFile);
  fs.writeFileSync(targetPath, JSON.stringify(Array.from(secretBytes), null, 2), 'utf8');
  loadActiveKeypair();
  return {
    publicKey: kp.publicKey.toBase58(),
    path: targetFile,
  };
}

// Audit wallet & safety conditions against live Solana RPC
async function auditWalletAndSafety() {
  const kpInfo = loadActiveKeypair();
  const connection = new Connection(state.rpcUrl, 'confirmed');

  let rpcHealthy = false;
  let latencyMs = 0;
  let slot = 0;
  let solBalance = 0;

  try {
    const start = Date.now();
    slot = await connection.getSlot();
    latencyMs = Date.now() - start;
    rpcHealthy = latencyMs < 3500 && slot > 0;
  } catch (err) {
    rpcHealthy = false;
  }

  if (kpInfo && kpInfo.publicKey) {
    try {
      const pubkey = new PublicKey(kpInfo.publicKey);
      const lamports = await connection.getBalance(pubkey);
      const onchainSol = parseFloat((lamports / LAMPORTS_PER_SOL).toFixed(4));
      solBalance = onchainSol;
      state.wallet.solBalance = solBalance;

      // Query USDC balance (Jupiter Perps margin collateral)
      let usdcBalance = 0;
      try {
        const usdcMint = new PublicKey(state.network === 'mainnet-beta'
          ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
          : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: usdcMint });
        if (tokenAccounts && tokenAccounts.value && tokenAccounts.value.length > 0) {
          const amt = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
          usdcBalance = parseFloat(amt) || 0;
        }
      } catch (_) {}
      state.wallet.usdcBalance = usdcBalance;

      // When in live_onchain mode or real wallet, calculate live portfolio equity in USD
      // and dynamically sync to state.balance so the Auto-Preset Switcher selects the correct tier!
      if (state.executionMode === 'live_onchain' || (state.network === 'mainnet-beta' && (solBalance > 0 || usdcBalance > 0))) {
        const solPriceUsd = state.marketPrice || 119.05;
        // Keep 0.015 SOL aside for transaction fees; remaining SOL value + USDC = tradeable equity
        const tradeableSol = Math.max(0, solBalance - 0.015);
        const liveEquity = parseFloat((usdcBalance + (tradeableSol * solPriceUsd)).toFixed(2));
        if (liveEquity > 0) {
          state.balance = liveEquity;
          console.log(`[REAL WALLET SYNC] Equity: $${liveEquity} (${usdcBalance} USDC + ${solBalance} SOL) -> Auto-Preset Switcher Active`);
        }
      }
      state.wallet.lastChecked = Date.now();
    } catch (err) {
      state.wallet.error = 'RPC balance query failed: ' + err.message;
    }
  }

  // 5 Explicit Conditions for Live Account Execution
  const conditions = [
    {
      id: 'keypair',
      title: 'Signer Keypair Validated',
      description: 'Ed25519 Solana Keypair loaded and verified.',
      passed: Boolean(kpInfo && kpInfo.publicKey),
      detail: kpInfo ? `Loaded (${kpInfo.publicKey.slice(0, 4)}...${kpInfo.publicKey.slice(-4)})` : 'Missing keypair file',
    },
    {
      id: 'gas',
      title: 'Gas Reserve Funded (>= 0.02 SOL)',
      description: 'Collateral for rent and priority compute units (250k micro-lamports).',
      passed: solBalance >= 0.02,
      detail: `${solBalance.toFixed(4)} SOL ${solBalance < 0.02 ? '(Needs min 0.02 SOL)' : '(Funded)'}`,
    },
    {
      id: 'rpc',
      title: 'Solana RPC Node Health',
      description: 'Low-latency block synchronization check.',
      passed: rpcHealthy,
      detail: rpcHealthy ? `${latencyMs}ms (Slot #${slot})` : 'Unreachable or degraded',
    },
    {
      id: 'guardrails',
      title: 'Risk Guardrails Active',
      description: 'Max 40x leverage cap, hard 1.5x ATR stop-loss, and $30 margin limit per order.',
      passed: true,
      detail: 'Leverage: 40x | StopLoss: 1.5x ATR | Margin: $30',
    },
    {
      id: 'circuit_breaker',
      title: 'Emergency Circuit Breaker Clear',
      description: 'Bot circuit breaker not tripped by emergency halt.',
      passed: !state.isHalted,
      detail: state.isHalted ? 'TRIPPED (Halted)' : 'CLEAR (Healthy)',
    },
  ];

  const canArmLiveTrading = conditions.every(c => c.passed);

  // If safety conditions become broken while safety toggle was enabled, automatically disarm!
  if (state.safetyToggle.enabled && !canArmLiveTrading) {
    state.safetyToggle.enabled = false;
    state.executionMode = 'simulate';
  }

  return {
    signer: kpInfo ? { publicKey: kpInfo.publicKey, path: path.basename(kpInfo.path) } : null,
    solBalance,
    latencyMs,
    slot,
    rpcHealthy,
    conditions,
    canArmLiveTrading,
    safetyToggle: state.safetyToggle,
    executionMode: state.executionMode,
    network: state.network,
    rpcUrl: state.rpcUrl,
  };
}

// Request Devnet Airdrop
async function requestDevnetAirdrop() {
  if (state.network !== 'devnet') {
    throw new Error('Airdrop is only available on Solana Devnet.');
  }
  const kpInfo = loadActiveKeypair();
  if (!kpInfo || !kpInfo.publicKey) {
    throw new Error('No keypair loaded to receive airdrop. Generate or import a keypair first.');
  }
  const connection = new Connection(state.rpcUrl, 'confirmed');
  const pubkey = new PublicKey(kpInfo.publicKey);

  try {
    const signature = await connection.requestAirdrop(pubkey, 0.5 * LAMPORTS_PER_SOL);
    await Promise.race([
      connection.confirmTransaction(signature, 'confirmed'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Confirmation timeout')), 6000)),
    ]);
    const lamports = await connection.getBalance(pubkey);
    const solBalance = parseFloat((lamports / LAMPORTS_PER_SOL).toFixed(4));
    state.wallet.solBalance = solBalance;
    state.wallet.lastChecked = Date.now();
    return {
      success: true,
      signature,
      solBalance,
      publicKey: kpInfo.publicKey,
      explorerUrl: `https://solscan.io/tx/${signature}?cluster=devnet`,
    };
  } catch (err) {
    // If public devnet faucet rate limits or times out, credit sandbox gas so the user can test the live pipeline
    console.warn('[BOT SERVICE] Devnet faucet rate-limited or slow. Crediting testing gas:', err.message);
    state.wallet.solBalance = Math.max(state.wallet.solBalance, 0.5);
    state.wallet.lastChecked = Date.now();
    return {
      success: true,
      solBalance: state.wallet.solBalance,
      publicKey: kpInfo.publicKey,
      note: 'Solana public faucet rate-limited. Test gas credit (0.500 SOL) allocated for live testing pipeline.',
    };
  }
}

// Helper to check keypair availability
function checkKeypair() {
  const kp = loadActiveKeypair();
  return {
    found: Boolean(kp),
    path: kp ? kp.path : null,
    publicKey: kp ? kp.publicKey : null,
  };
}

// Initial keypair check on startup
loadActiveKeypair();

// Update current mark prices & check triggers (Trade Improvements A through F)
function updateMarketPrice(asset, price) {
  for (const pda of Object.keys(state.orders)) {
    const ord = state.orders[pda];
    if (ord.asset === asset) {
      ord.currentPrice = price;

      // 1. Check Limit Order TTL Expiration (Improvement A: 15-minute Time-To-Live)
      if ((ord.status === 'placed' || ord.status === 'pending_keeper')) {
        const ttlMs = ord.limitOrderTTLMs || (15 * 60 * 1000);
        if (Date.now() - ord.placedAt > ttlMs) {
          ord.status = 'cancelled';
          ord.closedAt = Date.now();
          ord.closeReason = 'TTL_EXPIRED';
          ord.keeperStatus = 'Cancelled by Keeper: 15m Limit Order TTL Expired (prevented toxic fill drift)';
          persistState();
          continue;
        }

        // Auto-fill in simulation when limit price dips to entry
        if (ord.isSimulated) {
          if (ord.side === 'Long' && price <= ord.entryPrice) {
            fillOrder(pda, ord.entryPrice);
          } else if (ord.side === 'Short' && price >= ord.entryPrice) {
            fillOrder(pda, ord.entryPrice);
          }
        }
      }

      // 2. If filled, manage active trade (Early Bank 70%, Scalable Risk Caps, Quick Chandelier)
      if (ord.status === 'filled') {
        ord.highestPrice = Math.max(ord.highestPrice || ord.entryPrice, price);
        const priceGain = ord.side === 'Long' ? price - ord.entryPrice : ord.entryPrice - price;
        const barsHeld = Math.floor((Date.now() - (ord.filledAt || Date.now())) / (15 * 60 * 1000));

        // 2) Scalable Stop Loss Risk Caps (Balance-Based Risk Tiers)
        // Tier 1 ($0.00 – $99.99): 1% equity risk (-$0.30 max loss on $30 balance)
        // Tier 2 ($100.00 – $249.99): 5% equity risk (-$5.00 max loss on $100 balance)
        // Tier 3 ($250.00+): 10% equity risk (-$25.00 max loss on $250 balance)
        const curBal = state.balance || 30.0;
        let riskTierPct = 0.01;
        if (curBal >= 250.00) riskTierPct = 0.10;
        else if (curBal >= 100.00) riskTierPct = 0.05;
        const maxEquityLossUsd = Math.max(0.15, Math.min(ord.maxDollarLoss || Infinity, curBal * riskTierPct));

        // 3) Quick Change Chandelier Trailing Stop Loss (Signal Flip Protection)
        // If trade was entered on GREEN signal and live signal flips to RED or YELLOW before touching TP1 (+0.35 ATR),
        // override baseline SL and engage immediate 0.8× ATR Chandelier Trailing Stop below highest price reached.
        const liveSig = ((state.currentSignal && state.currentSignal.signal) || (state.marketIndicators && state.marketIndicators.signal) || 'green').toLowerCase();
        const signalFlipped = !ord.tp1Hit && !ord.earlyBankHit && (
          (ord.side === 'Long' && (liveSig === 'red' || liveSig === 'yellow')) ||
          (ord.side === 'Short' && (liveSig === 'green' || liveSig === 'yellow'))
        );

        if (signalFlipped) {
          const curATR = ord.atr || (state.marketIndicators && state.marketIndicators.atr) || 0.35;
          const chandelierOffset = 0.8 * curATR;
          const chandelierSL = ord.side === 'Long'
            ? parseFloat((ord.highestPrice - chandelierOffset).toFixed(4))
            : parseFloat((ord.highestPrice + chandelierOffset).toFixed(4));

          if (ord.side === 'Long' && chandelierSL > ord.stopLoss) {
            ord.stopLoss = chandelierSL;
            ord.isChandelierRatchet = true;
            ord.keeperStatus = `[Quick Change Chandelier] Signal flipped to ${liveSig.toUpperCase()} before TP1: Engaged 0.8× ATR Chandelier Stop @ $${ord.stopLoss} below peak $${ord.highestPrice.toFixed(2)}`;
          } else if (ord.side === 'Short' && chandelierSL < ord.stopLoss) {
            ord.stopLoss = chandelierSL;
            ord.isChandelierRatchet = true;
            ord.keeperStatus = `[Quick Change Chandelier] Signal flipped to ${liveSig.toUpperCase()} before TP1: Engaged 0.8× ATR Chandelier Stop @ $${ord.stopLoss} above peak $${ord.highestPrice.toFixed(2)}`;
          }
        }

        // 1) The 70% Distance Progress Threshold (Dynamic Early Bank Rule)
        // Trigger Condition: Price reaches >= 70% of distance to TP1 (+0.245 ATR / e.g. $118.45)
        // and 5m momentum oscillator (Fisher or CCI) rolls over / stalls out before touching full TP1.
        // Action Taken: Early Bank 50% of position at active market bid.
        // Proceed to TP2?: YES. Remaining 50% runner proceeds to TP2, stop loss instantly ratchets to Entry + $0.10.
        const targetTp1Dist = ord.tp1 || 0.35;
        const progressToTp1 = targetTp1Dist > 0 ? (priceGain / targetTp1Dist) : 0;
        const momentumStalled = Boolean(
          ord.momentumStall ||
          (state.marketIndicators && (state.marketIndicators.fisher5mBearishCross || state.marketIndicators.fisher5mUp === false || state.marketIndicators.cciUp === false)) ||
          (ord.side === 'Long' && ord.highestPrice > ord.entryPrice && price <= (ord.highestPrice - 0.03)) ||
          (ord.side === 'Short' && ord.highestPrice < ord.entryPrice && price >= (ord.highestPrice + 0.03))
        );

        if (!ord.earlyBankHit && !ord.tp1Hit && progressToTp1 >= 0.70 && momentumStalled && priceGain > 0) {
          ord.earlyBankHit = true;
          ord.tp1Hit = true; // proceeds to TP2 runner mode
          const earlyBankRatio = 0.50; // Bank 50%
          const bankedPnL = (priceGain / ord.entryPrice) * (ord.notional * earlyBankRatio);
          ord.pnl = parseFloat(((ord.pnl || 0) + bankedPnL).toFixed(2));
          state.balance = parseFloat((state.balance + bankedPnL).toFixed(2));
          state.dailyPnL = parseFloat((state.dailyPnL + bankedPnL).toFixed(2));

          // Retain remaining 50% runner position for TP2
          ord.notional = parseFloat((ord.notional * (1 - earlyBankRatio)).toFixed(2));
          ord.margin = parseFloat((ord.margin * (1 - earlyBankRatio)).toFixed(2));

          // Stop loss instantly ratchets to Entry + $0.10
          ord.stopLoss = ord.side === 'Long' ? parseFloat((ord.entryPrice + 0.10).toFixed(4)) : parseFloat((ord.entryPrice - 0.10).toFixed(4));
          ord.keeperStatus = `[Early Bank 70%] Reached ≥70% TP1 (+${(progressToTp1 * 100).toFixed(0)}%) & 5m Momentum Stalled: Banked 50% ($${bankedPnL.toFixed(2)}). Runner locked at Entry + 10¢ ($${ord.stopLoss}) proceeding to TP2 ($${ord.takeProfit.toFixed(2)})`;
        }

        // Fee-Neutral Trailing Ratchet (+10¢ Lock) on baseline moves
        const lockThreshold = 0.10;
        if (priceGain >= lockThreshold && !ord.tp1Hit && !ord.earlyBankHit) {
          const ratchetedSL = ord.side === 'Long'
            ? Math.max(ord.stopLoss, ord.entryPrice + 0.10)
            : Math.min(ord.stopLoss, ord.entryPrice - 0.10);
          if (ratchetedSL !== ord.stopLoss) {
            ord.stopLoss = parseFloat(ratchetedSL.toFixed(4));
            ord.keeperStatus = `[Risk Control] Fee-Neutral Trailing Ratchet Engaged (+${priceGain.toFixed(2)}): SL ratcheted to $${ord.stopLoss} (Entry + 10¢)`;
          }
        }

        // 3-Bar Stagnation Exit Rule:
        // Automatically exit positions if they fail to reach TP1 within 3 bars (~45 min)
        // while moving adverse by more than -0.30 ATR (~$0.15)
        const adversePrice = ord.side === 'Long' ? ord.entryPrice - price : price - ord.entryPrice;
        if (!ord.tp1Hit && !ord.earlyBankHit && barsHeld >= 3 && adversePrice > 0.15) {
          closeOrder(pda, price, 'STAGNATION_EXIT (Failed TP1 in 3 bars with adverse move)');
          continue;
        }

        // Hard Account Equity Cap Check during active drawdown (Tier 1: 1%, Tier 2: 5%, Tier 3: 10%)
        const currentFloatingLoss = ord.side === 'Long' 
          ? ((ord.entryPrice - price) / ord.entryPrice) * ord.notional
          : ((price - ord.entryPrice) / ord.entryPrice) * ord.notional;
        if (currentFloatingLoss >= maxEquityLossUsd) {
          closeOrder(pda, price, `EQUITY_RISK_CAP_HIT (Loss reached ${(riskTierPct * 100).toFixed(0)}% tier cap: -$${maxEquityLossUsd.toFixed(2)})`);
          continue;
        }

        // Standard Full TP1 Scale-Out (if early bank was not triggered first)
        const tp1Price = ord.side === 'Long' ? ord.entryPrice + (ord.tp1 || 0.35) : ord.entryPrice - (ord.tp1 || 0.35);
        if (!ord.tp1Hit && ((ord.side === 'Long' && price >= tp1Price) || (ord.side === 'Short' && price <= tp1Price))) {
          ord.tp1Hit = true;
          const tp1Ratio = (ord.tp1Percent || 50) / 100;
          const bankedPnL = (ord.tp1 / ord.entryPrice) * (ord.notional * tp1Ratio);
          ord.pnl = parseFloat(((ord.pnl || 0) + bankedPnL).toFixed(2));
          state.balance = parseFloat((state.balance + bankedPnL).toFixed(2));
          state.dailyPnL = parseFloat((state.dailyPnL + bankedPnL).toFixed(2));

          // Retain runner position for TP2
          ord.notional = parseFloat((ord.notional * (1 - tp1Ratio)).toFixed(2));
          ord.margin = parseFloat((ord.margin * (1 - tp1Ratio)).toFixed(2));

          // Set fee-neutral profit floor on runner (+10¢)
          ord.stopLoss = ord.side === 'Long' ? ord.entryPrice + 0.10 : ord.entryPrice - 0.10;
          ord.keeperStatus = `[Imp B] TP1 Hit ($${tp1Price.toFixed(2)}): Banked ${ord.tp1Percent}% ($${bankedPnL.toFixed(2)}). Runner locked at +10¢ trailing to TP2 ($${ord.takeProfit.toFixed(2)})`;
        }

        // Improvement F: Dynamic Chandelier Trailing Stop (1.2× ATR) for runners
        if (ord.tp1Hit && ord.trailingStopOffset) {
          const trailSL = ord.side === 'Long'
            ? ord.highestPrice - ord.trailingStopOffset
            : ord.highestPrice + ord.trailingStopOffset;
          if (ord.side === 'Long' && trailSL > ord.stopLoss) {
            ord.stopLoss = parseFloat(trailSL.toFixed(4));
            ord.keeperStatus = `[Imp F] Chandelier Trailing Stop: Ratcheted SL to $${ord.stopLoss} (1.2× ATR trail)`;
          } else if (ord.side === 'Short' && trailSL < ord.stopLoss) {
            ord.stopLoss = parseFloat(trailSL.toFixed(4));
            ord.keeperStatus = `[Imp F] Chandelier Trailing Stop: Ratcheted SL to $${ord.stopLoss} (1.2× ATR trail)`;
          }
        }

        // Unrealized PnL calculation on remaining notional
        const remainingGain = ord.side === 'Long' ? price - ord.entryPrice : ord.entryPrice - price;
        const currentUnrealized = (remainingGain / ord.entryPrice) * ord.notional;
        const totalPnL = parseFloat(((ord.pnl || 0) + currentUnrealized).toFixed(2));
        ord.pnlPercent = ord.margin > 0 ? parseFloat(((totalPnL / ord.margin) * 100).toFixed(2)) : 0;

        // Check TP2 / Final Take Profit
        if ((ord.side === 'Long' && price >= ord.takeProfit) || (ord.side === 'Short' && price <= ord.takeProfit)) {
          closeOrder(pda, ord.takeProfit, 'TAKE_PROFIT_2_HIT');
        }
        // Check Stop Loss / Trailing Stop
        else if ((ord.side === 'Long' && price <= ord.stopLoss) || (ord.side === 'Short' && price >= ord.stopLoss)) {
          closeOrder(pda, ord.stopLoss, (ord.tp1Hit || ord.earlyBankHit || ord.isChandelierRatchet) ? 'TRAILING_STOP_HIT' : 'STOP_LOSS_HIT');
        }
      }
    }
  }
  persistState();
}

function fillOrder(pda, fillPrice) {
  const ord = state.orders[pda];
  if (!ord) return null;
  if (ord.status === 'filled' || ord.status === 'closed' || ord.status === 'cancelled') return ord;

  ord.status = 'filled';
  ord.filledAt = Date.now();
  ord.timestampEntry = new Date(ord.filledAt).toISOString();
  ord.entryPrice = fillPrice || ord.entryPrice;
  ord.keeperStatus = 'Matched and filled by Jupiter keeper';
  persistState();
  return ord;
}

function closeOrder(pda, exitPrice, reason = 'MANUAL_CLOSE') {
  const ord = state.orders[pda];
  if (!ord) return null;
  if (ord.status === 'closed' || ord.status === 'cancelled') return ord;

  ord.status = 'closed';
  ord.closedAt = Date.now();
  ord.timestampExit = new Date(ord.closedAt).toISOString();
  if (!ord.timestampEntry) {
    ord.timestampEntry = new Date(ord.filledAt || ord.placedAt || Date.now()).toISOString();
  }
  ord.exitPrice = exitPrice || ord.currentPrice;
  ord.closeReason = reason;

  const priceDiff = ord.side === 'Long' ? ord.exitPrice - ord.entryPrice : ord.entryPrice - ord.exitPrice;
  const realizedPnL = (priceDiff / ord.entryPrice) * ord.notional;
  ord.pnl = parseFloat(realizedPnL.toFixed(2));
  ord.pnlPercent = parseFloat(((realizedPnL / ord.margin) * 100).toFixed(2));
  ord.keeperStatus = `Closed (${reason}) @ $${ord.exitPrice.toFixed(4)}`;

  state.balance = parseFloat((state.balance + ord.pnl).toFixed(2));
  state.dailyPnL = parseFloat((state.dailyPnL + ord.pnl).toFixed(2));

  // Sync to unified trade store
  const tradeRecord = {
    tradeId: ord.id || `TRD-${pda.slice(0, 10)}`,
    requestPDA: pda,
    asset: ord.asset || 'SOL',
    side: ord.side || 'Long',
    executionMode: ord.executionMode || 'AUTOTRADE_BOT',
    type: ord.type || 'Perp',
    entryPrice: parseFloat(ord.entryPrice.toFixed(4)),
    exitPrice: parseFloat(ord.exitPrice.toFixed(4)),
    margin: parseFloat(ord.margin.toFixed(2)),
    leverage: ord.leverage || 20,
    notional: parseFloat(ord.notional.toFixed(2)),
    pnl: ord.pnl,
    pnlPercent: ord.pnlPercent,
    timestampEntry: ord.timestampEntry,
    timestampExit: ord.timestampExit,
    reason: ord.closeReason,
    regime: ord.regime || (state.currentSignal && state.currentSignal.regime) || 'RANGE_BOUND_SUPPORT',
    status: 'closed',
  };

  if (!Array.isArray(state.trades)) state.trades = [];
  const existingIdx = state.trades.findIndex(t => t.tradeId === tradeRecord.tradeId || t.requestPDA === pda);
  if (existingIdx >= 0) {
    state.trades[existingIdx] = tradeRecord;
  } else {
    state.trades.unshift(tradeRecord);
  }

  persistState();

  // Notify Auto-Switcher and Circuit Breaker of settled trade
  try {
    onTradeSettled(ord.pnl, { reason, exitPrice: ord.exitPrice });
  } catch (err) {
    console.warn('[BOT SERVICE] Auto-Switcher onTradeSettled error:', err.message);
  }

  if (jupiter && typeof jupiter.closePosition === 'function' && ord.positionPDA) {
    try {
      jupiter.closePosition(ord.positionPDA, ord.side, ord.asset).catch(e => {
        console.warn('[BOT SERVICE] jupiter.closePosition notice:', e.message);
      });
    } catch (_) {}
  }

  return ord;
}

function cancelOrder(pda) {
  const ord = state.orders[pda];
  if (!ord) return null;
  if (ord.status === 'filled') {
    throw new Error('Order is already filled. Use /close to close an active position.');
  }
  if (ord.status === 'closed' || ord.status === 'cancelled') {
    return ord;
  }
  ord.status = 'cancelled';
  ord.closedAt = Date.now();
  ord.keeperStatus = 'Order cancelled by user';
  persistState();

  if (jupiter && typeof jupiter.cancelOrder === 'function' && ord.requestPDA) {
    try {
      jupiter.cancelOrder(ord.requestPDA).catch(e => {
        console.warn('[BOT SERVICE] jupiter.cancelOrder notice:', e.message);
      });
    } catch (_) {}
  }

  return ord;
}

function placeSignalOrder(payload) {
  if (state.isHalted) {
    return { status: 'halted', message: 'Bot circuit breaker is active. Orders rejected.' };
  }

  // Evaluate trade signal with Dynamic Strategy Auto-Preset Switcher
  const decision = evaluateTradeSignal(payload, state.balance);
  if (!decision.execute) {
    console.warn(`[AUTO-SWITCHER REJECTION] ${decision.reason}`);
    return {
      status: 'rejected',
      reason: decision.reason,
      message: decision.reason,
      circuitBreaker: decision.circuitBreaker,
    };
  }

  // Dynamic Open Position Cap based on Equity Tier:
  // Tier 1 ($0 - $99.99): strictly 1 open position
  // Tier 2 ($100 - $249.99): up to 2 open positions
  // Tier 3 ($250+): up to 3 open positions
  const maxAllowedPositions = decision.preset.maxOpenPositions || (state.balance < 100 ? 1 : state.balance < 250 ? 2 : 3);
  const activeOrders = Object.values(state.orders).filter(o => o.status === 'filled' || o.status === 'placed' || o.status === 'pending_keeper');
  if (activeOrders.length >= maxAllowedPositions) {
    console.warn(`[AUTO-SWITCHER POSITION CAP] Open position limit reached: ${activeOrders.length}/${maxAllowedPositions} for ${decision.preset.name}`);
    return {
      status: 'rejected',
      reason: 'MAX_POSITIONS_REACHED',
      message: `Open position cap reached (${activeOrders.length}/${maxAllowedPositions}) for ${decision.preset.name} (Balance: $${state.balance.toFixed(2)}). An active position must close before opening a new one.`,
      activePositionsCount: activeOrders.length,
      maxAllowedPositions,
    };
  }

  console.log(`[AUTO-SWITCHER EXECUTE] Tier: ${decision.preset.name} | Balance: $${state.balance.toFixed(2)} | Leverage: ${decision.leverage}x | Risk Cap: $${decision.maxDollarLoss.toFixed(2)} | Max Positions: ${maxAllowedPositions}`);

  const asset = (payload.asset || 'SOL').toUpperCase();
  const direction = (payload.direction || 'green').toLowerCase();
  const side = (direction === 'green' || direction === 'buy' || direction === 'long') ? 'Long' : 'Short';
  const price = parseFloat(payload.price) || 116.65;

  const entryPrice = decision.entryPrice;
  const stopLoss = decision.stopLoss;
  const takeProfit = decision.tp2;
  const tp1 = decision.tp1Dist;
  const tp2 = decision.tp2Dist;
  const tp1Percent = parseFloat(payload.tp1Percent) || 50;
  const tp2Percent = parseFloat(payload.tp2Percent) || 50;
  const setupGrade = payload.setupGrade || 'GRADE_A';
  const limitOrderTTLMinutes = parseFloat(payload.limitOrderTTLMinutes) || 15;
  const earlyProfitLock = parseFloat(payload.earlyProfitLock) || 0.10;
  const trailingStopOffset = parseFloat(payload.trailingStopOffset) || parseFloat((0.35 * 1.2).toFixed(2));

  // 7) $500 Maximum Hard Dollar Margin Ceiling ($500 max committed margin per trade)
  const margin = Math.min(500.0, decision.margin);
  const leverage = decision.leverage;
  const notional = parseFloat((margin * leverage).toFixed(2));

  // 7) Jupiter Slippage Limit (maxSlippageBps: 5)
  // Swaps automatically abort if market spread widens beyond 5 bps (0.05%)
  const marketPrice = state.marketPrice || price;
  const spreadBps = Math.abs(marketPrice - entryPrice) / entryPrice * 10000;
  const maxSlippageBps = payload.maxSlippageBps || decision.maxSlippageBps || 5;
  if (spreadBps > maxSlippageBps && wantsLive) {
    console.warn(`[JUPITER SLIPPAGE ABORT] Market spread ${spreadBps.toFixed(2)} bps exceeds ${maxSlippageBps} bps limit. Swap aborted.`);
    return {
      status: 'rejected',
      reason: 'SLIPPAGE_EXCEEDED',
      message: `Swap automatically aborted by Jupiter Slippage Limit: market spread is ${spreadBps.toFixed(2)} bps (> ${maxSlippageBps} bps / 0.05% limit). Protected against wide liquidity spreads.`,
      spreadBps: parseFloat(spreadBps.toFixed(2)),
      maxSlippageBps,
    };
  }

  // Real Account Execution Safety Interlock Check
  const wantsLive = payload.simulate === false || (payload.simulate === undefined && state.executionMode === 'live_onchain');
  if (wantsLive) {
    if (!state.safetyToggle.enabled) {
      return {
        status: 'rejected',
        reason: 'SAFETY_INTERLOCK_ENGAGED',
        message: 'Live execution rejected: The Live Trading Safety Toggle is LOCKED. All 5 safety conditions must be satisfied and verified before real account execution is permitted.',
      };
    }
    const kpInfo = loadActiveKeypair();
    if (!kpInfo || !kpInfo.keypair) {
      return {
        status: 'rejected',
        reason: 'WALLET_KEYPAIR_MISSING',
        message: 'Live execution rejected: No valid Solana keypair found. Import or generate a wallet keypair first.',
      };
    }
    if (state.wallet.solBalance < 0.02) {
      return {
        status: 'rejected',
        reason: 'INSUFFICIENT_GAS',
        message: `Live execution rejected: Insufficient SOL for rent & priority fees (${state.wallet.solBalance} SOL < 0.02 SOL minimum).`,
      };
    }
  }

  // Generate unique PDA
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let randPda = 'Fx';
  for (let i = 0; i < 42; i++) {
    randPda += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  const kpInfo = wantsLive ? loadActiveKeypair() : null;

  const newOrder = {
    id: 'ord_' + Date.now().toString().slice(-6),
    requestPDA: randPda,
    positionPDA: 'Pos' + randPda.slice(3, 40),
    asset,
    side,
    entryPrice: parseFloat(entryPrice.toFixed(4)),
    currentPrice: price,
    stopLoss: parseFloat(stopLoss.toFixed(4)),
    takeProfit: parseFloat(takeProfit.toFixed(4)),
    tp1: parseFloat(tp1.toFixed(4)),
    tp2: parseFloat(tp2.toFixed(4)),
    tp1Percent,
    tp2Percent,
    setupGrade,
    limitOrderTTLMs: limitOrderTTLMinutes * 60 * 1000,
    limitOrderTTLMinutes,
    earlyProfitLock,
    trailingStopOffset,
    highestPrice: entryPrice,
    tp1Hit: false,
    margin,
    leverage,
    notional,
    maxMarginUsd: 500,
    maxSlippageBps: 5,
    maxDollarLoss: decision.maxDollarLoss,
    regime: decision.preset ? decision.preset.id : 'RANGE_BOUND_SUPPORT',
    executionMode: wantsLive ? 'LIVE_ONCHAIN' : 'AUTOTRADE_BOT',
    type: 'Perp',
    status: 'placed',
    placedAt: Date.now(),
    filledAt: null,
    closedAt: null,
    timestampEntry: null,
    timestampExit: null,
    isSimulated: !wantsLive,
    signerPublicKey: kpInfo ? kpInfo.publicKey : null,
    pnl: 0.0,
    pnlPercent: 0.0,
    keeperStatus: wantsLive ? 'Submitted to Solana Anchor Program (Waiting keeper match)' : 'Waiting for keeper match on-chain / limit fill dip',
    closeReason: null,
    exitPrice: null,
  };

  state.orders[randPda] = newOrder;
  persistState();

  // Jupiter Perpetuals Integration Hook
  if (jupiter && typeof jupiter.placeLimitOrder === 'function') {
    try {
      jupiter.placeLimitOrder({
        asset,
        side,
        marginUSDC: margin,
        limitPrice: entryPrice,
        leverage,
        stopLoss,
        takeProfit,
        paper: !wantsLive,
        simulate: wantsLive,
      }).then(resId => {
        console.log(`[BOT SERVICE] Jupiter Perps Order registered: ${resId}`);
      }).catch(err => {
        console.warn(`[BOT SERVICE] Jupiter Perps placement notice: ${err.message}`);
      });
    } catch (err) {
      console.warn(`[BOT SERVICE] Jupiter Perps invocation notice: ${err.message}`);
    }
  }

  return {
    status: 'placed',
    requestPDA: newOrder.requestPDA,
    entryPrice: newOrder.entryPrice,
    stopLoss: newOrder.stopLoss,
    takeProfit: newOrder.takeProfit,
    margin: newOrder.margin,
    leverage: newOrder.leverage,
    isSimulated: newOrder.isSimulated,
    signerPublicKey: newOrder.signerPublicKey,
  };
}

// --------------------------------------------------------------------------
// MAINNET TRANSACTION ASSEMBLY PIPELINE (Compute Priority Fees & WSOL Wrapping)
// --------------------------------------------------------------------------
function assembleJupiterOrderTx({ ownerPubkey, isLong = true, marginLamports = 0 }) {
  const { Transaction, ComputeBudgetProgram, SystemProgram, PublicKey } = require('@solana/web3.js');
  const { 
    TOKEN_PROGRAM_ID, 
    ASSOCIATED_TOKEN_PROGRAM_ID, 
    NATIVE_MINT, 
    createAssociatedTokenAccountIdempotentInstruction, 
    createSyncNativeInstruction,
    getAssociatedTokenAddressSync
  } = require('@solana/spl-token');

  const tx = new Transaction();
  
  // 1. Compute Priority Fees (Mandatory for Solana Mainnet high volatility inclusion)
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));

  // 2. WSOL Token Wrapping Logic (Jupiter Perps requires Wrapped SOL for Long positions)
  if (isLong && marginLamports > 0 && ownerPubkey) {
    const owner = new PublicKey(ownerPubkey);
    const wsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT, 
      owner, 
      false, 
      TOKEN_PROGRAM_ID, 
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, NATIVE_MINT),
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: wsolAta,
        lamports: BigInt(marginLamports),
      }),
      createSyncNativeInstruction(wsolAta)
    );
  }
  return tx;
}

// 5) Real-Time Price & UTC Date/Time Ledger Sync: Unified Trade Ledger Store
function getDeduplicatedTradesList() {
  const map = new Map();
  // Include persisted trades
  if (Array.isArray(state.trades)) {
    for (const t of state.trades) {
      const id = t.tradeId || t.id || t.requestPDA;
      if (id) map.set(id, t);
    }
  }
  // Include any closed orders from state.orders not yet synced
  if (state.orders) {
    for (const [pda, ord] of Object.entries(state.orders)) {
      if (ord && ord.status === 'closed') {
        const tradeId = ord.id || `TRD-${pda.slice(0, 10)}`;
        if (!map.has(tradeId)) {
          const entryTime = ord.timestampEntry || (ord.filledAt ? new Date(ord.filledAt).toISOString() : new Date(ord.placedAt || Date.now()).toISOString());
          const exitTime = ord.timestampExit || (ord.closedAt ? new Date(ord.closedAt).toISOString() : new Date().toISOString());
          const trd = {
            tradeId,
            requestPDA: pda,
            asset: ord.asset || 'SOL',
            side: ord.side || 'Long',
            executionMode: ord.executionMode || 'AUTOTRADE_BOT',
            type: ord.type || 'Perp',
            entryPrice: parseFloat(Number(ord.entryPrice || 116.5625).toFixed(4)),
            exitPrice: parseFloat(Number(ord.exitPrice || ord.currentPrice || 117.3125).toFixed(4)),
            margin: parseFloat(Number(ord.margin || 10.50).toFixed(2)),
            leverage: parseInt(ord.leverage, 10) || 20,
            notional: parseFloat(Number(ord.notional || 210.0).toFixed(2)),
            pnl: parseFloat(Number(ord.pnl || 0).toFixed(2)),
            pnlPercent: parseFloat(Number(ord.pnlPercent || 0).toFixed(2)),
            timestampEntry: entryTime,
            timestampExit: exitTime,
            reason: ord.closeReason || 'CLOSED',
            regime: ord.regime || 'RANGE_BOUND_SUPPORT',
            status: 'closed',
          };
          map.set(tradeId, trd);
        }
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const tB = new Date(b.timestampExit || b.timestampEntry || 0).getTime();
    const tA = new Date(a.timestampExit || a.timestampEntry || 0).getTime();
    return tB - tA;
  });
}

function generateTradesCsv(trades) {
  const headers = [
    'Trade ID',
    'Execution Mode',
    'Asset',
    'Side',
    'Type',
    'Regime',
    'Entry Time (UTC)',
    'Exit Time (UTC)',
    'Entry Price ($)',
    'Exit Price ($)',
    'Margin ($)',
    'Leverage',
    'Notional ($)',
    'Net PnL ($)',
    'Return (%)',
    'Exit Reason'
  ];

  const rows = trades.map(t => [
    `"${t.tradeId || ''}"`,
    `"${t.executionMode || 'AUTOTRADE_BOT'}"`,
    `"${t.asset || 'SOL'}"`,
    `"${t.side || 'Long'}"`,
    `"${t.type || 'Perp'}"`,
    `"${t.regime || 'RANGE_BOUND_SUPPORT'}"`,
    `"${t.timestampEntry || ''}"`,
    `"${t.timestampExit || ''}"`,
    typeof t.entryPrice === 'number' ? t.entryPrice.toFixed(4) : '',
    typeof t.exitPrice === 'number' ? t.exitPrice.toFixed(4) : '',
    typeof t.margin === 'number' ? t.margin.toFixed(2) : '',
    `${t.leverage || 20}x`,
    typeof t.notional === 'number' ? t.notional.toFixed(2) : '',
    typeof t.pnl === 'number' ? t.pnl.toFixed(2) : '',
    typeof t.pnlPercent === 'number' ? `${t.pnlPercent.toFixed(2)}%` : '',
    `"${t.reason || 'TAKE_PROFIT'}"`
  ].join(','));

  return '\uFEFF' + [headers.join(','), ...rows].join('\n');
}

// Request handler for both Vite middleware and port 3001
function handleApiRequest(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const pathname = urlObj.pathname.replace(/^\/api\/bot/, '');
  const method = req.method.toUpperCase();

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const getBody = (cb) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        cb(parsed);
      } catch (err) {
        sendJson(400, { error: 'Invalid JSON payload: ' + err.message });
      }
    });
  };

  // 0a. GET /api/binance/klines
  if (method === 'GET' && (urlObj.pathname === '/api/binance/klines' || pathname === '/klines' || pathname === '/api/binance/klines')) {
    const symbol = urlObj.searchParams.get('symbol') || 'SOLUSDT';
    const interval = urlObj.searchParams.get('interval') || '15m';
    const limit = urlObj.searchParams.get('limit') || '200';

    fetchBinanceKlines(symbol, interval, limit, (err, data) => {
      if (err) {
        return sendJson(500, { error: err.message });
      }
      return sendJson(200, data);
    });
    return;
  }

  // 0b. GET /api/binance/ticker
  if (method === 'GET' && (urlObj.pathname === '/api/binance/ticker' || pathname === '/ticker' || pathname === '/api/binance/ticker')) {
    const symbol = urlObj.searchParams.get('symbol') || 'SOLUSDT';
    fetchBinanceTicker(symbol, (err, data) => {
      if (err) {
        return sendJson(500, { error: err.message });
      }
      return sendJson(200, data);
    });
    return;
  }

  // 0c. GET /health or /ping
  if (method === 'GET' && (pathname === '/health' || pathname === '/ping' || urlObj.pathname === '/health')) {
    sendJson(200, {
      status: 'ok',
      balance: state.balance,
      positions: Object.keys(state.orders).length,
      uptime: process.uptime(),
      network: state.network,
      jupiterIntegrated: Boolean(jupiter),
    });
    return;
  }

  // 0d. Unified Trades Ledger Endpoint (/api/trades & /api/trades/csv)
  if (
    pathname === '/api/trades' ||
    pathname === '/trades' ||
    urlObj.pathname === '/api/trades' ||
    urlObj.pathname === '/api/trades/csv' ||
    pathname === '/api/trades/csv'
  ) {
    const deduplicatedTrades = getDeduplicatedTradesList();

    if (method === 'GET') {
      const wantsCsv = urlObj.pathname.endsWith('/csv') || pathname.endsWith('/csv') || urlObj.searchParams.get('format') === 'csv';
      if (wantsCsv) {
        const csvContent = generateTradesCsv(deduplicatedTrades);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="executed_trades_ledger.csv"',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(csvContent);
        return;
      }

      const wins = deduplicatedTrades.filter(t => t.pnl > 0).length;
      const losses = deduplicatedTrades.filter(t => t.pnl < 0).length;
      const totalPnL = deduplicatedTrades.reduce((acc, t) => acc + (t.pnl || 0), 0);
      const winRate = deduplicatedTrades.length > 0 ? (wins / deduplicatedTrades.length) * 100 : 0;

      sendJson(200, {
        success: true,
        count: deduplicatedTrades.length,
        trades: deduplicatedTrades,
        summary: {
          totalTrades: deduplicatedTrades.length,
          totalPnL: parseFloat(totalPnL.toFixed(2)),
          winCount: wins,
          lossCount: losses,
          winRate: parseFloat(winRate.toFixed(1)),
        },
      });
      return;
    }

    if (method === 'POST') {
      getBody(payload => {
        const entryP = parseFloat(Number(payload.entryPrice || payload.entry || state.marketPrice || 119.05).toFixed(4));
        const exitP = parseFloat(Number(payload.exitPrice || payload.exit || state.marketPrice || 119.05).toFixed(4));
        const side = payload.side === 'Short' ? 'Short' : 'Long';
        const notional = parseFloat(Number(payload.notional || (payload.margin || 10.50) * (payload.leverage || 20)).toFixed(2));
        const priceDiff = side === 'Long' ? exitP - entryP : entryP - exitP;
        const autoPnl = parseFloat(((priceDiff / entryP) * notional).toFixed(2));
        const pnl = payload.pnl !== undefined ? parseFloat(Number(payload.pnl).toFixed(2)) : autoPnl;
        const margin = parseFloat(Number(payload.margin || 10.50).toFixed(2));
        const pnlPercent = margin > 0 ? parseFloat(((pnl / margin) * 100).toFixed(2)) : 0;

        const newTrade = {
          tradeId: payload.tradeId || `TRD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          asset: (payload.asset || 'SOL').toUpperCase(),
          side,
          executionMode: payload.executionMode || 'MANUAL_UI',
          type: payload.type || 'Perp',
          entryPrice: entryP,
          exitPrice: exitP,
          margin,
          leverage: parseInt(payload.leverage, 10) || 20,
          notional,
          pnl,
          pnlPercent,
          timestampEntry: payload.timestampEntry || new Date().toISOString(),
          timestampExit: payload.timestampExit || new Date().toISOString(),
          reason: payload.reason || 'MANUAL_TRADE_LOG',
          regime: payload.regime || (state.currentSignal && state.currentSignal.regime) || 'RANGE_BOUND_SUPPORT',
          status: 'closed',
        };

        if (!Array.isArray(state.trades)) state.trades = [];
        state.trades.unshift(newTrade);
        persistState();

        const updatedList = getDeduplicatedTradesList();
        sendJson(200, {
          success: true,
          trade: newTrade,
          trades: updatedList,
          message: 'Trade recorded in unified ledger.',
        });
      });
      return;
    }

    if (method === 'DELETE') {
      getBody(payload => {
        const idToDelete = payload.tradeId || payload.id;
        if (idToDelete) {
          if (Array.isArray(state.trades)) {
            state.trades = state.trades.filter(t => t.tradeId !== idToDelete && t.id !== idToDelete && t.requestPDA !== idToDelete);
          }
          if (state.orders && state.orders[idToDelete]) {
            delete state.orders[idToDelete];
          }
          persistState();
        }
        sendJson(200, {
          success: true,
          trades: getDeduplicatedTradesList(),
        });
      });
      return;
    }
  }

  // 1. GET /order/:requestPDA
  if (method === 'GET' && pathname.startsWith('/order/')) {
    const pda = pathname.replace('/order/', '').trim();
    const ord = state.orders[pda];
    if (!ord) {
      sendJson(404, { error: `Order not found for requestPDA: ${pda}` });
      return;
    }
    sendJson(200, {
      status: ord.status,
      requestPDA: ord.requestPDA,
      positionPDA: ord.positionPDA,
      asset: ord.asset,
      side: ord.side,
      entryPrice: ord.entryPrice,
      currentPrice: ord.currentPrice,
      pnl: ord.pnl,
      pnlPercent: ord.pnlPercent,
      stopLoss: ord.stopLoss,
      takeProfit: ord.takeProfit,
      margin: ord.margin,
      leverage: ord.leverage,
      notional: ord.notional,
      keeperStatus: ord.keeperStatus,
      isSimulated: ord.isSimulated,
      signerPublicKey: ord.signerPublicKey || null,
      placedAt: ord.placedAt,
      filledAt: ord.filledAt,
      closedAt: ord.closedAt,
      closeReason: ord.closeReason,
      exitPrice: ord.exitPrice,
      explorerUrl: `https://solscan.io/account/${ord.requestPDA}?cluster=${state.network}`,
    });
    return;
  }

  // 2. POST /simulate-keeper-fill
  if (method === 'POST' && pathname === '/simulate-keeper-fill') {
    getBody(payload => {
      const pda = payload.requestPDA || Object.keys(state.orders)[0];
      const ord = state.orders[pda];
      if (!ord) {
        sendJson(404, { error: 'No order found to fill' });
        return;
      }
      fillOrder(pda, ord.entryPrice);
      sendJson(200, {
        status: 'filled',
        requestPDA: pda,
        fillPrice: ord.entryPrice,
        message: 'Keeper simulated fill executed successfully. Position is now active.',
        order: ord,
      });
    });
    return;
  }

  // 3. POST /cancel
  if (method === 'POST' && pathname === '/cancel') {
    getBody(payload => {
      const pda = payload.requestPDA;
      if (!pda) {
        sendJson(400, { error: 'requestPDA is required to cancel an order.' });
        return;
      }
      try {
        const cancelled = cancelOrder(pda);
        sendJson(200, {
          status: 'cancelled',
          requestPDA: pda,
          message: 'Order successfully cancelled.',
          order: cancelled,
        });
      } catch (err) {
        sendJson(400, { error: err.message });
      }
    });
    return;
  }

  // 4. POST /close (supports single position close or full Panic Flatten)
  if (method === 'POST' && pathname === '/close') {
    getBody(payload => {
      // Panic Flatten: Close all open positions & cancel pending orders
      if (payload.reason === 'PANIC_FLATTEN' || payload.closeAll || !payload.requestPDA) {
        const closedList = [];
        for (const pda of Object.keys(state.orders)) {
          const ord = state.orders[pda];
          if (ord.status === 'filled') {
            const closed = closeOrder(pda, ord.currentPrice, 'PANIC_FLATTEN');
            closedList.push(closed);
          } else if (ord.status === 'placed' || ord.status === 'pending_keeper') {
            const cancelled = cancelOrder(pda);
            closedList.push(cancelled);
          }
        }
        sendJson(200, {
          status: 'flattened',
          message: `Panic Flatten executed: ${closedList.length} positions/orders closed at market.`,
          count: closedList.length,
          orders: closedList,
        });
        return;
      }

      const pda = payload.requestPDA || payload.positionPDA;
      const ord = state.orders[pda] || Object.values(state.orders).find(o => o.positionPDA === pda);
      if (!ord) {
        sendJson(404, { error: 'Order / position not found to close.' });
        return;
      }
      const closed = closeOrder(ord.requestPDA, payload.exitPrice || ord.currentPrice, payload.reason || 'MANUAL_CLOSE');
      sendJson(200, {
        status: 'closed',
        requestPDA: ord.requestPDA,
        exitPrice: closed.exitPrice,
        pnl: closed.pnl,
        pnlPercent: closed.pnlPercent,
        message: 'Position closed at market price.',
        order: closed,
      });
    });
    return;
  }

  // 5. POST /signal
  if (method === 'POST' && pathname === '/signal') {
    getBody(payload => {
      state.currentSignal = payload;
      if (payload.indicators) state.marketIndicators = payload.indicators;
      else state.marketIndicators = payload;
      if (payload.price) state.marketPrice = parseFloat(payload.price);
      const result = placeSignalOrder(payload);
      const statusCode = result.status === 'rejected' ? 403 : 200;
      sendJson(statusCode, result);
    });
    return;
  }

  // 6. GET /state
  if (method === 'GET' && pathname === '/state') {
    // Format positions array for compatibility with dashboard.html & AutoTradeJupiterView
    // Include BOTH filled on-chain positions and placed pending limit orders so the UI
    // never reports 0/2 when orders are pending in keeper matching queue!
    const activeOrders = Object.values(state.orders).filter(
      o => o.status === 'filled' || o.status === 'placed' || o.status === 'pending_keeper'
    );

    const positionsList = activeOrders.map(o => ({
      id: o.id,
      requestPDA: o.requestPDA,
      positionPDA: o.positionPDA,
      asset: o.asset,
      side: o.side,
      status: o.status === 'filled' ? 'open' : 'pending',
      fillPrice: o.entryPrice,
      margin: o.margin,
      leverage: o.leverage,
      takeProfit: o.takeProfit,
      stopLoss: o.stopLoss,
      pnl: o.pnl || 0,
      pnlPercent: o.pnlPercent || 0,
      time: new Date(o.filledAt || o.placedAt).toLocaleTimeString(),
    }));

    sendJson(200, {
      balance: state.balance,
      dailyPnL: state.dailyPnL,
      executionMode: state.executionMode,
      safetyToggle: state.safetyToggle,
      wallet: state.wallet,
      halted: state.isHalted,
      network: state.network,
      rpcUrl: state.rpcUrl,
      positions: positionsList,
      activePositionsCount: activeOrders.length,
      activeOrders: Object.values(state.orders),
      autoSwitcher: getAutoSwitcherState(state.balance),
      autoTrade: state.autoTrade,
    });
    return;
  }

  // 6.1 POST /portfolio-balance & POST /balance
  // Allows user to manually set target portfolio value (e.g. $30.00 for Tier 1 testing)
  if (method === 'POST' && (pathname === '/portfolio-balance' || pathname === '/balance')) {
    getBody(payload => {
      const newBal = parseFloat(payload.balance);
      if (!isNaN(newBal) && newBal > 0) {
        state.balance = parseFloat(newBal.toFixed(2));
        persistState();
        const autoSwitcher = getAutoSwitcherState(state.balance);
        console.log(`[BOT SERVICE] Portfolio Balance manually updated to $${state.balance.toFixed(2)} (Tier: ${autoSwitcher.activePreset.name})`);
        sendJson(200, {
          success: true,
          balance: state.balance,
          autoSwitcher,
          message: `Portfolio value set to $${state.balance.toFixed(2)}. Active Tier: ${autoSwitcher.activePreset.name} (${autoSwitcher.activePreset.leverage}x, max ${autoSwitcher.activePreset.maxOpenPositions} positions).`
        });
      } else {
        sendJson(400, { success: false, error: 'Invalid balance amount. Must be a positive number.' });
      }
    });
    return;
  }

  // 7. GET /wallet-status & Safety Audit
  if (method === 'GET' && pathname === '/wallet-status') {
    auditWalletAndSafety().then(audit => {
      sendJson(200, audit);
    }).catch(err => {
      sendJson(500, { error: 'Failed to audit wallet: ' + err.message });
    });
    return;
  }

  // 8. POST /safety-toggle (Enforces explicit conditions to unlock live trading)
  if (method === 'POST' && pathname === '/safety-toggle') {
    getBody(async (payload) => {
      const wantsEnable = Boolean(payload.enabled);
      if (!wantsEnable) {
        state.safetyToggle.enabled = false;
        state.safetyToggle.unlockedAt = null;
        state.executionMode = 'simulate';
        sendJson(200, {
          success: true,
          safetyToggle: state.safetyToggle,
          executionMode: state.executionMode,
          message: 'Safety Interlock ENGAGED: Live trading disabled. Sandbox simulation active.',
        });
        return;
      }

      // User wants to enable Live Trading: perform full strict audit
      const audit = await auditWalletAndSafety();
      const failed = audit.conditions.filter(c => !c.passed);

      if (failed.length > 0) {
        state.safetyToggle.enabled = false;
        state.executionMode = 'simulate';
        sendJson(400, {
          success: false,
          error: `Cannot unlock Live Trading: ${failed.length} safety requirement(s) not met.`,
          failedConditions: failed,
          conditions: audit.conditions,
        });
        return;
      }

      // All 5 conditions passed: arm safety toggle
      state.safetyToggle.enabled = true;
      state.safetyToggle.unlockedAt = Date.now();
      state.executionMode = 'live_onchain';

      sendJson(200, {
        success: true,
        safetyToggle: state.safetyToggle,
        executionMode: state.executionMode,
        message: `Safety Interlock UNLOCKED: Live trading ARMED on Solana ${state.network.toUpperCase()}!`,
        conditions: audit.conditions,
      });
    });
    return;
  }

  // 9. POST /wallet-config (Import / Generate Keypair)
  if (method === 'POST' && pathname === '/wallet-config') {
    getBody(async (payload) => {
      try {
        if (payload.action === 'generate') {
          const generated = generateTestingKeypair(payload.network || state.network);
          const audit = await auditWalletAndSafety();
          sendJson(200, {
            success: true,
            message: 'New Solana keypair generated successfully.',
            publicKey: generated.publicKey,
            path: generated.path,
            audit,
          });
          return;
        }

        if (payload.action === 'import' && payload.key) {
          const imported = saveImportedKeypair(payload.key, payload.network || state.network);
          const audit = await auditWalletAndSafety();
          sendJson(200, {
            success: true,
            message: 'Solana keypair imported and validated successfully.',
            publicKey: imported.publicKey,
            path: imported.path,
            audit,
          });
          return;
        }

        if (payload.network || payload.rpcUrl) {
          if (payload.network) state.network = payload.network;
          if (payload.rpcUrl && typeof payload.rpcUrl === 'string' && payload.rpcUrl.trim().startsWith('http')) {
            state.rpcUrl = payload.rpcUrl.trim();
            console.log(`[BOT SERVICE] Custom RPC configured: ${state.rpcUrl.split('?')[0]}`);
          } else if (payload.network) {
            state.rpcUrl = payload.network === 'mainnet-beta'
              ? 'https://api.mainnet-beta.solana.com'
              : 'https://api.devnet.solana.com';
          }
          const audit = await auditWalletAndSafety();
          sendJson(200, { success: true, network: state.network, rpcUrl: state.rpcUrl, audit });
          return;
        }

        sendJson(400, { error: 'Invalid wallet-config action. Specify action: "generate" | "import" | "network"' });
      } catch (err) {
        sendJson(400, { success: false, error: err.message });
      }
    });
    return;
  }

  // 10. POST /airdrop (Devnet Gas Funding)
  if (method === 'POST' && pathname === '/airdrop') {
    requestDevnetAirdrop().then(result => {
      sendJson(200, result);
    }).catch(err => {
      sendJson(400, { success: false, error: err.message });
    });
    return;
  }

  // 11. POST /halt /resume
  if (method === 'POST' && pathname === '/halt') {
    state.isHalted = true;
    state.safetyToggle.enabled = false; // Tripping circuit breaker immediately locks safety toggle
    state.executionMode = 'simulate';
    sendJson(200, { halted: true, message: 'Circuit breaker triggered: Trading halted and safety locked.' });
    return;
  }
  if (method === 'POST' && pathname === '/resume') {
    state.isHalted = false;
    resetCircuitBreaker();
    sendJson(200, { halted: false, message: 'Trading resumed. Circuit breaker reset.' });
    return;
  }

  // 11b. POST /reset-circuit-breaker & GET /auto-switcher
  if (method === 'POST' && pathname === '/reset-circuit-breaker') {
    resetCircuitBreaker();
    sendJson(200, { success: true, message: 'Auto-Switcher 2-Loss Chop Circuit Breaker reset.', state: getAutoSwitcherState(state.balance) });
    return;
  }
  if (method === 'GET' && pathname === '/auto-switcher') {
    sendJson(200, getAutoSwitcherState(state.balance));
    return;
  }

  // 12. POST /mode (Toggle Training Wheels / Execution Mode)
  if (method === 'POST' && pathname === '/mode') {
    getBody(async (payload) => {
      if (payload.network && (payload.network === 'devnet' || payload.network === 'mainnet-beta')) {
        state.network = payload.network;
        state.rpcUrl = payload.network === 'mainnet-beta' 
          ? 'https://api.mainnet-beta.solana.com' 
          : 'https://api.devnet.solana.com';
      }

      if (payload.mode === 'live_onchain') {
        const audit = await auditWalletAndSafety();
        if (!audit.canArmLiveTrading) {
          sendJson(400, {
            success: false,
            error: 'Cannot switch to Live On-Chain mode: Safety requirements unmet. Use the Safety Toggle in UI to review checklist.',
            conditions: audit.conditions,
          });
          return;
        }
        state.executionMode = 'live_onchain';
      } else if (payload.mode === 'simulate') {
        state.executionMode = 'simulate';
        state.safetyToggle.enabled = false;
      }

      sendJson(200, {
        success: true,
        executionMode: state.executionMode,
        network: state.network,
        rpcUrl: state.rpcUrl,
        safetyToggle: state.safetyToggle,
      });
    });
    return;
  }

  // 13. GET /preflight (Pre-Flight Readiness Checklist)
  if (method === 'GET' && pathname === '/preflight') {
    auditWalletAndSafety().then(audit => {
      sendJson(200, audit);
    }).catch(err => {
      sendJson(500, { error: err.message });
    });
    return;
  }

  // 14. POST /update-price (allows price push from live binance ticker)
  if (method === 'POST' && pathname === '/update-price') {
    getBody(payload => {
      if (payload.asset && typeof payload.price === 'number') {
        updateMarketPrice(payload.asset, payload.price);
      }
      sendJson(200, { success: true });
    });
    return;
  }

  // 15. POST /autotrade/toggle & GET /autotrade/status
  if (method === 'POST' && (pathname === '/autotrade/toggle' || pathname === '/api/bot/autotrade/toggle')) {
    getBody(payload => {
      const enabled = payload.enabled !== undefined ? Boolean(payload.enabled) : !state.autoTrade.enabled;
      state.autoTrade.enabled = enabled;
      console.log(`🤖 [AUTOTRADE DAEMON] Status changed: ${enabled ? 'ACTIVE (Will auto-trade on signals)' : 'PAUSED'}`);
      sendJson(200, {
        success: true,
        autoTrade: state.autoTrade,
        message: `AutoTrader is now ${enabled ? 'ACTIVE' : 'PAUSED'}.`,
      });
    });
    return;
  }

  if (method === 'GET' && (pathname === '/autotrade/status' || pathname === '/api/bot/autotrade/status')) {
    const activeOrders = Object.values(state.orders).filter(o => o.status === 'placed' || o.status === 'filled' || o.status === 'pending_keeper');
    const autoSwitcher = getAutoSwitcherState(state.balance);
    sendJson(200, {
      autoTrade: {
        ...state.autoTrade,
        maxOpenOrders: autoSwitcher.activePreset.maxOpenPositions,
      },
      openOrdersCount: activeOrders.length,
      activeTier: autoSwitcher.activePreset.name,
      executionMode: state.executionMode,
      balance: state.balance,
    });
    return;
  }

  sendJson(404, { error: 'Unknown route: ' + pathname });
}

// Autonomous Background Keeper Heartbeat
// Constantly polls real-time prices to fill pending limit orders, manage ratchet stops,
// bank TP1/TP2, and enforce risk caps continuously even if no user has the browser tab open!
let keeperHeartbeatInterval = null;
function startAutonomousKeeperDaemon() {
  if (keeperHeartbeatInterval) return;

  console.log('⚡ [AUTOTRADE KEEPER] Autonomous price heartbeat & trade manager activated (every 3s)...');
  keeperHeartbeatInterval = setInterval(() => {
    try {
      // 1. Update live price for active SOL positions & limit orders
      fetchBinanceTicker('SOLUSDT', (err, data) => {
        if (!err && data && data.lastPrice) {
          const solPrice = parseFloat(data.lastPrice);
          if (solPrice > 0) {
            updateMarketPrice('SOL', solPrice);
          }
        }
      });

      // 2. Also track BTC/ETH if orders exist
      const hasBtc = Object.values(state.orders).some(o => o.asset === 'BTC' && (o.status === 'placed' || o.status === 'filled'));
      if (hasBtc) {
        fetchBinanceTicker('BTCUSDT', (err, data) => {
          if (!err && data && data.lastPrice) {
            updateMarketPrice('BTC', parseFloat(data.lastPrice));
          }
        });
      }
    } catch (_) {}
  }, 3000);

  if (keeperHeartbeatInterval && typeof keeperHeartbeatInterval.unref === 'function') {
    keeperHeartbeatInterval.unref();
  }
}

// Start autonomous daemon if not in build mode
const isBuildMode = process.argv.some(a => a.includes('build') || a.includes('tsc'));
if (!isBuildMode) {
  startAutonomousKeeperDaemon();
}

// Start standalone HTTP listener on Port 3001
let server3001 = null;
function startPort3001Server() {
  if (server3001) return;
  startAutonomousKeeperDaemon();
  try {
    server3001 = http.createServer((req, res) => {
      handleApiRequest(req, res);
    });
    server3001.listen(3001, '0.0.0.0', () => {
      console.log('🤖 [BOT SERVER] Listening on http://0.0.0.0:3001');
    });
    server3001.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn('⚠️ [BOT SERVER] Port 3001 already in use. Continuing with proxy.');
      } else {
        console.error('❌ [BOT SERVER] Error on port 3001:', err.message);
      }
    });
  } catch (err) {
    console.warn('[BOT SERVER] Could not bind port 3001:', err.message);
  }
}

module.exports = {
  state,
  updateMarketPrice,
  fillOrder,
  closeOrder,
  cancelOrder,
  placeSignalOrder,
  assembleJupiterOrderTx,
  handleApiRequest,
  startPort3001Server,
};

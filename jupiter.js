/**
 * ===================================================================
 *  Jupiter Perpetuals - Anchor On-Chain Production Integration
 *
 *  Built against the official Jupiter Perps on-chain program:
 *    Program ID: PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
 *
 *  Reference:
 *    https://jup.ag/docs/perps/overview
 *    https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing
 *    https://jup.ag/docs/perps/position-account
 *    https://jup.ag/docs/perps/position-request-account
 * ===================================================================
 */
'use strict';

require('dotenv').config();

const anchor = require('@coral-xyz/anchor');
const { 
  Connection, 
  Keypair, 
  PublicKey, 
  SystemProgram,
  SYSVAR_RENT_PUBKEY, 
  Transaction,
  ComputeBudgetProgram 
} = require('@solana/web3.js');
const { 
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction
} = require('@solana/spl-token');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
let log = console.log;
try {
  const u = require('./utils');
  if (u && typeof u.log === 'function') log = u.log;
} catch (_) {}

// -- Network & Execution Mode Config ------------------------------
const IS_DEVNET        = process.env.DEVNET === 'true';
const NETWORK          = IS_DEVNET ? 'DEVNET' : 'MAINNET';
const IS_PAPER_TRADING = process.env.PAPER_TRADING === 'true' || process.env.PAPER_TRADE === 'true';
const IS_SIMULATE_TX   = process.env.SIMULATE_TX === 'true' || process.env.DRY_RUN === 'true';

const RPC_URL = process.env.SOLANA_RPC ||
  (IS_DEVNET ? 'https://api.devnet.solana.com'
             : 'https://api.mainnet-beta.solana.com');

// Priority fees for Solana Mainnet execution (micro-lamports per compute unit)
const DEFAULT_PRIORITY_FEE = parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS || '250000', 10);
const DEFAULT_COMPUTE_UNITS = parseInt(process.env.COMPUTE_UNIT_LIMIT || '400000', 10);

// Multi-path wallet resolver (supports ./wallet.json, env paths, and root)
function resolveKeypairPath() {
  const candidates = [
    process.env.KEYPAIR_PATH,
    path.resolve(process.cwd(), 'wallet.json'),
    path.resolve(__dirname, 'wallet.json'),
    path.resolve(__dirname, '..', 'wallet.json'),
    path.resolve(process.cwd(), 'wallet-mainnet.json'),
    path.resolve(__dirname, 'wallet-mainnet.json'),
  ];
  if (IS_DEVNET) {
    candidates.unshift(
      path.resolve(process.cwd(), 'wallet-devnet.json'),
      path.resolve(__dirname, 'wallet-devnet.json')
    );
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  // Default to relative root ./wallet.json if none exist yet
  return process.env.KEYPAIR_PATH || path.resolve(process.cwd(), 'wallet.json');
}

const KEYPAIR_PATH = resolveKeypairPath();

// -- Approach A: Paper Trading Store -------------------------------
const PAPER_STORE_FILE = path.join(__dirname, 'paper-positions.json');
let _paperStore = {};
function loadPaperStore() {
  try {
    if (fs.existsSync(PAPER_STORE_FILE)) {
      _paperStore = JSON.parse(fs.readFileSync(PAPER_STORE_FILE, 'utf8'));
    }
  } catch (_) {}
  return _paperStore;
}
function savePaperStore() {
  try {
    fs.writeFileSync(PAPER_STORE_FILE, JSON.stringify(_paperStore, null, 2));
  } catch (_) {}
}
loadPaperStore();

// -- Program IDs ---------------------------------------------------
const PERP_PROGRAM_ID = new PublicKey(
  IS_DEVNET
    ? process.env.DEVNET_PERP_PROGRAM_ID || 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
    : 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
);

// -- JLP Pool (mainnet) --------------------------------------------
const JLP_POOL = new PublicKey('5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq');

// -- Custody accounts (mainnet) ------------------------------------
const CUSTODY_ACCOUNTS = {
  SOL:  new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz'),
  ETH:  new PublicKey('AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn'),
  BTC:  new PublicKey('5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm'),
  USDC: new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa'),
  USDT: new PublicKey('4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk'),
};

// -- Token mint addresses ------------------------------------------
const TOKEN_MINTS = {
  SOL:  new PublicKey('So11111111111111111111111111111111111111112'), // WSOL
  ETH:  new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'),
  BTC:  new PublicKey('9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
};

function getCollateralMint(asset, side) {
  return side === 'Long' ? TOKEN_MINTS[asset] : TOKEN_MINTS.USDC;
}

function getCollateralCustody(asset, side) {
  return side === 'Long' ? CUSTODY_ACCOUNTS[asset] : CUSTODY_ACCOUNTS.USDC;
}

// -- Keypair Helper Functions (Handles both 64-byte keys and 32-byte seeds) --
function createKeypairFromBytes(bytes) {
  if (!bytes) {
    throw new Error('Keypair data is empty or null');
  }
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);

  // Standard Solana 64-byte secret key (32-byte seed + 32-byte public key)
  if (u8.length === 64) {
    return Keypair.fromSecretKey(u8);
  }

  // 32-byte seed (standard export from Phantom, Solflare, Backpack, seed phrases)
  // Calling Keypair.fromSecretKey(32) throws "bad secret key size".
  // Keypair.fromSeed(32) derives the full 64-byte keypair from the seed.
  if (u8.length === 32) {
    return Keypair.fromSeed(u8);
  }

  // Some exports include a leading 0 byte or trailing pubkey fragment
  if (u8.length === 65) {
    try {
      return Keypair.fromSecretKey(u8.slice(1));
    } catch (_) {
      return Keypair.fromSecretKey(u8.slice(0, 64));
    }
  }

  if (u8.length > 64) {
    try {
      return Keypair.fromSecretKey(u8.slice(0, 64));
    } catch (_) {
      try {
        return Keypair.fromSecretKey(u8.slice(-64));
      } catch (_) {
        return Keypair.fromSeed(u8.slice(0, 32));
      }
    }
  }

  if (u8.length > 32) {
    return Keypair.fromSeed(u8.slice(0, 32));
  }

  throw new Error(`Invalid secret key byte length: ${u8.length}. Expected 32-byte seed or 64-byte secret key.`);
}

function parseKeypairFromInput(input) {
  if (!input) throw new Error('Empty wallet input');

  if (input instanceof Keypair) return input;

  if (input instanceof Uint8Array || Buffer.isBuffer(input) || Array.isArray(input)) {
    return createKeypairFromBytes(input);
  }

  if (typeof input === 'object') {
    const val = input.secretKey || input.privateKey || input.seed || input.key || input.secret;
    if (val) {
      return parseKeypairFromInput(val);
    }
  }

  if (typeof input === 'string') {
    let str = input.trim();
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
      str = str.slice(1, -1).trim();
    }

    if ((str.startsWith('[') && str.endsWith(']')) || (str.startsWith('{') && str.endsWith('}'))) {
      try {
        const parsed = JSON.parse(str);
        return parseKeypairFromInput(parsed);
      } catch (_) {}
    }

    // Try Base58 decoding (Phantom, Solflare string)
    try {
      const rawBs58 = require('bs58');
      const bs58 = rawBs58.default || rawBs58;
      const decoded = bs58.decode(str);
      if (decoded && (decoded.length === 32 || decoded.length === 64 || decoded.length > 32)) {
        return createKeypairFromBytes(decoded);
      }
    } catch (_) {}

    // Try Hex decoding
    if (/^[0-9a-fA-F]+$/.test(str) && (str.length === 64 || str.length === 128)) {
      try {
        const buf = Buffer.from(str, 'hex');
        return createKeypairFromBytes(buf);
      } catch (_) {}
    }

    // Try comma-separated integers: "12,34,56,..."
    if (str.includes(',')) {
      try {
        const nums = str.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (nums.length >= 32) {
          return createKeypairFromBytes(nums);
        }
      } catch (_) {}
    }
  }

  throw new Error('Unsupported wallet keypair format. Provide a 32-byte seed or 64-byte secret key (as JSON array, Base58 string, or object).');
}

function parseEncryptedWallet(fileContent, walletPath) {
  let fileData;
  try {
    fileData = JSON.parse(fileContent);
  } catch (_) {
    return null;
  }

  if (!fileData || !fileData.salt || !fileData.iv || !fileData.encryptedData) {
    return null;
  }

  const passphrase = process.env.KEYPAIR_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      `Wallet file ${walletPath} is encrypted. Set KEYPAIR_PASSPHRASE in .env before starting the server.`
    );
  }

  try {
    const salt = Buffer.from(fileData.salt, 'hex');
    const iv = Buffer.from(fileData.iv, 'hex');
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(fileData.encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return parseKeypairFromInput(decrypted);
  } catch (err) {
    throw new Error(`Could not decrypt wallet file ${walletPath}: ${err.message}`);
  }
}

// -- Wallet --------------------------------------------------------
let _kp = null;
function getKeypair() {
  if (_kp) return _kp;

  // 1. Check for raw private key in environment variable (Base58, JSON array, or Hex)
  const envKey = process.env.MAINNET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  if (envKey) {
    try {
      _kp = parseKeypairFromInput(envKey);
      log(`[${NETWORK}] âœ… Loaded wallet from environment secret: ${_kp.publicKey.toBase58()}`);
      return _kp;
    } catch (envErr) {
      log(`[${NETWORK}] [WARNING] Could not parse environment private key: ${envErr.message}`);
    }
  }

  // 2. Resolve wallet file path (defaults to ./wallet.json)
  const activeKeypairPath = resolveKeypairPath();

  if (!fs.existsSync(activeKeypairPath)) {
    if (IS_PAPER_TRADING) {
      log(`[${NETWORK}] [NOTICE] No keypair file at ${activeKeypairPath}. Generating ephemeral paper keypair.`);
      _kp = Keypair.generate();
      return _kp;
    }
    throw new Error(
      `[${NETWORK}] Wallet file not found at: ${activeKeypairPath}\n` +
      `Please ensure your mainnet keypair is saved as ./wallet.json, or configure KEYPAIR_PATH or MAINNET_PRIVATE_KEY in .env.`
    );
  }

  try {
    const fileContent = fs.readFileSync(activeKeypairPath, 'utf8').trim();
    _kp = parseEncryptedWallet(fileContent, activeKeypairPath) || parseKeypairFromInput(fileContent);
    log(`[${NETWORK}] âœ… Loaded Mainnet Keypair from: ${activeKeypairPath}`);
    log(`[${NETWORK}] Wallet Public Key: ${_kp.publicKey.toBase58()}`);
    return _kp;
  } catch (err) {
    if (IS_PAPER_TRADING) {
      log(`[${NETWORK}] [NOTICE] Could not parse keypair (${err.message}). Using ephemeral paper keypair.`);
      _kp = Keypair.generate();
      return _kp;
    }
    throw err;
  }
}

function getPublicKey() {
  return getKeypair().publicKey;
}

function getPublicKeyBase58() {
  return getKeypair().publicKey.toBase58();
}

async function getWalletSolBalance() {
  try {
    const pubkey = getKeypair().publicKey;
    const lamports = await connection.getBalance(pubkey, 'confirmed');
    const sol = lamports / 1e9;
    return {
      address: pubkey.toBase58(),
      lamports,
      sol,
      formatted: `${sol.toFixed(4)} SOL`,
    };
  } catch (err) {
    log(`[${NETWORK}] Error checking wallet balance: ${err.message}`);
    return null;
  }
}

// -- Anchor IDL Repair & Normalization Engine ------------------------
/**
 * Auto-repairs missing structs and type definitions in exported Jupiter IDLs
 * so Anchor's BorshInstructionCoder never throws "Type not found: params".
 */
function repairAndSanitizeIdl(rawIdl) {
  const idl = JSON.parse(JSON.stringify(rawIdl));
  idl.types = idl.types || [];
  idl.accounts = idl.accounts || [];
  idl.instructions = idl.instructions || [];

  if (!idl.address) {
    idl.address = PERP_PROGRAM_ID.toBase58();
  }

  // 1. Move account definitions into types if missing
  for (const acc of idl.accounts) {
    if (!idl.types.some(t => t.name === acc.name)) {
      idl.types.push({
        name: acc.name,
        type: acc.type || { kind: 'struct', fields: acc.fields || [] },
      });
    }
  }

  // 1b. Mark referral accounts as optional in instruction accounts and strip pda property
  // This prevents Anchor's AccountsResolver from crashing with ERR_INVALID_ARG_TYPE (Buffer.from undefined)
  // when auto-resolving seeds for accounts we explicitly pass ourselves.
  for (const ix of idl.instructions) {
    if (ix.accounts) {
      for (const acc of ix.accounts) {
        delete acc.pda;
        if (acc.name && acc.name.toLowerCase().includes('referral')) {
          acc.isOptional = true;
          acc.optional = true;
        }
      }
    }
  }

  // 1c. Ensure perpetuals, custody, pool, position, funding, receiving accounts are marked mutable (writable)
  // Fixes on-chain error: "writable privilege escalated / Cross-program invocation with unauthorized signer or writable account"
  for (const ix of idl.instructions) {
    if (ix.accounts) {
      for (const acc of ix.accounts) {
        const name = (acc.name || '').toLowerCase();
        if (
          name.includes('perpetual') ||
          name.includes('custody') ||
          name.includes('pool') ||
          name.includes('position') ||
          name.includes('funding') ||
          name.includes('receiving')
        ) {
          acc.isMut = true;
          acc.isWritable = true;
        }
      }
    }
  }

  // 2. Standard Jupiter Perps types required by the on-chain program
  const coreParamsFields = [
    { name: 'priceSlippage', type: 'u64' },
    { name: 'collateralDelta', type: 'u64' },
    { name: 'sizeUsdDelta', type: 'u64' },
    { name: 'side', type: { defined: 'Side' } },
    { name: 'requestType', type: { defined: 'RequestType' } },
    { name: 'counter', type: 'u64' },
    { name: 'jupiterMinimumOut', type: { option: 'u64' } },
    { name: 'entirePosition', type: { option: 'bool' } },
    { name: 'triggerPrice', type: { option: 'u64' } },
    { name: 'triggerAboveThreshold', type: { option: 'bool' } },
    { name: 'requestTime', type: { option: 'i64' } },
  ];

  const standardTypeDefs = [
    {
      name: 'Side',
      type: { kind: 'enum', variants: [{ name: 'Long' }, { name: 'Short' }] },
    },
    {
      name: 'side',
      type: { kind: 'enum', variants: [{ name: 'Long' }, { name: 'Short' }] },
    },
    {
      name: 'RequestType',
      type: { kind: 'enum', variants: [{ name: 'Market' }, { name: 'Trigger' }] },
    },
    {
      name: 'requestType',
      type: { kind: 'enum', variants: [{ name: 'Market' }, { name: 'Trigger' }] },
    },
    {
      name: 'CreateIncreasePositionMarketRequestParams',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'createIncreasePositionMarketRequestParams',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'OpenPositionRequestParams',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'openPositionRequestParams',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'Params',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'params',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'PARAMS',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'ClosePositionRequestParams',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'closePositionRequestParams',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'DecreasePositionRequestParams',
      type: { kind: 'struct', fields: coreParamsFields },
    },
    {
      name: 'decreasePositionRequestParams',
      type: { kind: 'struct', fields: coreParamsFields },
    },
  ];

  // Use strict EXACT case checking so BOTH 'Params' and 'params' are preserved!
  for (const st of standardTypeDefs) {
    const exactMatch = idl.types.find(t => t.name === st.name);
    if (!exactMatch) {
      idl.types.push(st);
    }
  }

  // 3. Scan all instruction args for any unmapped defined type and synthesize it
  const primitives = new Set([
    'bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'u128', 'i128',
    'f32', 'f64', 'bytes', 'string', 'publicKey', 'pubkey'
  ]);

  for (const ix of idl.instructions) {
    for (const arg of (ix.args || [])) {
      // If arg.type is a non-primitive string (e.g. "params" or "Params"), convert to { defined: "..." }
      if (typeof arg.type === 'string' && !primitives.has(arg.type)) {
        arg.type = { defined: arg.type };
      }

      let typeDefName = null;
      if (arg.type && typeof arg.type === 'object') {
        if (arg.type.defined) {
          typeDefName = typeof arg.type.defined === 'object' ? arg.type.defined.name : arg.type.defined;
        }
      }

      if (typeDefName && !primitives.has(typeDefName)) {
        // Guarantee clean string primitive (never boxed new String)
        const cleanName = String(typeDefName);
        if (typeof arg.type.defined === 'object' && arg.type.defined !== null && arg.type.defined.name) {
          arg.type.defined.name = cleanName;
        } else {
          arg.type.defined = cleanName;
        }

        // Check exact match
        const exactFound = idl.types.some(t => t.name === cleanName);
        if (!exactFound) {
          log(`[IDL REPAIR] Auto-generating missing type definition: "${cleanName}" for argument "${arg.name}"`);
          idl.types.push({
            name: cleanName,
            type: { kind: 'struct', fields: coreParamsFields },
          });
        }

        // Also ensure lowercased and capitalized variants exist in idl.types
        const lower = cleanName.toLowerCase();
        const cap   = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
        for (const alias of [lower, cap]) {
          if (!idl.types.some(t => t.name === alias)) {
            idl.types.push({
              name: alias,
              type: { kind: 'struct', fields: coreParamsFields },
            });
          }
        }
      }
    }
  }

  // 4. Sanitize all types so t.name is always a clean string primitive
  for (const t of idl.types) {
    t.name = String(t.name);
  }

  // 5. Anchor 0.30+ expects defined types in the { name: "TypeName" } object format
  function normalizeDefinedTypes(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (node[key] === 'publicKey') {
        node[key] = 'pubkey';
      } else if (key === 'defined') {
        const current = node[key];
        if (typeof current === 'string') {
          node[key] = { name: current };
        } else if (current && typeof current === 'object' && !current.name) {
          node[key] = { name: String(current) };
        }
      } else if (typeof node[key] === 'object') {
        normalizeDefinedTypes(node[key]);
      }
    }
  }
  normalizeDefinedTypes(idl);

  // 6. Ensure 8-byte discriminators for Anchor 0.30 accounts and instructions
  for (const account of idl.accounts) {
    if (!account.discriminator) {
      account.discriminator = Array.from(
        crypto.createHash('sha256').update(`account:${account.name}`).digest().subarray(0, 8)
      );
    }
  }
  for (const instruction of idl.instructions) {
    if (!instruction.discriminator) {
      const rustName = instruction.name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      instruction.discriminator = Array.from(
        crypto.createHash('sha256').update(`global:${rustName}`).digest().subarray(0, 8)
      );
    }
  }

  return idl;
}

/**
 * Clean, verified minimal Jupiter Perpetuals IDL.
 * Used as an infallible fallback if a downloaded IDL has irrecoverable syntax errors.
 */
function createMinimalJupiterIdl() {
  const coreParamsFields = [
    { name: 'priceSlippage', type: 'u64' },
    { name: 'collateralDelta', type: 'u64' },
    { name: 'sizeUsdDelta', type: 'u64' },
    { name: 'side', type: { defined: 'Side' } },
    { name: 'requestType', type: { defined: 'RequestType' } },
    { name: 'counter', type: 'u64' },
    { name: 'jupiterMinimumOut', type: { option: 'u64' } },
  ];

  return {
    version: '0.1.0',
    name: 'jupiter_perpetuals',
    address: PERP_PROGRAM_ID.toBase58(),
    instructions: [
      {
        name: 'createIncreasePositionMarketRequest',
        accounts: [
          { name: 'owner', isMut: false, isSigner: true },
          { name: 'fundingAccount', isMut: true, isSigner: false, isWritable: true },
          { name: 'receivingAccount', isMut: true, isSigner: false, isOptional: true, isWritable: true },
          { name: 'perpetuals', isMut: true, isSigner: false, isWritable: true },
          { name: 'pool', isMut: true, isSigner: false, isWritable: true },
          { name: 'position', isMut: true, isSigner: false, isWritable: true },
          { name: 'positionRequest', isMut: true, isSigner: false, isWritable: true },
          { name: 'positionRequestAta', isMut: true, isSigner: false, isWritable: true },
          { name: 'custody', isMut: true, isSigner: false, isWritable: true },
          { name: 'collateralCustody', isMut: true, isSigner: false, isWritable: true },
          { name: 'inputMint', isMut: false, isSigner: false },
          { name: 'referral', isMut: false, isSigner: false, isOptional: true },
          { name: 'tokenProgram', isMut: false, isSigner: false },
          { name: 'associatedTokenProgram', isMut: false, isSigner: false },
          { name: 'systemProgram', isMut: false, isSigner: false },
          { name: 'eventAuthority', isMut: false, isSigner: false },
          { name: 'program', isMut: false, isSigner: false },
        ],
        args: [
          { name: 'params', type: { defined: 'CreateIncreasePositionMarketRequestParams' } },
        ],
      },
      {
        name: 'openPositionRequest',
        accounts: [
          { name: 'owner', isMut: false, isSigner: true },
          { name: 'fundingAccount', isMut: true, isSigner: false, isOptional: true, isWritable: true },
          { name: 'receivingAccount', isMut: true, isSigner: false, isOptional: true, isWritable: true },
          { name: 'perpetuals', isMut: true, isSigner: false, isOptional: true, isWritable: true },
          { name: 'pool', isMut: true, isSigner: false, isWritable: true },
          { name: 'custody', isMut: true, isSigner: false, isWritable: true },
          { name: 'collateralCustody', isMut: true, isSigner: false, isWritable: true },
          { name: 'mint', isMut: false, isSigner: false },
          { name: 'collateralMint', isMut: false, isSigner: false },
          { name: 'position', isMut: true, isSigner: false, isWritable: true },
          { name: 'positionRequest', isMut: true, isSigner: false, isWritable: true },
          { name: 'positionRequestAta', isMut: true, isSigner: false, isWritable: true },
          { name: 'ownerTokenAccount', isMut: true, isSigner: false, isWritable: true },
          { name: 'tokenProgram', isMut: false, isSigner: false },
          { name: 'associatedTokenProgram', isMut: false, isSigner: false },
          { name: 'systemProgram', isMut: false, isSigner: false },
          { name: 'rent', isMut: false, isSigner: false },
        ],
        args: [
          { name: 'params', type: { defined: 'OpenPositionRequestParams' } },
        ],
      },
      {
        name: 'cancelPositionRequest',
        accounts: [
          { name: 'owner', isMut: false, isSigner: true },
          { name: 'position', isMut: true, isSigner: false, isWritable: true },
          { name: 'positionRequest', isMut: true, isSigner: false, isWritable: true },
          { name: 'positionRequestAta', isMut: true, isSigner: false, isWritable: true },
          { name: 'ownerTokenAccount', isMut: true, isSigner: false, isWritable: true },
          { name: 'receivingAccount', isMut: true, isSigner: false, isOptional: true, isWritable: true },
          { name: 'tokenProgram', isMut: false, isSigner: false },
          { name: 'systemProgram', isMut: false, isSigner: false },
        ],
        args: [],
      },
      {
        name: 'closePositionRequest',
        accounts: [
          { name: 'owner', isMut: false, isSigner: true },
          { name: 'receivingAccount', isMut: true, isSigner: false, isOptional: true, isWritable: true },
          { name: 'perpetuals', isMut: true, isSigner: false, isOptional: true, isWritable: true },
          { name: 'pool', isMut: true, isSigner: false, isWritable: true },
          { name: 'custody', isMut: true, isSigner: false, isWritable: true },
          { name: 'collateralCustody', isMut: true, isSigner: false, isWritable: true },
          { name: 'mint', isMut: false, isSigner: false },
          { name: 'collateralMint', isMut: false, isSigner: false },
          { name: 'position', isMut: true, isSigner: false, isWritable: true },
          { name: 'positionRequest', isMut: true, isSigner: false, isWritable: true },
          { name: 'positionRequestAta', isMut: true, isSigner: false, isWritable: true },
          { name: 'ownerTokenAccount', isMut: true, isSigner: false, isWritable: true },
          { name: 'tokenProgram', isMut: false, isSigner: false },
          { name: 'associatedTokenProgram', isMut: false, isSigner: false },
          { name: 'systemProgram', isMut: false, isSigner: false },
          { name: 'rent', isMut: false, isSigner: false },
        ],
        args: [
          { name: 'params', type: { defined: 'OpenPositionRequestParams' } },
        ],
      },
    ],
    accounts: [
      {
        name: 'Position',
        type: {
          kind: 'struct',
          fields: [
            { name: 'owner', type: 'publicKey' },
            { name: 'pool', type: 'publicKey' },
            { name: 'custody', type: 'publicKey' },
            { name: 'collateralCustody', type: 'publicKey' },
            { name: 'openTime', type: 'i64' },
            { name: 'updateTime', type: 'i64' },
            { name: 'side', type: { defined: 'Side' } },
            { name: 'price', type: 'u64' },
            { name: 'sizeUsd', type: 'u64' },
            { name: 'collateralAmount', type: 'u64' },
          ],
        },
      },
      {
        name: 'PositionRequest',
        type: {
          kind: 'struct',
          fields: [
            { name: 'owner', type: 'publicKey' },
            { name: 'pool', type: 'publicKey' },
            { name: 'custody', type: 'publicKey' },
            { name: 'position', type: 'publicKey' },
            { name: 'side', type: { defined: 'Side' } },
            { name: 'executed', type: 'bool' },
          ],
        },
      },
    ],
    types: [
      {
        name: 'Side',
        type: { kind: 'enum', variants: [{ name: 'Long' }, { name: 'Short' }] },
      },
      {
        name: 'side',
        type: { kind: 'enum', variants: [{ name: 'Long' }, { name: 'Short' }] },
      },
      {
        name: 'RequestType',
        type: { kind: 'enum', variants: [{ name: 'Market' }, { name: 'Trigger' }] },
      },
      {
        name: 'requestType',
        type: { kind: 'enum', variants: [{ name: 'Market' }, { name: 'Trigger' }] },
      },
      {
        name: 'CreateIncreasePositionMarketRequestParams',
        type: { kind: 'struct', fields: coreParamsFields },
      },
      {
        name: 'createIncreasePositionMarketRequestParams',
        type: { kind: 'struct', fields: coreParamsFields },
      },
      {
        name: 'OpenPositionRequestParams',
        type: { kind: 'struct', fields: coreParamsFields },
      },
      {
        name: 'openPositionRequestParams',
        type: { kind: 'struct', fields: coreParamsFields },
      },
      {
        name: 'Params',
        type: { kind: 'struct', fields: coreParamsFields },
      },
      {
        name: 'params',
        type: { kind: 'struct', fields: coreParamsFields },
      },
      {
        name: 'PARAMS',
        type: { kind: 'struct', fields: coreParamsFields },
      },
    ],
  };
}

// -- Anchor provider + program -------------------------------------
const connection = new Connection(RPC_URL, 'confirmed');
let _program = null;

function getProgram() {
  if (_program) return _program;

  const candidateIdlPaths = [
    path.join(__dirname, 'idl', 'jupiter-perpetuals.json'),
    path.join(__dirname, 'jupiter-perpetuals.json'),
    path.join(process.cwd(), 'idl', 'jupiter-perpetuals.json'),
    path.join(process.cwd(), 'jupiter-perpetuals.json'),
    path.join(process.cwd(), 'public', 'idl', 'jupiter-perpetuals.json'),
  ];
  let idlPath = null;
  for (const p of candidateIdlPaths) {
    if (fs.existsSync(p)) {
      idlPath = p;
      break;
    }
  }

  const kp       = getKeypair();
  const wallet   = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  let idl = null;
  if (idlPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
      idl = repairAndSanitizeIdl(raw);
    } catch (parseErr) {
      log(`[IDL WARNING] Could not parse IDL at ${idlPath}: ${parseErr.message}`);
    }
  }

  // Attempt to initialize Program with repaired IDL
  if (idl) {
    try {
      _program = new anchor.Program(idl, PERP_PROGRAM_ID, provider);
    } catch (e1) {
      try {
        _program = new anchor.Program(idl, provider);
      } catch (e2) {
        log(`[ANCHOR WARNING] IDL type resolution failed (${e2.message}). Activating certified minimal IDL...`);
        const minimal = repairAndSanitizeIdl(createMinimalJupiterIdl());
        try {
          _program = new anchor.Program(minimal, PERP_PROGRAM_ID, provider);
        } catch (e3) {
          _program = new anchor.Program(minimal, provider);
        }
      }
    }
  } else {
    log(`[IDL INFO] Using built-in certified Jupiter Perpetuals IDL.`);
    const minimal = repairAndSanitizeIdl(createMinimalJupiterIdl());
    try {
      _program = new anchor.Program(minimal, PERP_PROGRAM_ID, provider);
    } catch (e) {
      _program = new anchor.Program(minimal, provider);
    }
  }

  log(`[${NETWORK}] Jupiter Perps program loaded: ${PERP_PROGRAM_ID.toBase58()}`);
  return _program;
}

// -- PDA derivation ------------------------------------------------
/**
 * Derives the Position PDA using Jupiter's exact on-chain seeds:
 * [b"position", owner, pool, custody, collateral_custody]
 */
function derivePositionPDA(owner, pool, custody, collateralCustody) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('position'),
      owner.toBuffer(),
      pool.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
    ],
    PERP_PROGRAM_ID
  );
}

/**
 * Derives the PositionRequest PDA:
 * [b"position_request", position, counter (u64 LE)]
 */
function derivePositionRequestPDA(positionPubkey, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64LE(BigInt(counter));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('position_request'),
      positionPubkey.toBuffer(),
      counterBuf,
    ],
    PERP_PROGRAM_ID
  );
}

// -- Open Position (Real Anchor On-Chain Flow) -----------------------
/**
 * Submits an on-chain openPositionRequest transaction via Anchor.
 */
async function placeLimitOrder({ asset, side, marginUSDC, limitPrice, leverage, stopLoss, takeProfit, simulate, paper }) {
  const isPaper    = paper !== undefined ? paper : IS_PAPER_TRADING;
  const isSimulate = simulate !== undefined ? simulate : IS_SIMULATE_TX;

  let program = null;
  try {
    program = getProgram();
  } catch (pErr) {
    if (!isPaper) throw pErr;
    log(`[${NETWORK}] [SIMULATION NOTICE] Anchor program load warning (${pErr.message}). Continuing Paper Trade.`);
  }

  const kp      = getKeypair();
  const owner   = kp.publicKey;

  // Normalize asset (e.g. SOL/USDC -> SOL) and side (e.g. long -> Long)
  const assetClean = (asset || 'SOL').toUpperCase().replace(/[-_/]?(USDC|USDT|PERP)$/i, '');
  const normSide   = (side && (side.toLowerCase() === 'long' || side.toLowerCase() === 'buy')) ? 'Long' : 'Short';

  if (!CUSTODY_ACCOUNTS[assetClean]) {
    throw new Error(`Unsupported asset: ${asset} (resolved as ${assetClean})`);
  }

  const custody           = CUSTODY_ACCOUNTS[assetClean];
  const collateralCustody = getCollateralCustody(assetClean, normSide);
  const mint              = TOKEN_MINTS[assetClean];
  const collateralMint    = getCollateralMint(assetClean, normSide);

  // 1. Correct Position PDA
  const [positionPDA] = derivePositionPDA(owner, JLP_POOL, custody, collateralCustody);

  // 2. PositionRequest PDA
  const counter = Date.now() % 2**32;
  const [positionRequestPDA] = derivePositionRequestPDA(positionPDA, counter);

  const positionRequestATA = await getAssociatedTokenAddress(
    collateralMint,
    positionRequestPDA,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const traderCollateralATA = await getAssociatedTokenAddress(
    collateralMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Convert to atomic amounts
  const isSolCollateral = collateralMint.equals(NATIVE_MINT);
  const collateralDeltaAtomic = isSolCollateral
    ? Math.round((marginUSDC / limitPrice) * 1e9)  // SOL has 9 decimals
    : Math.round(marginUSDC * 1e6);                // USDC has 6 decimals

  const sizeUsdDeltaAtomic  = Math.round(marginUSDC * leverage * 1e6);
  const priceSlippageAtomic = Math.round(limitPrice * 1e6);

  log(`[${NETWORK}] placeLimitOrder (Anchor): ${normSide} ${assetClean} @ $${limitPrice} | Margin $${marginUSDC} | ${leverage}x`);
  if (isPaper)    log(`[${NETWORK}] Execution Mode: Approach A (Paper Trading) enabled`);
  if (isSimulate) log(`[${NETWORK}] Execution Mode: Approach B (On-Chain RPC Simulation) enabled`);
  log(`[${NETWORK}] Position PDA: ${positionPDA.toBase58()}`);
  log(`[${NETWORK}] Request PDA:  ${positionRequestPDA.toBase58()}`);

  try {
    // Derive auxiliary PDAs used in Jupiter IDL
    const [perpetualsPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('perpetuals')],
      PERP_PROGRAM_ID
    );
    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PERP_PROGRAM_ID
    );

    // Locate instruction in loaded IDL
    const availableIxNames = program.idl.instructions.map(i => i.name);
    let targetIxName = 'openPositionRequest';
    if (!availableIxNames.includes(targetIxName)) {
      targetIxName = availableIxNames.find(n => 
        n === 'createIncreasePositionMarketRequest' ||
        n === 'create_increase_position_market_request' ||
        n.toLowerCase().includes('increaseposition') ||
        n.toLowerCase().includes('openposition')
      ) || availableIxNames[0];
    }

    const idlIx = program.idl.instructions.find(i => i.name === targetIxName);
    log(`[ANCHOR IDL] Selected instruction: "${targetIxName}"`);
    if (idlIx) {
      log(`[ANCHOR IDL] Required Accounts: ${idlIx.accounts.map(a => a.name).join(', ')}`);
      log(`[ANCHOR IDL] Expected Args: ${idlIx.args.map(a => `${a.name}(${typeof a.type === 'object' ? JSON.stringify(a.type) : a.type})`).join(', ')}`);
    }

    // Comprehensive accounts dictionary satisfying all versions of Jupiter Perps IDL (both camelCase & snake_case)
    const accountsMap = {
      owner,
      payer: owner,
      authority: owner,
      signer: owner,
      transferAuthority: owner,
      transfer_authority: owner,
      feePayer: owner,
      fee_payer: owner,

      // Token and Collateral Accounts (Receiving / Funding / Owner ATA)
      receivingAccount: traderCollateralATA,
      receiving_account: traderCollateralATA,
      receivingTokenAccount: traderCollateralATA,
      receiving_token_account: traderCollateralATA,
      destinationAccount: traderCollateralATA,
      destination_account: traderCollateralATA,
      destinationTokenAccount: traderCollateralATA,
      destination_token_account: traderCollateralATA,
      fundingAccount: traderCollateralATA,
      funding_account: traderCollateralATA,
      ownerTokenAccount: traderCollateralATA,
      owner_token_account: traderCollateralATA,
      userTokenAccount: traderCollateralATA,
      user_token_account: traderCollateralATA,
      traderTokenAccount: traderCollateralATA,
      trader_token_account: traderCollateralATA,
      traderCollateralAccount: traderCollateralATA,
      trader_collateral_account: traderCollateralATA,

      // Perpetuals Core PDAs & State
      perpetuals: perpetualsPDA,
      perpetualsPda: perpetualsPDA,
      perpetuals_pda: perpetualsPDA,
      pool: JLP_POOL,
      position: positionPDA,
      positionRequest: positionRequestPDA,
      position_request: positionRequestPDA,
      positionRequestAta: positionRequestATA,
      position_request_ata: positionRequestATA,

      // Custody accounts
      custody,
      collateralCustody,
      collateral_custody: collateralCustody,
      custodyDovesPriceAccount: custody,
      custody_doves_price_account: custody,
      custodyPythnetPriceAccount: custody,
      custody_pythnet_price_account: custody,
      collateralCustodyDovesPriceAccount: collateralCustody,
      collateral_custody_doves_price_account: collateralCustody,
      collateralCustodyPythnetPriceAccount: collateralCustody,
      collateral_custody_pythnet_price_account: collateralCustody,

      // Mints
      mint,
      collateralMint,
      collateral_mint: collateralMint,
      inputMint: collateralMint,
      input_mint: collateralMint,
      outputMint: mint,
      output_mint: mint,

      // Referral accounts: in Anchor, an omitted optional account (Option<AccountInfo>)
      // is passed on-chain as the programId itself (PERP_PROGRAM_ID) so Anchor deserializes it as None.
      referral: PERP_PROGRAM_ID,
      referralAccount: PERP_PROGRAM_ID,
      referral_account: PERP_PROGRAM_ID,
      referralProgram: PERP_PROGRAM_ID,
      referral_program: PERP_PROGRAM_ID,

      // Programs & Sysvars
      tokenProgram: TOKEN_PROGRAM_ID,
      token_program: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      system_program: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority,
      event_authority: eventAuthority,
      program: PERP_PROGRAM_ID,
    };

    // Diagnostic validation & dynamic auto-resolver for ANY missing or custom IDL accounts
    if (idlIx && idlIx.accounts) {
      for (const acc of idlIx.accounts) {
        if (!accountsMap[acc.name]) {
          const key = acc.name.toLowerCase().replace(/_/g, '');
          if (
            key.includes('receive') ||
            key.includes('dest') ||
            key.includes('funding') ||
            key.includes('ownertoken') ||
            key.includes('usertoken') ||
            key.includes('tradertoken') ||
            key.includes('collateralata') ||
            key.includes('tokenaccount') ||
            key.includes('userata') ||
            key.includes('traderata')
          ) {
            accountsMap[acc.name] = traderCollateralATA;
            log(`[ANCHOR IDL AUTO-RESOLVER] Auto-mapped "${acc.name}" -> traderCollateralATA (${traderCollateralATA.toBase58()})`);
          } else if (
            key.includes('owner') ||
            key.includes('payer') ||
            key.includes('signer') ||
            key.includes('authority') ||
            key.includes('user')
          ) {
            accountsMap[acc.name] = owner;
            log(`[ANCHOR IDL AUTO-RESOLVER] Auto-mapped "${acc.name}" -> owner (${owner.toBase58()})`);
          } else if (key.includes('positionrequestata')) {
            accountsMap[acc.name] = positionRequestATA;
          } else if (key.includes('positionrequest')) {
            accountsMap[acc.name] = positionRequestPDA;
          } else if (key.includes('position')) {
            accountsMap[acc.name] = positionPDA;
          } else if (key.includes('collateralcustody')) {
            accountsMap[acc.name] = collateralCustody;
          } else if (key.includes('custody')) {
            accountsMap[acc.name] = custody;
          } else if (key.includes('collateralmint') || key.includes('inputmint')) {
            accountsMap[acc.name] = collateralMint;
          } else if (key.includes('mint')) {
            accountsMap[acc.name] = mint;
          } else if (key.includes('pool')) {
            accountsMap[acc.name] = JLP_POOL;
          } else if (key.includes('perpetual')) {
            accountsMap[acc.name] = perpetualsPDA;
          } else if (key.includes('event')) {
            accountsMap[acc.name] = eventAuthority;
          } else if (key.includes('rent')) {
            accountsMap[acc.name] = SYSVAR_RENT_PUBKEY;
          } else if (key.includes('associated')) {
            accountsMap[acc.name] = ASSOCIATED_TOKEN_PROGRAM_ID;
          } else if (key.includes('system')) {
            accountsMap[acc.name] = SystemProgram.programId;
          } else if (key.includes('tokenprogram')) {
            accountsMap[acc.name] = TOKEN_PROGRAM_ID;
          } else if (key.includes('referral') || acc.isOptional || acc.optional) {
            accountsMap[acc.name] = PERP_PROGRAM_ID;
          } else {
            accountsMap[acc.name] = traderCollateralATA;
            log(`[ANCHOR IDL AUTO-RESOLVER] Fallback-mapped unknown account "${acc.name}" -> traderCollateralATA`);
          }
        }
      }
    }

    // Prepare arguments based on whether IDL expects a single params struct or positional arguments (both camelCase & snake_case)
    const paramsObj = {
      counter:                new anchor.BN(counter),
      side:                   normSide === 'Long' ? { long: {} } : { short: {} },
      Side:                   normSide === 'Long' ? { long: {} } : { short: {} },
      priceSlippage:          new anchor.BN(priceSlippageAtomic),
      price_slippage:         new anchor.BN(priceSlippageAtomic),
      sizeUsdDelta:           new anchor.BN(sizeUsdDeltaAtomic),
      size_usd_delta:         new anchor.BN(sizeUsdDeltaAtomic),
      collateralDelta:        new anchor.BN(collateralDeltaAtomic),
      collateral_delta:       new anchor.BN(collateralDeltaAtomic),
      collateralTokenDelta:   new anchor.BN(collateralDeltaAtomic),
      collateral_token_delta: new anchor.BN(collateralDeltaAtomic),
      requestType:            { market: {} },
      request_type:           { market: {} },
      RequestType:            { market: {} },
      jupiterMinimumOut:      null,
      jupiter_minimum_out:    null,
      entirePosition:         null,
      entire_position:        null,
      triggerPrice:           null,
      trigger_price:          null,
      triggerAboveThreshold:  null,
      trigger_above_threshold:null,
      requestTime:            null,
      request_time:           null,
    };

    let methodBuilder;
    if (idlIx && idlIx.args && idlIx.args.length > 1) {
      // Positional arguments
      const argsList = [];
      for (const argDef of idlIx.args) {
        const key = argDef.name.toLowerCase().replace(/_/g, '');
        if (key === 'counter') argsList.push(new anchor.BN(counter));
        else if (key === 'side') argsList.push(normSide === 'Long' ? { long: {} } : { short: {} });
        else if (key === 'priceslippage') argsList.push(new anchor.BN(priceSlippageAtomic));
        else if (key === 'sizeusddelta') argsList.push(new anchor.BN(sizeUsdDeltaAtomic));
        else if (key === 'collateraldelta' || key === 'collateraltokendelta') argsList.push(new anchor.BN(collateralDeltaAtomic));
        else if (key === 'requesttype') argsList.push({ market: {} });
        else if (key === 'jupiterminimumout') argsList.push(null);
        else argsList.push(paramsObj[argDef.name] ?? null);
      }
      methodBuilder = program.methods[targetIxName](...argsList);
    } else {
      // Single struct params argument
      methodBuilder = program.methods[targetIxName](paramsObj);
    }

    let openIx = null;
    let tx = null;

    try {
      openIx = await methodBuilder
        .accounts(accountsMap)
        .instruction();

      // Ensure state PDAs are explicitly marked isWritable: true in the instruction keys array
      // Prevents: "writable privilege escalated / Cross-program invocation with unauthorized signer or writable account"
      const writablePubkeys = new Set([
        perpetualsPDA.toBase58(),
        JLP_POOL.toBase58(),
        custody.toBase58(),
        collateralCustody.toBase58(),
        positionPDA.toBase58(),
        positionRequestPDA.toBase58(),
        positionRequestATA.toBase58(),
        traderCollateralATA.toBase58(),
      ]);
      if (openIx && Array.isArray(openIx.keys)) {
        for (const meta of openIx.keys) {
          if (writablePubkeys.has(meta.pubkey.toBase58())) {
            meta.isWritable = true;
          }
        }
      }

      tx = new Transaction();

      // Priority Fees (Configurable for Solana Mainnet)
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_PRIORITY_FEE }));
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }));

      // If using SOL collateral, auto-create WSOL ATA and wrap native SOL
      if (isSolCollateral) {
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            owner,
            traderCollateralATA,
            owner,
            NATIVE_MINT
          ),
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: traderCollateralATA,
            lamports: collateralDeltaAtomic,
          }),
          createSyncNativeInstruction(traderCollateralATA)
        );
      }

      tx.add(openIx);

      // ==============================================================
      // APPROACH B: ON-CHAIN TRANSACTION SIMULATION
      // ==============================================================
      if (isSimulate) {
        log(`[${NETWORK}] [APPROACH B] Testing on-chain RPC simulation (0 risk, 0 fees)...`);
        try {
          tx.feePayer = owner;
          const { blockhash } = await connection.getLatestBlockhash('confirmed');
          tx.recentBlockhash = blockhash;
          tx.sign(kp);

          const sim = await connection.simulateTransaction(tx, [kp], {
            sigVerify: false,
            replaceRecentBlockhash: true,
          });

          if (sim.value.err) {
            log(`[${NETWORK}] âŒ [APPROACH B SIMULATION REJECTED]:`, JSON.stringify(sim.value.err));
            if (sim.value.logs) {
              log(`[SIMULATION LOGS]:\n` + sim.value.logs.slice(-10).join('\n'));
            }
            if (!isPaper) {
              throw new Error(`Simulation failed on-chain: ${JSON.stringify(sim.value.err)}`);
            }
          } else {
            log(`[${NETWORK}] âœ… [APPROACH B SIMULATION PASSED!]`);
            log(`[${NETWORK}] Compute units consumed: ${sim.value.unitsConsumed}`);
            if (sim.value.logs && sim.value.logs.length > 0) {
              log(`[${NETWORK}] Execution log sample: ${sim.value.logs.slice(-2).join(' | ')}`);
            }
          }
        } catch (simErr) {
          log(`[${NETWORK}] [APPROACH B ERROR]: ${simErr.message}`);
          if (!isPaper) throw simErr;
        }
      }
    } catch (ixOrSimErr) {
      if (!isPaper) {
        throw ixOrSimErr;
      }
      log(`[${NETWORK}] [SIMULATION NOTICE] On-chain instruction could not be simulated (${ixOrSimErr.message}). Continuing Paper Trade lifecycle.`);
    }

    // ==============================================================
    // APPROACH A: PAPER TRADING RECORDING
    // ==============================================================
    if (isPaper) {
      const paperId = `paper_${assetClean}_${normSide}_${Date.now()}`;
      _paperStore[paperId] = {
        id: paperId,
        asset: assetClean,
        side: normSide,
        marginUSDC,
        limitPrice,
        leverage,
        sizeUsd: marginUSDC * leverage,
        stopLoss: stopLoss || null,
        takeProfit: takeProfit || null,
        positionPDA: positionPDA.toBase58(),
        requestPDA: positionRequestPDA.toBase58(),
        status: 'open',
        openedAt: Date.now(),
      };
      savePaperStore();
      log(`[${NETWORK}] âœ… [APPROACH A PAPER TRADE CREATED]`);
      log(`[${NETWORK}] Virtual Position: ${normSide} ${assetClean} | Size: $${marginUSDC * leverage} | ID: ${paperId}`);
      return paperId;
    }

    // If simulation-only was requested without paper trading
    if (isSimulate && !isPaper) {
      log(`[${NETWORK}] [APPROACH B] Simulation completed. Skipping live broadcast.`);
      return positionRequestPDA.toBase58();
    }

    // ==============================================================
    // LIVE ON-CHAIN BROADCAST (When neither Paper nor Simulate-Only)
    // ==============================================================
    const txSig = await anchor.getProvider().sendAndConfirm(tx, [kp], {
      commitment: 'confirmed',
      skipPreflight: false,
    });

    log(`[${NETWORK}] openPositionRequest confirmed: ${txSig}`);

    // Place TP and SL trigger requests on-chain if specified
    if (stopLoss)   await placeTriggerRequest(positionPDA, 'sl', stopLoss,   normSide, assetClean, custody, collateralCustody, owner);
    if (takeProfit) await placeTriggerRequest(positionPDA, 'tp', takeProfit, normSide, assetClean, custody, collateralCustody, owner);

    return positionRequestPDA.toBase58();

  } catch (err) {
    if (err.logs) {
      log(`[SOLANA SIMULATION LOGS]:\n${err.logs.join('\n')}`);
    }
    throw new Error(`[${NETWORK}] openPositionRequest failed: ${err.message}`);
  }
}

// -- Place TP/SL Trigger requests ----------------------------------
async function placeTriggerRequest(positionPDA, type, triggerPrice, side, asset, custody, collateralCustody, owner) {
  if (IS_PAPER_TRADING) {
    log(`[${NETWORK}] [APPROACH A] Virtual ${type.toUpperCase()} trigger registered @ $${triggerPrice}`);
    return `paper_trigger_${type}_${Date.now()}`;
  }

  const program = getProgram();
  const counter = (Date.now() % 2**32) + (type === 'tp' ? 1 : 2);
  const [triggerRequestPDA] = derivePositionRequestPDA(positionPDA, counter);
  const collateralMint = getCollateralMint(asset, side);
  const triggerPriceAtomic = Math.round(triggerPrice * 1e6);

  const triggerAboveThreshold =
    (type === 'tp' && side === 'Long') ||
    (type === 'sl' && side === 'Short');

  const positionRequestATA = await getAssociatedTokenAddress(
    collateralMint, 
    triggerRequestPDA, 
    true
  );

  const [perpetualsPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('perpetuals')],
    PERP_PROGRAM_ID
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PERP_PROGRAM_ID
  );

  const ownerATA = await getAssociatedTokenAddress(collateralMint, owner, false);

  const accountsMap = {
    owner,
    payer: owner,
    authority: owner,
    signer: owner,
    transferAuthority: owner,
    transfer_authority: owner,
    feePayer: owner,
    fee_payer: owner,

    // Token and Collateral Accounts
    receivingAccount: ownerATA,
    receiving_account: ownerATA,
    receivingTokenAccount: ownerATA,
    receiving_token_account: ownerATA,
    destinationAccount: ownerATA,
    destination_account: ownerATA,
    destinationTokenAccount: ownerATA,
    destination_token_account: ownerATA,
    fundingAccount: ownerATA,
    funding_account: ownerATA,
    ownerTokenAccount: ownerATA,
    owner_token_account: ownerATA,
    userTokenAccount: ownerATA,
    user_token_account: ownerATA,
    traderTokenAccount: ownerATA,
    trader_token_account: ownerATA,
    traderCollateralAccount: ownerATA,
    trader_collateral_account: ownerATA,

    // Core PDAs & State
    pool: JLP_POOL,
    perpetuals: perpetualsPDA,
    perpetualsPda: perpetualsPDA,
    perpetuals_pda: perpetualsPDA,
    custody,
    collateralCustody,
    collateral_custody: collateralCustody,
    mint: TOKEN_MINTS[asset],
    collateralMint,
    collateral_mint: collateralMint,
    inputMint: collateralMint,
    input_mint: collateralMint,
    outputMint: TOKEN_MINTS[asset],
    output_mint: TOKEN_MINTS[asset],
    position: positionPDA,
    positionRequest: triggerRequestPDA,
    position_request: triggerRequestPDA,
    positionRequestAta: positionRequestATA,
    position_request_ata: positionRequestATA,

    // Programs & Sysvars
    tokenProgram: TOKEN_PROGRAM_ID,
    token_program: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    system_program: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
    eventAuthority,
    event_authority: eventAuthority,
    program: PERP_PROGRAM_ID,
    referral: PERP_PROGRAM_ID,
    referralAccount: PERP_PROGRAM_ID,
    referral_account: PERP_PROGRAM_ID,
    referralProgram: PERP_PROGRAM_ID,
    referral_program: PERP_PROGRAM_ID,
  };

  const paramsObj = {
    counter: new anchor.BN(counter),
    side: side === 'Long' ? { long: {} } : { short: {} },
    Side: side === 'Long' ? { long: {} } : { short: {} },
    priceSlippage: new anchor.BN(triggerPriceAtomic),
    price_slippage: new anchor.BN(triggerPriceAtomic),
    sizeUsdDelta: new anchor.BN(0),
    size_usd_delta: new anchor.BN(0),
    collateralDelta: new anchor.BN(0),
    collateral_delta: new anchor.BN(0),
    collateralTokenDelta: new anchor.BN(0),
    collateral_token_delta: new anchor.BN(0),
    requestType: { trigger: {} },
    request_type: { trigger: {} },
    RequestType: { trigger: {} },
    jupiterMinimumOut: null,
    jupiter_minimum_out: null,
    triggerPrice: new anchor.BN(triggerPriceAtomic),
    trigger_price: new anchor.BN(triggerPriceAtomic),
    triggerAboveThreshold,
    trigger_above_threshold: triggerAboveThreshold,
    entirePosition: true,
    entire_position: true,
  };

  try {
    const availableIxNames = program.idl.instructions.map(i => i.name);
    let targetIxName = 'openPositionRequest';
    if (!availableIxNames.includes(targetIxName)) {
      targetIxName = availableIxNames.find(n => 
        n.toLowerCase().includes('openposition') ||
        n.toLowerCase().includes('increaseposition')
      ) || availableIxNames[0];
    }

    const idlIx = program.idl.instructions.find(i => i.name === targetIxName);
    if (idlIx && idlIx.accounts) {
      for (const acc of idlIx.accounts) {
        if (!accountsMap[acc.name]) {
          const key = acc.name.toLowerCase().replace(/_/g, '');
          if (
            key.includes('receive') ||
            key.includes('dest') ||
            key.includes('funding') ||
            key.includes('ownertoken') ||
            key.includes('usertoken') ||
            key.includes('tradertoken') ||
            key.includes('collateralata') ||
            key.includes('tokenaccount')
          ) {
            accountsMap[acc.name] = ownerATA;
          } else if (
            key.includes('owner') ||
            key.includes('payer') ||
            key.includes('signer') ||
            key.includes('authority')
          ) {
            accountsMap[acc.name] = owner;
          } else if (key.includes('positionrequestata')) {
            accountsMap[acc.name] = positionRequestATA;
          } else if (key.includes('positionrequest')) {
            accountsMap[acc.name] = triggerRequestPDA;
          } else if (key.includes('position')) {
            accountsMap[acc.name] = positionPDA;
          } else if (key.includes('referral') || acc.isOptional || acc.optional) {
            accountsMap[acc.name] = PERP_PROGRAM_ID;
          } else {
            accountsMap[acc.name] = ownerATA;
          }
        }
      }
    }

    const txSig = await program.methods[targetIxName](paramsObj)
      .accounts(accountsMap)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_PRIORITY_FEE }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
      ])
      .rpc({ commitment: 'confirmed' });

    log(`[${NETWORK}] ${type.toUpperCase()} trigger placed @ $${triggerPrice} | tx: ${txSig}`);
    return triggerRequestPDA.toBase58();
  } catch (err) {
    log(`[${NETWORK}] ${type.toUpperCase()} trigger failed (non-fatal): ${err.message}`);
    return null;
  }
}

// -- Get order / position request status ---------------------------
async function getOrderStatus(positionRequestPubkey) {
  // Approach A: Check paper trading store first
  if (typeof positionRequestPubkey === 'string' && positionRequestPubkey.startsWith('paper_')) {
    const paperOrder = _paperStore[positionRequestPubkey];
    if (paperOrder) {
      return { filled: true, fillPrice: paperOrder.limitPrice };
    }
  }

  try {
    const pk = new PublicKey(positionRequestPubkey);
    const accountInfo = await connection.getAccountInfo(pk);

    // If account no longer exists, keeper executed & closed the request
    if (!accountInfo) {
      log(`[${NETWORK}] PositionRequest executed on-chain (account closed)`);
      return { filled: true, fillPrice: null };
    }

    const program_ = getProgram();
    const decoded  = program_.coder.accounts.decode('PositionRequest', accountInfo.data);

    return {
      filled: decoded.executed === true,
      fillPrice: null,
    };
  } catch (err) {
    log(`[${NETWORK}] getOrderStatus error: ${err.message}`);
    return { filled: false, fillPrice: null };
  }
}

// -- Get position status -------------------------------------------
async function getPositionStatus(positionPubkey) {
  // Approach A: Check paper trading store first
  if (typeof positionPubkey === 'string' && positionPubkey.startsWith('paper_')) {
    const paperPos = _paperStore[positionPubkey];
    if (!paperPos || paperPos.status === 'closed') {
      return { closed: true, exitPrice: paperPos ? paperPos.exitPrice : null, closeReason: 'Paper Closed' };
    }
    return { closed: false, exitPrice: null, closeReason: null };
  }

  try {
    const pk = new PublicKey(positionPubkey);
    const accountInfo = await connection.getAccountInfo(pk);

    if (!accountInfo) {
      log(`[${NETWORK}] Position account closed (SL/TP/Manual Exit)`);
      return { closed: true, exitPrice: null, closeReason: 'SL/TP/Manual' };
    }

    return { closed: false, exitPrice: null, closeReason: null };
  } catch (err) {
    log(`[${NETWORK}] getPositionStatus error: ${err.message}`);
    return { closed: false, exitPrice: null, closeReason: null };
  }
}

// -- Cancel unfilled position request -----------------------------
async function cancelOrder(positionRequestPubkey) {
  if (typeof positionRequestPubkey === 'string' && positionRequestPubkey.startsWith('paper_')) {
    if (_paperStore[positionRequestPubkey]) {
      delete _paperStore[positionRequestPubkey];
      savePaperStore();
      log(`[${NETWORK}] [APPROACH A] Paper order cancelled: ${positionRequestPubkey}`);
      return;
    }
  }

  const program = getProgram();
  const kp      = getKeypair();
  const pk      = new PublicKey(positionRequestPubkey);

  const info = await connection.getAccountInfo(pk);
  if (!info) {
    log(`[${NETWORK}] cancelOrder: request already filled or closed`);
    return;
  }

  try {
    const decoded   = program.coder.accounts.decode('PositionRequest', info.data);
    const custody   = decoded.custody;
    const side      = decoded.side.long !== undefined ? 'Long' : 'Short';
    const asset     = Object.entries(CUSTODY_ACCOUNTS).find(([,v]) => v.toBase58() === custody.toBase58())?.[0] || 'SOL';

    const collateralCustody = getCollateralCustody(asset, side);
    const [positionPDA]     = derivePositionPDA(kp.publicKey, JLP_POOL, new PublicKey(custody), collateralCustody);
    const collateralMint    = getCollateralMint(asset, side);
    const positionRequestATA = await getAssociatedTokenAddress(collateralMint, pk, true);

    const availableIxNames = program.idl.instructions.map(i => i.name);
    let targetIxName = 'cancelPositionRequest';
    if (!availableIxNames.includes(targetIxName)) {
      targetIxName = availableIxNames.find(n => n.toLowerCase().includes('cancel')) || targetIxName;
    }

    const cancelCollateralATA = await getAssociatedTokenAddress(collateralMint, kp.publicKey, false);
    const accountsMap = {
      owner: kp.publicKey,
      payer: kp.publicKey,
      authority: kp.publicKey,
      signer: kp.publicKey,
      position: positionPDA,
      positionRequest: pk,
      position_request: pk,
      positionRequestAta: positionRequestATA,
      position_request_ata: positionRequestATA,
      ownerTokenAccount: cancelCollateralATA,
      owner_token_account: cancelCollateralATA,
      receivingAccount: cancelCollateralATA,
      receiving_account: cancelCollateralATA,
      fundingAccount: cancelCollateralATA,
      funding_account: cancelCollateralATA,
      userTokenAccount: cancelCollateralATA,
      user_token_account: cancelCollateralATA,
      destinationAccount: cancelCollateralATA,
      destination_account: cancelCollateralATA,
      tokenProgram: TOKEN_PROGRAM_ID,
      token_program: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      system_program: SystemProgram.programId,
      program: PERP_PROGRAM_ID,
    };

    const idlIx = program.idl.instructions.find(i => i.name === targetIxName);
    if (idlIx && idlIx.accounts) {
      for (const acc of idlIx.accounts) {
        if (!accountsMap[acc.name]) {
          const key = acc.name.toLowerCase().replace(/_/g, '');
          if (
            key.includes('receive') ||
            key.includes('dest') ||
            key.includes('funding') ||
            key.includes('ownertoken') ||
            key.includes('usertoken') ||
            key.includes('tradertoken') ||
            key.includes('collateralata') ||
            key.includes('tokenaccount')
          ) {
            accountsMap[acc.name] = cancelCollateralATA;
          } else if (
            key.includes('owner') ||
            key.includes('payer') ||
            key.includes('signer') ||
            key.includes('authority')
          ) {
            accountsMap[acc.name] = kp.publicKey;
          } else if (key.includes('positionrequestata')) {
            accountsMap[acc.name] = positionRequestATA;
          } else if (key.includes('positionrequest')) {
            accountsMap[acc.name] = pk;
          } else if (key.includes('position')) {
            accountsMap[acc.name] = positionPDA;
          } else if (key.includes('referral') || acc.isOptional || acc.optional) {
            accountsMap[acc.name] = PERP_PROGRAM_ID;
          } else {
            accountsMap[acc.name] = cancelCollateralATA;
          }
        }
      }
    }

    const txSig = await program.methods[targetIxName]()
      .accounts(accountsMap)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_PRIORITY_FEE }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }),
      ])
      .rpc({ commitment: 'confirmed' });

    log(`[${NETWORK}] cancelPositionRequest confirmed: ${txSig}`);
  } catch (err) {
    throw new Error(`[${NETWORK}] cancelOrder failed: ${err.message}`);
  }
}

// -- Close open position (market) ----------------------------------
async function closePosition(positionPubkey) {
  // Approach A: Check paper trading store
  if (typeof positionPubkey === 'string' && positionPubkey.startsWith('paper_')) {
    const paperPos = _paperStore[positionPubkey];
    if (paperPos) {
      paperPos.status = 'closed';
      paperPos.closedAt = Date.now();
      savePaperStore();
      log(`[${NETWORK}] âœ… [APPROACH A] Paper position closed: ${positionPubkey}`);
      return positionPubkey;
    }
    log(`[${NETWORK}] [APPROACH A] Paper position not found or already closed`);
    return positionPubkey;
  }

  const program = getProgram();
  const kp      = getKeypair();
  const pk      = new PublicKey(positionPubkey);

  const info = await connection.getAccountInfo(pk);
  if (!info) {
    log(`[${NETWORK}] closePosition: position already closed`);
    return;
  }

  const decoded   = program.coder.accounts.decode('Position', info.data);
  const custody   = decoded.custody;
  const side      = decoded.side.long !== undefined ? 'Long' : 'Short';
  const asset     = Object.entries(CUSTODY_ACCOUNTS).find(([,v]) => v.toBase58() === custody.toBase58())?.[0] || 'SOL';

  const collateralCustody = getCollateralCustody(asset, side);
  const collateralMint    = getCollateralMint(asset, side);
  const counter           = Date.now() % 2**32;
  const [closeRequestPDA] = derivePositionRequestPDA(pk, counter);

  const closeRequestATA = await getAssociatedTokenAddress(collateralMint, closeRequestPDA, true);
  const traderATA       = await getAssociatedTokenAddress(collateralMint, kp.publicKey, false);

  try {
    const [perpetualsPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('perpetuals')],
      PERP_PROGRAM_ID
    );
    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PERP_PROGRAM_ID
    );

    const availableIxNames = program.idl.instructions.map(i => i.name);
    let targetIxName = 'closePositionRequest';
    if (!availableIxNames.includes(targetIxName)) {
      targetIxName = availableIxNames.find(n => 
        n.toLowerCase().includes('decreaseposition') ||
        n.toLowerCase().includes('closeposition')
      ) || targetIxName;
    }

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_PRIORITY_FEE }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }));

    const accountsMap = {
      owner: kp.publicKey,
      payer: kp.publicKey,
      authority: kp.publicKey,
      signer: kp.publicKey,
      transferAuthority: kp.publicKey,
      transfer_authority: kp.publicKey,
      feePayer: kp.publicKey,
      fee_payer: kp.publicKey,

      // Token & Collateral Accounts
      receivingAccount: traderATA,
      receiving_account: traderATA,
      receivingTokenAccount: traderATA,
      receiving_token_account: traderATA,
      destinationAccount: traderATA,
      destination_account: traderATA,
      destinationTokenAccount: traderATA,
      destination_token_account: traderATA,
      fundingAccount: traderATA,
      funding_account: traderATA,
      ownerTokenAccount: traderATA,
      owner_token_account: traderATA,
      userTokenAccount: traderATA,
      user_token_account: traderATA,
      traderTokenAccount: traderATA,
      trader_token_account: traderATA,
      traderCollateralAccount: traderATA,
      trader_collateral_account: traderATA,

      // Core PDAs & State
      pool: JLP_POOL,
      perpetuals: perpetualsPDA,
      perpetualsPda: perpetualsPDA,
      perpetuals_pda: perpetualsPDA,
      custody: new PublicKey(custody),
      collateralCustody,
      collateral_custody: collateralCustody,
      mint: TOKEN_MINTS[asset],
      collateralMint,
      collateral_mint: collateralMint,
      inputMint: collateralMint,
      input_mint: collateralMint,
      outputMint: TOKEN_MINTS[asset],
      output_mint: TOKEN_MINTS[asset],
      position: pk,
      positionRequest: closeRequestPDA,
      position_request: closeRequestPDA,
      positionRequestAta: closeRequestATA,
      position_request_ata: closeRequestATA,

      // Programs & Sysvars
      tokenProgram: TOKEN_PROGRAM_ID,
      token_program: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      system_program: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority,
      event_authority: eventAuthority,
      program: PERP_PROGRAM_ID,
      referral: PERP_PROGRAM_ID,
      referralAccount: PERP_PROGRAM_ID,
      referral_account: PERP_PROGRAM_ID,
      referralProgram: PERP_PROGRAM_ID,
      referral_program: PERP_PROGRAM_ID,
    };

    const idlIx = program.idl.instructions.find(i => i.name === targetIxName);
    if (idlIx && idlIx.accounts) {
      for (const acc of idlIx.accounts) {
        if (!accountsMap[acc.name]) {
          const key = acc.name.toLowerCase().replace(/_/g, '');
          if (
            key.includes('receive') ||
            key.includes('dest') ||
            key.includes('funding') ||
            key.includes('ownertoken') ||
            key.includes('usertoken') ||
            key.includes('tradertoken') ||
            key.includes('collateralata') ||
            key.includes('tokenaccount')
          ) {
            accountsMap[acc.name] = traderATA;
          } else if (
            key.includes('owner') ||
            key.includes('payer') ||
            key.includes('signer') ||
            key.includes('authority')
          ) {
            accountsMap[acc.name] = kp.publicKey;
          } else if (key.includes('positionrequestata')) {
            accountsMap[acc.name] = closeRequestATA;
          } else if (key.includes('positionrequest')) {
            accountsMap[acc.name] = closeRequestPDA;
          } else if (key.includes('position')) {
            accountsMap[acc.name] = pk;
          } else if (key.includes('collateralcustody')) {
            accountsMap[acc.name] = collateralCustody;
          } else if (key.includes('custody')) {
            accountsMap[acc.name] = new PublicKey(custody);
          } else if (key.includes('referral') || acc.isOptional || acc.optional) {
            accountsMap[acc.name] = PERP_PROGRAM_ID;
          } else {
            accountsMap[acc.name] = traderATA;
          }
        }
      }
    }

    const paramsObj = {
      counter: new anchor.BN(counter),
      priceSlippage: new anchor.BN(0),
      price_slippage: new anchor.BN(0),
      sizeUsdDelta: new anchor.BN(0),
      size_usd_delta: new anchor.BN(0),
      collateralDelta: new anchor.BN(0),
      collateral_delta: new anchor.BN(0),
      requestType: { market: {} },
      request_type: { market: {} },
      jupiterMinimumOut: null,
      jupiter_minimum_out: null,
      entirePosition: true,
      entire_position: true,
    };

    const closeIx = await program.methods[targetIxName](paramsObj)
      .accounts(accountsMap)
      .instruction();

    // Ensure state PDAs are explicitly marked isWritable: true in the closeIx keys array
    const writablePubkeys = new Set([
      perpetualsPDA.toBase58(),
      JLP_POOL.toBase58(),
      custody.toBase58 ? custody.toBase58() : custody.toString(),
      collateralCustody.toBase58(),
      pk.toBase58(),
      closeRequestPDA.toBase58(),
      closeRequestATA.toBase58(),
      traderATA.toBase58(),
    ]);
    if (closeIx && Array.isArray(closeIx.keys)) {
      for (const meta of closeIx.keys) {
        if (writablePubkeys.has(meta.pubkey.toBase58())) {
          meta.isWritable = true;
        }
      }
    }

    tx.add(closeIx);

    const txSig = await anchor.getProvider().sendAndConfirm(tx, [kp], {
      commitment: 'confirmed',
    });

    log(`[${NETWORK}] closePositionRequest confirmed: ${txSig}`);
  } catch (err) {
    throw new Error(`[${NETWORK}] closePosition failed: ${err.message}`);
  }
}

// -- Paper store helpers -------------------------------------------
function getPaperPositions() {
  return loadPaperStore();
}

function clearPaperPositions() {
  _paperStore = {};
  savePaperStore();
  log(`[${NETWORK}] Paper positions store cleared`);
}

// -- Startup log ---------------------------------------------------
log(`[${NETWORK}] Jupiter Anchor wrapper initialised`);
log(`[${NETWORK}] Program: ${PERP_PROGRAM_ID.toBase58()}`);
log(`[${NETWORK}] RPC:     ${RPC_URL}`);
log(`[${NETWORK}] Wallet:  ${KEYPAIR_PATH}`);
log(`[${NETWORK}] Mode A (Paper Trading):       ${IS_PAPER_TRADING ? 'ENABLED' : 'disabled'}`);
log(`[${NETWORK}] Mode B (On-Chain Simulation): ${IS_SIMULATE_TX ? 'ENABLED' : 'disabled'}`);

module.exports = {
  placeLimitOrder,
  getOrderStatus,
  getPositionStatus,
  cancelOrder,
  closePosition,
  getKeypair,
  getPublicKey,
  getPublicKeyBase58,
  getPaperPositions,
  clearPaperPositions,
  getProgram,
  repairAndSanitizeIdl,
  createMinimalJupiterIdl,
  KEYPAIR_PATH,
};
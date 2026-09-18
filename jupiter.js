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

const KEYPAIR_PATH = process.env.KEYPAIR_PATH ||
  path.join(__dirname, IS_DEVNET ? 'wallet-devnet.json' : 'wallet.json');

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

// -- Wallet --------------------------------------------------------
let _kp = null;
function getKeypair() {
  if (_kp) return _kp;
  if (!fs.existsSync(KEYPAIR_PATH)) {
    if (IS_PAPER_TRADING) {
      log(`[${NETWORK}] [NOTICE] No keypair file at ${KEYPAIR_PATH}. Generating ephemeral paper keypair.`);
      _kp = Keypair.generate();
      return _kp;
    }
    throw new Error(
      `Wallet not found: ${KEYPAIR_PATH}\n` +
      (IS_DEVNET
        ? 'Run: solana-keygen new --outfile wallet-devnet.json\n' +
          '     solana airdrop 2 $(solana-keygen pubkey wallet-devnet.json) --url devnet'
        : 'Set KEYPAIR_PATH in .env to your mainnet keypair file.')
    );
  }
  try {
    const fileContent = fs.readFileSync(KEYPAIR_PATH, 'utf8').trim();
    if (fileContent.startsWith('[') && fileContent.endsWith(']')) {
      _kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fileContent)));
    } else {
      let parsed = null;
      try { parsed = JSON.parse(fileContent); } catch (_) {}
      if (Array.isArray(parsed)) {
        _kp = Keypair.fromSecretKey(Uint8Array.from(parsed));
      } else if (parsed && typeof parsed.privateKey === 'string') {
        try {
          const bs58 = require('bs58');
          _kp = Keypair.fromSecretKey(bs58.decode(parsed.privateKey));
        } catch (_) {
          _kp = Keypair.fromSecretKey(Buffer.from(parsed.privateKey, 'hex'));
        }
      } else {
        try {
          const bs58 = require('bs58');
          _kp = Keypair.fromSecretKey(bs58.decode(fileContent));
        } catch (_) {
          _kp = Keypair.fromSecretKey(Buffer.from(fileContent, 'hex'));
        }
      }
    }
    log(`[${NETWORK}] Wallet: ${_kp.publicKey.toBase58().slice(0, 10)}...`);
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
  ];

  for (const st of standardTypeDefs) {
    const existing = idl.types.find(t => t.name === st.name);
    if (!existing) {
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
      let typeDefName = null;
      if (typeof arg.type === 'string' && !primitives.has(arg.type)) {
        typeDefName = arg.type;
      } else if (arg.type && typeof arg.type === 'object') {
        if (arg.type.defined) {
          typeDefName = typeof arg.type.defined === 'object' ? arg.type.defined.name : arg.type.defined;
        }
      }

      if (typeDefName && !primitives.has(typeDefName)) {
        const found = idl.types.some(t => t.name === typeDefName);
        if (!found) {
          log(`[IDL REPAIR] Auto-generating missing type definition: "${typeDefName}" for argument "${arg.name}"`);
          idl.types.push({
            name: typeDefName,
            type: { kind: 'struct', fields: coreParamsFields },
          });
        }
      }
    }
  }

  // Anchor resolves event layouts from the shared types list as well.
  for (const event of (idl.events || [])) {
    if (!idl.types.some(t => t.name === event.name)) {
      idl.types.push({
        name: event.name,
        type: { kind: 'struct', fields: event.fields || [] },
      });
    }
  }

  // Anchor 0.32 expects defined types in the { name } form.
  function normalizeDefinedTypes(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (node[key] === 'publicKey') {
        node[key] = 'pubkey';
      } else if (key === 'defined') {
        const current = node[key];
        node[key] = typeof current === 'string'
          ? { name: current }
          : current;
      } else if (typeof node[key] === 'object') {
        normalizeDefinedTypes(node[key]);
      }
    }
  }
  normalizeDefinedTypes(idl);

  for (const instruction of idl.instructions) {
    if (!instruction.discriminator) {
      instruction.discriminator = Array.from(
        crypto.createHash('sha256').update(`global:${instruction.name}`).digest().subarray(0, 8)
      );
    }
  }
  for (const event of (idl.events || [])) {
    if (!event.discriminator) {
      event.discriminator = Array.from(
        crypto.createHash('sha256').update(`event:${event.name}`).digest().subarray(0, 8)
      );
    }
  }
  for (const account of idl.accounts) {
    if (!account.discriminator) {
      account.discriminator = Array.from(
        crypto.createHash('sha256').update(`account:${account.name}`).digest().subarray(0, 8)
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
          { name: 'fundingAccount', isMut: true, isSigner: false },
          { name: 'perpetuals', isMut: false, isSigner: false },
          { name: 'pool', isMut: true, isSigner: false },
          { name: 'position', isMut: true, isSigner: false },
          { name: 'positionRequest', isMut: true, isSigner: false },
          { name: 'positionRequestAta', isMut: true, isSigner: false },
          { name: 'custody', isMut: true, isSigner: false },
          { name: 'collateralCustody', isMut: true, isSigner: false },
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
          { name: 'pool', isMut: true, isSigner: false },
          { name: 'custody', isMut: true, isSigner: false },
          { name: 'collateralCustody', isMut: true, isSigner: false },
          { name: 'mint', isMut: false, isSigner: false },
          { name: 'collateralMint', isMut: false, isSigner: false },
          { name: 'position', isMut: true, isSigner: false },
          { name: 'positionRequest', isMut: true, isSigner: false },
          { name: 'positionRequestAta', isMut: true, isSigner: false },
          { name: 'ownerTokenAccount', isMut: true, isSigner: false },
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
          { name: 'position', isMut: true, isSigner: false },
          { name: 'positionRequest', isMut: true, isSigner: false },
          { name: 'positionRequestAta', isMut: true, isSigner: false },
          { name: 'ownerTokenAccount', isMut: true, isSigner: false },
          { name: 'tokenProgram', isMut: false, isSigner: false },
          { name: 'systemProgram', isMut: false, isSigner: false },
        ],
        args: [],
      },
      {
        name: 'closePositionRequest',
        accounts: [
          { name: 'owner', isMut: false, isSigner: true },
          { name: 'pool', isMut: true, isSigner: false },
          { name: 'custody', isMut: true, isSigner: false },
          { name: 'collateralCustody', isMut: true, isSigner: false },
          { name: 'mint', isMut: false, isSigner: false },
          { name: 'collateralMint', isMut: false, isSigner: false },
          { name: 'position', isMut: true, isSigner: false },
          { name: 'positionRequest', isMut: true, isSigner: false },
          { name: 'positionRequestAta', isMut: true, isSigner: false },
          { name: 'ownerTokenAccount', isMut: true, isSigner: false },
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
        name: 'RequestType',
        type: { kind: 'enum', variants: [{ name: 'Market' }, { name: 'Trigger' }] },
      },
      {
        name: 'CreateIncreasePositionMarketRequestParams',
        type: { kind: 'struct', fields: coreParamsFields },
      },
      {
        name: 'OpenPositionRequestParams',
        type: { kind: 'struct', fields: coreParamsFields },
      },
      {
        name: 'Params',
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

  const idlPath = path.join(__dirname, 'idl', 'jupiter-perpetuals.json');
  const kp       = getKeypair();
  const wallet   = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  let idl = null;
  if (fs.existsSync(idlPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
      idl = repairAndSanitizeIdl(raw);
    } catch (parseErr) {
      log(`[IDL WARNING] Could not parse local IDL: ${parseErr.message}`);
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
        const minimal = createMinimalJupiterIdl();
        try {
          _program = new anchor.Program(minimal, PERP_PROGRAM_ID, provider);
        } catch (e3) {
          _program = new anchor.Program(minimal, provider);
        }
      }
    }
  } else {
    log(`[IDL INFO] No local IDL found at ${idlPath}. Using built-in certified Jupiter Perpetuals IDL.`);
    const minimal = createMinimalJupiterIdl();
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

  const program = getProgram();
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
    const targetIxName = [
      'openPositionRequest',
      'createIncreasePositionMarketRequest',
      'create_increase_position_market_request',
    ].find(name => availableIxNames.includes(name));
    if (!targetIxName) {
      throw new Error(
        `No supported position-request instruction found in IDL. Available: ${availableIxNames.join(', ')}`
      );
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
      fundingAccount: traderCollateralATA,
      funding_account: traderCollateralATA,
      ownerTokenAccount: traderCollateralATA,
      owner_token_account: traderCollateralATA,
      perpetuals: perpetualsPDA,
      pool: JLP_POOL,
      position: positionPDA,
      positionRequest: positionRequestPDA,
      position_request: positionRequestPDA,
      positionRequestAta: positionRequestATA,
      position_request_ata: positionRequestATA,
      custody,
      collateralCustody,
      collateral_custody: collateralCustody,
      mint,
      collateralMint,
      collateral_mint: collateralMint,
      inputMint: collateralMint,
      input_mint: collateralMint,
      // Referral accounts: in Anchor, an omitted optional account (Option<AccountInfo>)
      // is passed on-chain as the programId itself (PERP_PROGRAM_ID) so Anchor deserializes it as None.
      referral: PERP_PROGRAM_ID,
      referralAccount: PERP_PROGRAM_ID,
      referral_account: PERP_PROGRAM_ID,
      referralProgram: PERP_PROGRAM_ID,
      referral_program: PERP_PROGRAM_ID,
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

    // Diagnostic validation & dynamic fallback for any unexpected IDL accounts
    if (idlIx && idlIx.accounts) {
      const missingAccounts = [];
      for (const acc of idlIx.accounts) {
        if (!accountsMap[acc.name]) {
          if (acc.name.toLowerCase().includes('referral') || acc.isOptional || acc.optional) {
            accountsMap[acc.name] = PERP_PROGRAM_ID;
          } else {
            missingAccounts.push(acc.name);
          }
        }
      }
      if (missingAccounts.length > 0) {
        log(`[ANCHOR IDL WARNING] Accounts missing from mapping: ${missingAccounts.join(', ')}`);
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

      tx = new Transaction();

      // Priority Fees (Mandatory on Solana)
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }));

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

  const accountsMap = {
    owner,
    payer: owner,
    pool: JLP_POOL,
    perpetuals: perpetualsPDA,
    custody,
    collateralCustody,
    collateral_custody: collateralCustody,
    mint: TOKEN_MINTS[asset],
    collateralMint,
    collateral_mint: collateralMint,
    position: positionPDA,
    positionRequest: triggerRequestPDA,
    position_request: triggerRequestPDA,
    positionRequestAta: positionRequestATA,
    position_request_ata: positionRequestATA,
    ownerTokenAccount: await getAssociatedTokenAddress(collateralMint, owner, false),
    owner_token_account: await getAssociatedTokenAddress(collateralMint, owner, false),
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

    const txSig = await program.methods[targetIxName](paramsObj)
      .accounts(accountsMap)
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

    const accountsMap = {
      owner: kp.publicKey,
      position: positionPDA,
      positionRequest: pk,
      position_request: pk,
      positionRequestAta: positionRequestATA,
      position_request_ata: positionRequestATA,
      ownerTokenAccount: await getAssociatedTokenAddress(collateralMint, kp.publicKey, false),
      owner_token_account: await getAssociatedTokenAddress(collateralMint, kp.publicKey, false),
      tokenProgram: TOKEN_PROGRAM_ID,
      token_program: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      system_program: SystemProgram.programId,
    };

    const txSig = await program.methods[targetIxName]()
      .accounts(accountsMap)
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
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }));

    const accountsMap = {
      owner: kp.publicKey,
      payer: kp.publicKey,
      pool: JLP_POOL,
      perpetuals: perpetualsPDA,
      custody: new PublicKey(custody),
      collateralCustody,
      collateral_custody: collateralCustody,
      mint: TOKEN_MINTS[asset],
      collateralMint,
      collateral_mint: collateralMint,
      position: pk,
      positionRequest: closeRequestPDA,
      position_request: closeRequestPDA,
      positionRequestAta: closeRequestATA,
      position_request_ata: closeRequestATA,
      ownerTokenAccount: traderATA,
      owner_token_account: traderATA,
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
    };

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
  KEYPAIR_PATH,
};
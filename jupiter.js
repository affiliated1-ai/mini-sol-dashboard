/**
 * ═══════════════════════════════════════════════════════════════════
 *  Jupiter Perpetuals — Anchor-Based On-Chain Integration
 *
 *  Built against the official Jupiter Perps on-chain program:
 *    Program ID: PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
 *
 *  Reference:
 *    https://developers.jup.ag/docs/perps
 *    https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing
 *    https://developers.jup.ag/docs/perps/position-request-account
 *    https://developers.jup.ag/docs/perps/custody-account
 *
 *  Architecture:
 *    - Uses @coral-xyz/anchor to load the Jupiter Perps IDL
 *    - Derives all PDAs (Position, PositionRequest, Custody) deterministically
 *    - Builds openPositionRequest / closePositionRequest instructions directly
 *    - Monitors on-chain PositionRequest accounts for fill/execution (no REST polling)
 *    - TP/SL stored on-chain as Trigger PositionRequest accounts
 *
 *  Setup:
 *    1. npm install @coral-xyz/anchor @solana/spl-token @pythnetwork/client
 *    2. Download IDL: https://solscan.io/account/PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu#programIdl
 *       Save as: ./idl/jupiter-perpetuals.json
 *    3. Set KEYPAIR_PATH and SOLANA_RPC in .env
 *    4. Set DEVNET=true for devnet testing
 *
 *  ⚠️  DEVNET NOTE:
 *    Jupiter Perps devnet has limited markets (SOL only) and the
 *    program ID may differ. Check https://jup.ag/devnet for current
 *    devnet deployment details before running.
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

require('dotenv').config();

const anchor        = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram,
        SYSVAR_RENT_PUBKEY, Transaction }  = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        getAssociatedTokenAddress }        = require('@solana/spl-token');
const fs   = require('fs');
const path = require('path');
const { log } = require('./utils');

// ── Network config ────────────────────────────────────────────────
const IS_DEVNET = process.env.DEVNET === 'true';
const NETWORK   = IS_DEVNET ? 'DEVNET' : 'MAINNET';

const RPC_URL = process.env.SOLANA_RPC ||
  (IS_DEVNET ? 'https://api.devnet.solana.com'
             : 'https://api.mainnet-beta.solana.com');

const KEYPAIR_PATH = process.env.KEYPAIR_PATH ||
  path.join(__dirname, IS_DEVNET ? 'wallet-devnet.json' : 'wallet.json');

// ── Program IDs ───────────────────────────────────────────────────
// Mainnet: verified from https://solscan.io/account/PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
// Devnet:  check https://jup.ag/devnet — may differ or be unavailable
const PERP_PROGRAM_ID = new PublicKey(
  IS_DEVNET
    ? process.env.DEVNET_PERP_PROGRAM_ID || 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
    : 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
);

// ── JLP Pool (mainnet) ────────────────────────────────────────────
// Source: https://developers.jup.ag/docs/perps/pool-account
const JLP_POOL = new PublicKey('5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq');

// ── Custody accounts (mainnet) ────────────────────────────────────
// Source: https://developers.jup.ag/docs/perps/custody-account
const CUSTODY_ACCOUNTS = {
  SOL:  new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz'),
  ETH:  new PublicKey('AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn'),
  BTC:  new PublicKey('5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm'),
  USDC: new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa'),
  USDT: new PublicKey('4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk'),
};

// ── Token mint addresses (mainnet) ────────────────────────────────
const TOKEN_MINTS = {
  SOL:  new PublicKey('So11111111111111111111111111111111111111112'),
  ETH:  new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'),
  BTC:  new PublicKey('9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
};

// ── Collateral mint for position side ────────────────────────────
// Long  → collateral in the position token (e.g. SOL for SOL long)
// Short → collateral in USDC
function getCollateralMint(asset, side) {
  return side === 'Long' ? TOKEN_MINTS[asset] : TOKEN_MINTS.USDC;
}

function getCollateralCustody(asset, side) {
  return side === 'Long' ? CUSTODY_ACCOUNTS[asset] : CUSTODY_ACCOUNTS.USDC;
}

// ── Wallet ────────────────────────────────────────────────────────
let _kp = null;
function getKeypair() {
  if (_kp) return _kp;
  if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error(
      `Wallet not found: ${KEYPAIR_PATH}\n` +
      (IS_DEVNET
        ? 'Run: solana-keygen new --outfile wallet-devnet.json\n' +
          '     solana airdrop 2 $(solana-keygen pubkey wallet-devnet.json) --url devnet'
        : 'Set KEYPAIR_PATH in .env to your mainnet keypair file.')
    );
  }
  const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
  _kp = Keypair.fromSecretKey(Uint8Array.from(raw));
  log(`[${NETWORK}] Wallet: ${_kp.publicKey.toBase58().slice(0,10)}…`);
  return _kp;
}

// ── Anchor provider + program ─────────────────────────────────────
const connection = new Connection(RPC_URL, 'confirmed');
let _program = null;

function getProgram() {
  if (_program) return _program;

  const idlPath = path.join(__dirname, 'idl', 'jupiter-perpetuals.json');
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `Jupiter Perps IDL not found at ${idlPath}\n` +
      'Download it from:\n' +
      '  https://solscan.io/account/PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu#programIdl\n' +
      'Save as: sol-bot/idl/jupiter-perpetuals.json'
    );
  }

  const kp       = getKeypair();
  const idl      = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const wallet   = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);
  _program = new anchor.Program(idl, PERP_PROGRAM_ID, provider);
  log(`[${NETWORK}] Jupiter Perps program loaded: ${PERP_PROGRAM_ID.toBase58()}`);
  return _program;
}

// ── PDA derivation ────────────────────────────────────────────────
/**
 * Derives the Position PDA for a given owner + pool + custody + side.
 * Source: https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing
 */
function derivePositionPDA(owner, pool, custody, side) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('position'),
      owner.toBuffer(),
      pool.toBuffer(),
      custody.toBuffer(),
      Buffer.from(side === 'Long' ? [0] : [1]),
    ],
    PERP_PROGRAM_ID
  );
}

/**
 * Derives the PositionRequest PDA.
 * Each request is unique via a u64 counter seed.
 * Source: https://developers.jup.ag/docs/perps/position-request-account
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

// ── Open position (market order) ──────────────────────────────────
/**
 * Builds and sends an openPositionRequest instruction.
 *
 * Jupiter Perps uses a two-step flow:
 *   1. Trader sends openPositionRequest tx → creates PositionRequest account
 *   2. Jupiter keeper bot reads the PositionRequest and executes it on-chain
 *
 * The PositionRequest account is the "limit order" equivalent —
 * it sits on-chain until the keeper processes it (usually <1 second).
 *
 * @param {object} p
 * @param {string} p.asset          'SOL' | 'ETH' | 'BTC'
 * @param {string} p.side           'Long' | 'Short'
 * @param {number} p.marginUSDC     Collateral in USDC (e.g. 25.00)
 * @param {number} p.limitPrice     Max acceptable price (slippage bound)
 * @param {number} p.leverage       Leverage multiplier (1–500)
 * @param {number} p.stopLoss       Stop loss price (creates Trigger PositionRequest)
 * @param {number} p.takeProfit     Take profit price (creates Trigger PositionRequest)
 * @returns {string} positionRequestPubkey (used to monitor execution)
 */
async function placeLimitOrder({ asset, side, marginUSDC, limitPrice, leverage, stopLoss, takeProfit }) {
  const program  = getProgram();
  const kp       = getKeypair();
  const owner    = kp.publicKey;

  if (!CUSTODY_ACCOUNTS[asset]) {
    throw new Error(
      IS_DEVNET
        ? `${asset} not available on Jupiter devnet — only SOL is confirmed. Set DEVNET=false for mainnet.`
        : `Unknown asset: ${asset}`
    );
  }

  const custody           = CUSTODY_ACCOUNTS[asset];
  const collateralCustody = getCollateralCustody(asset, side);
  const mint              = TOKEN_MINTS[asset];
  const collateralMint    = getCollateralMint(asset, side);

  // Derive position PDA
  const [positionPDA] = derivePositionPDA(owner, JLP_POOL, custody, side);

  // Generate a unique counter for this request
  const counter = Date.now() % 2**32;  // u64, keep within safe range
  const [positionRequestPDA] = derivePositionRequestPDA(positionPDA, counter);

  // PositionRequest ATA (receives/holds collateral tokens during execution)
  const positionRequestATA = await getAssociatedTokenAddress(
    collateralMint,
    positionRequestPDA,
    true,  // allowOwnerOffCurve = true for PDAs
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Trader's token account (source of collateral)
  const traderCollateralATA = await getAssociatedTokenAddress(
    collateralMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Convert amounts to on-chain atomic values
  // USDC has 6 decimals: 25.00 USDC = 25_000_000
  const collateralDeltaAtomic = Math.round(marginUSDC * 1e6);
  // Size = collateral × leverage, in USD atomic (6 decimals)
  const sizeUsdDeltaAtomic    = Math.round(marginUSDC * leverage * 1e6);
  // Price slippage: the max price we'll accept (in USD atomic, 6 decimals)
  // Long:  reject if price > limitPrice
  // Short: reject if price < limitPrice
  const priceSlippageAtomic   = Math.round(limitPrice * 1e6);

  log(`[${NETWORK}] openPositionRequest: ${side} ${asset} | Margin $${marginUSDC} | Lev ${leverage}× | Limit $${limitPrice}`);
  log(`[${NETWORK}] Position PDA: ${positionPDA.toBase58()}`);
  log(`[${NETWORK}] Request PDA:  ${positionRequestPDA.toBase58()}`);

  try {
    const txSig = await program.methods
      .openPositionRequest({
        counter:           new anchor.BN(counter),
        side:              side === 'Long' ? { long: {} } : { short: {} },
        priceSlippage:     new anchor.BN(priceSlippageAtomic),
        sizeUsdDelta:      new anchor.BN(sizeUsdDeltaAtomic),
        collateralDelta:   new anchor.BN(collateralDeltaAtomic),
        requestType:       { market: {} },   // Market execution (keeper fills ASAP)
        jupiterMinimumOut: null,             // Only needed for cross-token swaps
      })
      .accounts({
        owner,
        pool:                JLP_POOL,
        custody,
        collateralCustody,
        mint,
        collateralMint,
        position:            positionPDA,
        positionRequest:     positionRequestPDA,
        positionRequestAta:  positionRequestATA,
        ownerTokenAccount:   traderCollateralATA,
        tokenProgram:        TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:       SystemProgram.programId,
        rent:                SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: 'confirmed' });

    log(`[${NETWORK}] openPositionRequest tx: ${txSig}`);

    // Place TP and SL as separate Trigger PositionRequest accounts
    if (stopLoss)   await placeTriggerRequest(positionPDA, positionRequestPDA, 'sl', stopLoss,   side, asset, custody, collateralCustody, owner);
    if (takeProfit) await placeTriggerRequest(positionPDA, positionRequestPDA, 'tp', takeProfit, side, asset, custody, collateralCustody, owner);

    return positionRequestPDA.toBase58();
  } catch (err) {
    throw new Error(`[${NETWORK}] openPositionRequest failed: ${err.message}`);
  }
}

// ── Place TP/SL Trigger requests ──────────────────────────────────
/**
 * TP and SL are stored on-chain as Trigger PositionRequest accounts.
 * The Jupiter keeper monitors them and executes when price crosses
 * the triggerPrice.
 *
 * Source: https://developers.jup.ag/docs/perps/position-request-account
 * "TP / SL requests are stored onchain via PositionRequest accounts.
 *  They will only be closed when the TP / SL request is triggered."
 */
async function placeTriggerRequest(positionPDA, _parentRequest, type, triggerPrice, side, asset, custody, collateralCustody, owner) {
  const program = getProgram();
  const counter = (Date.now() % 2**32) + (type === 'tp' ? 1 : 2);
  const [triggerRequestPDA] = derivePositionRequestPDA(positionPDA, counter);
  const collateralMint = getCollateralMint(asset, side);

  const triggerPriceAtomic = Math.round(triggerPrice * 1e6);

  // triggerAboveThreshold logic:
  // TP Long:  fire when price RISES above triggerPrice → true
  // SL Long:  fire when price FALLS below triggerPrice → false
  // TP Short: fire when price FALLS below triggerPrice → false
  // SL Short: fire when price RISES above triggerPrice → true
  const triggerAboveThreshold =
    (type === 'tp' && side === 'Long')  ||
    (type === 'sl' && side === 'Short');

  const positionRequestATA = await getAssociatedTokenAddress(
    collateralMint, triggerRequestPDA, true
  );

  try {
    const txSig = await program.methods
      .openPositionRequest({
        counter:             new anchor.BN(counter),
        side:                side === 'Long' ? { long: {} } : { short: {} },
        priceSlippage:       new anchor.BN(triggerPriceAtomic),
        sizeUsdDelta:        new anchor.BN(0),   // entire position
        collateralDelta:     new anchor.BN(0),
        requestType:         { trigger: {} },    // Trigger = TP/SL
        jupiterMinimumOut:   null,
        triggerPrice:        new anchor.BN(triggerPriceAtomic),
        triggerAboveThreshold,
        entirePosition:      true,               // close whole position
      })
      .accounts({
        owner,
        pool:                JLP_POOL,
        custody,
        collateralCustody,
        mint:                TOKEN_MINTS[asset],
        collateralMint,
        position:            positionPDA,
        positionRequest:     triggerRequestPDA,
        positionRequestAta:  positionRequestATA,
        ownerTokenAccount:   await getAssociatedTokenAddress(collateralMint, owner, false),
        tokenProgram:        TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:       SystemProgram.programId,
        rent:                SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: 'confirmed' });

    log(`[${NETWORK}] ${type.toUpperCase()} trigger placed @ $${triggerPrice} | tx: ${txSig}`);
    return triggerRequestPDA.toBase58();
  } catch (err) {
    // Non-fatal — position is open, just without TP/SL on-chain
    log(`[${NETWORK}] ${type.toUpperCase()} trigger failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ── Get order / position request status ───────────────────────────
/**
 * Fetches the PositionRequest account to check if it has been executed.
 * Jupiter keepers execute requests on-chain — no REST polling needed.
 *
 * @param {string} positionRequestPubkey
 * @returns {{ filled: boolean, fillPrice: number|null }}
 */
async function getOrderStatus(positionRequestPubkey) {
  try {
    const program = getProgram();
    const pk      = new PublicKey(positionRequestPubkey);

    // If account no longer exists, the request was executed and closed
    const accountInfo = await connection.getAccountInfo(pk);
    if (!accountInfo) {
      // Executed and closed by the keeper — position is open
      log(`[${NETWORK}] PositionRequest ${positionRequestPubkey.slice(0,10)}… executed (account closed)`);
      return { filled: true, fillPrice: null };
    }

    // Account still exists — parse it
    const program_ = getProgram();
    const decoded  = program_.coder.accounts.decode('PositionRequest', accountInfo.data);

    return {
      filled:    decoded.executed === true,
      fillPrice: null,  // fill price not stored directly; query Position account
    };
  } catch (err) {
    log(`[${NETWORK}] getOrderStatus error: ${err.message}`);
    // If account fetch fails assume not yet filled
    return { filled: false, fillPrice: null };
  }
}

// ── Get position status (for SL/TP monitoring) ───────────────────
/**
 * Fetches the on-chain Position account to check if it's been closed.
 * A Position account that no longer exists = position was closed (SL/TP/liquidation).
 *
 * @param {string} positionRequestPubkey  (we derive position PDA from this)
 * @returns {{ closed: boolean, exitPrice: number|null, closeReason: string }}
 */
async function getPositionStatus(positionRequestPubkey) {
  try {
    // We stored the position PDA as positionId in server.js
    const positionPDA = new PublicKey(positionRequestPubkey);
    const accountInfo = await connection.getAccountInfo(positionPDA);

    if (!accountInfo) {
      // Position account closed = SL/TP/liquidation triggered
      log(`[${NETWORK}] Position ${positionRequestPubkey.slice(0,10)}… closed (account gone)`);
      return { closed: true, exitPrice: null, closeReason: 'SL/TP/Liquidation' };
    }

    // Still open
    return { closed: false, exitPrice: null, closeReason: null };
  } catch (err) {
    log(`[${NETWORK}] getPositionStatus error: ${err.message}`);
    return { closed: false, exitPrice: null, closeReason: null };
  }
}

// ── Cancel unfilled position request ─────────────────────────────
/**
 * Sends a cancelPositionRequest instruction to cancel a pending request.
 * Only works if the keeper hasn't executed it yet.
 *
 * @param {string} positionRequestPubkey
 */
async function cancelOrder(positionRequestPubkey) {
  const program = getProgram();
  const kp      = getKeypair();
  const pk      = new PublicKey(positionRequestPubkey);

  // Check it still exists
  const info = await connection.getAccountInfo(pk);
  if (!info) {
    log(`[${NETWORK}] cancelOrder: request already executed — nothing to cancel`);
    return;
  }

  try {
    const decoded  = program.coder.accounts.decode('PositionRequest', info.data);
    const custody  = decoded.custody;
    const side     = decoded.side.long !== undefined ? 'Long' : 'Short';
    const asset    = Object.entries(CUSTODY_ACCOUNTS)
                           .find(([,v]) => v.toBase58() === custody.toBase58())?.[0] || 'SOL';

    const [positionPDA] = derivePositionPDA(kp.publicKey, JLP_POOL, new PublicKey(custody), side);
    const collateralMint = getCollateralMint(asset, side);
    const positionRequestATA = await getAssociatedTokenAddress(collateralMint, pk, true);

    const txSig = await program.methods
      .cancelPositionRequest()
      .accounts({
        owner:              kp.publicKey,
        position:           positionPDA,
        positionRequest:    pk,
        positionRequestAta: positionRequestATA,
        ownerTokenAccount:  await getAssociatedTokenAddress(collateralMint, kp.publicKey, false),
        tokenProgram:       TOKEN_PROGRAM_ID,
        systemProgram:      SystemProgram.programId,
      })
      .rpc({ commitment: 'confirmed' });

    log(`[${NETWORK}] cancelPositionRequest tx: ${txSig}`);
  } catch (err) {
    throw new Error(`[${NETWORK}] cancelOrder failed: ${err.message}`);
  }
}

// ── Close open position (market) ──────────────────────────────────
/**
 * Closes an open position by sending a closePositionRequest instruction.
 * The keeper executes the close at current oracle price.
 *
 * @param {string} positionPubkey  the Position PDA (stored as position.id in server.js)
 */
async function closePosition(positionPubkey) {
  const program = getProgram();
  const kp      = getKeypair();
  const pk      = new PublicKey(positionPubkey);

  const info = await connection.getAccountInfo(pk);
  if (!info) {
    log(`[${NETWORK}] closePosition: position ${positionPubkey.slice(0,10)}… already closed`);
    return;
  }

  const decoded   = program.coder.accounts.decode('Position', info.data);
  const custody   = decoded.custody;
  const side      = decoded.side.long !== undefined ? 'Long' : 'Short';
  const asset     = Object.entries(CUSTODY_ACCOUNTS)
                          .find(([,v]) => v.toBase58() === custody.toBase58())?.[0] || 'SOL';

  const collateralCustody = getCollateralCustody(asset, side);
  const collateralMint    = getCollateralMint(asset, side);
  const counter           = Date.now() % 2**32;
  const [closeRequestPDA] = derivePositionRequestPDA(pk, counter);

  const closeRequestATA = await getAssociatedTokenAddress(collateralMint, closeRequestPDA, true);
  const traderATA       = await getAssociatedTokenAddress(collateralMint, kp.publicKey, false);

  try {
    const txSig = await program.methods
      .closePositionRequest({
        counter:           new anchor.BN(counter),
        priceSlippage:     new anchor.BN(0),    // 0 = accept any price (market close)
        sizeUsdDelta:      new anchor.BN(0),
        collateralDelta:   new anchor.BN(0),
        requestType:       { market: {} },
        jupiterMinimumOut: null,
        entirePosition:    true,                // close entire position
      })
      .accounts({
        owner:              kp.publicKey,
        pool:               JLP_POOL,
        custody:            new PublicKey(custody),
        collateralCustody,
        mint:               TOKEN_MINTS[asset],
        collateralMint,
        position:           pk,
        positionRequest:    closeRequestPDA,
        positionRequestAta: closeRequestATA,
        ownerTokenAccount:  traderATA,
        tokenProgram:       TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:      SystemProgram.programId,
        rent:               SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: 'confirmed' });

    log(`[${NETWORK}] closePositionRequest tx: ${txSig}`);
  } catch (err) {
    throw new Error(`[${NETWORK}] closePosition failed: ${err.message}`);
  }
}

// ── Startup log ───────────────────────────────────────────────────
log(`[${NETWORK}] Jupiter Anchor wrapper initialised`);
log(`[${NETWORK}] Program: ${PERP_PROGRAM_ID.toBase58()}`);
log(`[${NETWORK}] RPC:     ${RPC_URL}`);
log(`[${NETWORK}] Wallet:  ${KEYPAIR_PATH}`);
if (IS_DEVNET) {
  log(`[DEVNET]  ⚠️  Devnet perp markets are limited. SOL only.`);
  log(`[DEVNET]  ⚠️  Set DEVNET_PERP_PROGRAM_ID if devnet program differs.`);
}

module.exports = {
  placeLimitOrder,
  getOrderStatus,
  getPositionStatus,
  cancelOrder,
  closePosition,
};

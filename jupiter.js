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
const { log } = require('./utils');

// -- Network config ------------------------------------------------
const IS_DEVNET = process.env.DEVNET === 'true';
const NETWORK   = IS_DEVNET ? 'DEVNET' : 'MAINNET';

const RPC_URL = process.env.SOLANA_RPC ||
  (IS_DEVNET ? 'https://api.devnet.solana.com'
             : 'https://api.mainnet-beta.solana.com');

const KEYPAIR_PATH = process.env.KEYPAIR_PATH ||
  path.join(__dirname, IS_DEVNET ? 'wallet-devnet.json' : 'wallet.json');

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
  log(`[${NETWORK}] Wallet: ${_kp.publicKey.toBase58().slice(0, 10)}...`);
  return _kp;
}

// -- Anchor provider + program -------------------------------------
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
      'Save as: ./idl/jupiter-perpetuals.json'
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
async function placeLimitOrder({ asset, side, marginUSDC, limitPrice, leverage, stopLoss, takeProfit }) {
  const program = getProgram();
  const kp      = getKeypair();
  const owner   = kp.publicKey;

  if (!CUSTODY_ACCOUNTS[asset]) {
    throw new Error(`Unsupported asset: ${asset}`);
  }

  const custody           = CUSTODY_ACCOUNTS[asset];
  const collateralCustody = getCollateralCustody(asset, side);
  const mint              = TOKEN_MINTS[asset];
  const collateralMint    = getCollateralMint(asset, side);

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

  log(`[${NETWORK}] placeLimitOrder (Anchor): ${side} ${asset} @ $${limitPrice} | Margin $${marginUSDC} | ${leverage}x`);
  log(`[${NETWORK}] Position PDA: ${positionPDA.toBase58()}`);
  log(`[${NETWORK}] Request PDA:  ${positionRequestPDA.toBase58()}`);

  try {
    const openIx = await program.methods
      .openPositionRequest({
        counter:           new anchor.BN(counter),
        side:              side === 'Long' ? { long: {} } : { short: {} },
        priceSlippage:     new anchor.BN(priceSlippageAtomic),
        sizeUsdDelta:      new anchor.BN(sizeUsdDeltaAtomic),
        collateralDelta:   new anchor.BN(collateralDeltaAtomic),
        requestType:       { market: {} },
        jupiterMinimumOut: null,
      })
      .accounts({
        owner,
        pool:                   JLP_POOL,
        custody,
        collateralCustody,
        mint,
        collateralMint,
        position:               positionPDA,
        positionRequest:        positionRequestPDA,
        positionRequestAta:     positionRequestATA,
        ownerTokenAccount:      traderCollateralATA,
        tokenProgram:           TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:          SystemProgram.programId,
        rent:                   SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const tx = new Transaction();

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

    const txSig = await anchor.getProvider().sendAndConfirm(tx, [kp], {
      commitment: 'confirmed',
      skipPreflight: false,
    });

    log(`[${NETWORK}] openPositionRequest confirmed: ${txSig}`);

    // Place TP and SL trigger requests on-chain if specified
    if (stopLoss)   await placeTriggerRequest(positionPDA, 'sl', stopLoss,   side, asset, custody, collateralCustody, owner);
    if (takeProfit) await placeTriggerRequest(positionPDA, 'tp', takeProfit, side, asset, custody, collateralCustody, owner);

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

  try {
    const txSig = await program.methods
      .openPositionRequest({
        counter:             new anchor.BN(counter),
        side:                side === 'Long' ? { long: {} } : { short: {} },
        priceSlippage:       new anchor.BN(triggerPriceAtomic),
        sizeUsdDelta:        new anchor.BN(0),
        collateralDelta:     new anchor.BN(0),
        requestType:         { trigger: {} },
        jupiterMinimumOut:   null,
        triggerPrice:        new anchor.BN(triggerPriceAtomic),
        triggerAboveThreshold,
        entirePosition:      true,
      })
      .accounts({
        owner,
        pool:                   JLP_POOL,
        custody,
        collateralCustody,
        mint:                   TOKEN_MINTS[asset],
        collateralMint,
        position:               positionPDA,
        positionRequest:        triggerRequestPDA,
        positionRequestAta:     positionRequestATA,
        ownerTokenAccount:      await getAssociatedTokenAddress(collateralMint, owner, false),
        tokenProgram:           TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:          SystemProgram.programId,
        rent:                   SYSVAR_RENT_PUBKEY,
      })
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

    log(`[${NETWORK}] cancelPositionRequest confirmed: ${txSig}`);
  } catch (err) {
    throw new Error(`[${NETWORK}] cancelOrder failed: ${err.message}`);
  }
}

// -- Close open position (market) ----------------------------------
async function closePosition(positionPubkey) {
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
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }));

    const closeIx = await program.methods
      .closePositionRequest({
        counter:           new anchor.BN(counter),
        priceSlippage:     new anchor.BN(0),
        sizeUsdDelta:      new anchor.BN(0),
        collateralDelta:   new anchor.BN(0),
        requestType:       { market: {} },
        jupiterMinimumOut: null,
        entirePosition:    true,
      })
      .accounts({
        owner:                  kp.publicKey,
        pool:                   JLP_POOL,
        custody:                new PublicKey(custody),
        collateralCustody,
        mint:                   TOKEN_MINTS[asset],
        collateralMint,
        position:               pk,
        positionRequest:        closeRequestPDA,
        positionRequestAta:     closeRequestATA,
        ownerTokenAccount:      traderATA,
        tokenProgram:           TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:          SystemProgram.programId,
        rent:                   SYSVAR_RENT_PUBKEY,
      })
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

// -- Startup log ---------------------------------------------------
log(`[${NETWORK}] Jupiter Anchor wrapper initialised`);
log(`[${NETWORK}] Program: ${PERP_PROGRAM_ID.toBase58()}`);
log(`[${NETWORK}] RPC:     ${RPC_URL}`);
log(`[${NETWORK}] Wallet:  ${KEYPAIR_PATH}`);

module.exports = {
  placeLimitOrder,
  getOrderStatus,
  getPositionStatus,
  cancelOrder,
  closePosition,
};
/**
 * ===================================================================
 *  Jupiter Perpetuals - Anchor On-Chain Production Integration
 *  Supporting:
 *    - Approach A: Real-Time Paper Trading & Portfolio Engine
 *    - Approach B: Zero-Risk On-Chain RPC Simulation (simulateTransaction)
 *    - Dual Mode:  Verify on-chain contract + track in paper portfolio
 *    - Live Mode:  Direct broadcast to Solana Mainnet
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
      _kp = Keypair.generate();
      log(`[${NETWORK}] Ephemeral wallet generated for Paper Trading: ${_kp.publicKey.toBase58().slice(0, 10)}...`);
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
  const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
  _kp = Keypair.fromSecretKey(Uint8Array.from(raw));
  log(`[${NETWORK}] Wallet: ${_kp.publicKey.toBase58().slice(0, 10)}...`);
  return _kp;
}

// -- Anchor provider + program -------------------------------------
const connection = new Connection(RPC_URL, 'confirmed');
let _program = null;

function normalizeIdlTypes(value) {
  if (Array.isArray(value)) return value.map(normalizeIdlTypes);
  if (!value || typeof value !== 'object') return value;

  const normalized = {};
  const primitiveTypes = /^(bool|u8|i8|u16|i16|u32|i32|u64|i64|u128|i128|f32|f64|bytes|string|pubkey|publicKey)$/;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'type' || key === 'option' || key === 'vec') && child === 'publicKey') {
      normalized[key] = 'pubkey';
    } else if ((key === 'type' || key === 'option' || key === 'vec') && typeof child === 'string' && !primitiveTypes.test(child)) {
      normalized[key] = { defined: { name: child } };
    } else if ((key === 'type' || key === 'option' || key === 'vec') && child && typeof child === 'object' && child.defined && typeof child.defined === 'string') {
      normalized[key] = { ...child, defined: { name: child.defined } };
    } else {
      normalized[key] = normalizeIdlTypes(child);
    }
  }
  return normalized;
}

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

  const kp  = getKeypair();
  const idl = normalizeIdlTypes(JSON.parse(fs.readFileSync(idlPath, 'utf8')));
  if (idl.accounts && idl.types) {
    idl.accounts = idl.accounts.filter(account =>
      idl.types.some(type => type.name === account.name)
    );
  }
  if (idl.events && idl.types) {
    idl.events = idl.events.filter(event =>
      idl.types.some(type => type.name === event.name)
    );
  }
  if (!idl.address) {
    idl.address = PERP_PROGRAM_ID.toBase58();
  }
  const wallet   = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  _program = new anchor.Program(idl, provider);
  log(`[${NETWORK}] Jupiter Perps program loaded: ${PERP_PROGRAM_ID.toBase58()}`);
  return _program;
}

// -- PDA derivation ------------------------------------------------
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

// -- Place Order (Supports Approach A, Approach B, or Live Broadcast)
async function placeLimitOrder({ 
  asset, 
  side, 
  marginUSDC, 
  limitPrice, 
  leverage, 
  stopLoss, 
  takeProfit,
  simulate,
  paper 
}) {
  const isPaper    = paper !== undefined ? paper : IS_PAPER_TRADING;
  const isSimulate = simulate !== undefined ? simulate : IS_SIMULATE_TX;

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

  const [positionPDA] = derivePositionPDA(owner, JLP_POOL, custody, collateralCustody);

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

  const isSolCollateral = collateralMint.equals(NATIVE_MINT);
  const collateralDeltaAtomic = isSolCollateral
    ? Math.round((marginUSDC / limitPrice) * 1e9)
    : Math.round(marginUSDC * 1e6);

  const sizeUsdDeltaAtomic  = Math.round(marginUSDC * leverage * 1e6);
  const priceSlippageAtomic = Math.round(limitPrice * 1e6);

  log(`[${NETWORK}] placeLimitOrder: ${side} ${asset} @ $${limitPrice} | Margin $${marginUSDC} | ${leverage}x`);
  if (isPaper)    log(`[${NETWORK}] Execution Mode: Approach A (Paper Trading) active`);
  if (isSimulate) log(`[${NETWORK}] Execution Mode: Approach B (On-Chain RPC Simulation) active`);

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
    let targetIxName = 'createIncreasePositionMarketRequest';
    if (!availableIxNames.includes(targetIxName)) {
      targetIxName = availableIxNames.find(n => 
        n === 'openPositionRequest' ||
        n === 'create_increase_position_market_request' ||
        n.toLowerCase().includes('increaseposition') ||
        n.toLowerCase().includes('openposition')
      ) || availableIxNames[0];
    }

    const idlIx = program.idl.instructions.find(i => i.name === targetIxName);

    // Mapped accounts satisfying Anchor IDL validation
    const accountsMap = {
      owner,
      payer: owner,
      fundingAccount: traderCollateralATA,
      ownerTokenAccount: traderCollateralATA,
      perpetuals: perpetualsPDA,
      pool: JLP_POOL,
      position: positionPDA,
      positionRequest: positionRequestPDA,
      positionRequestAta: positionRequestATA,
      custody,
      collateralCustody,
      mint,
      collateralMint,
      inputMint: collateralMint,
      // Referral sentinel: on-chain Anchor deserializes PERP_PROGRAM_ID as None
      referral: PERP_PROGRAM_ID,
      referralAccount: PERP_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority,
      program: PERP_PROGRAM_ID,
    };

    // Auto-fill any optional accounts
    if (idlIx && idlIx.accounts) {
      for (const acc of idlIx.accounts) {
        if (!accountsMap[acc.name]) {
          if (acc.name.toLowerCase().includes('referral') || acc.isOptional || acc.optional) {
            accountsMap[acc.name] = PERP_PROGRAM_ID;
          }
        }
      }
    }

    const paramsObj = {
      counter:              new anchor.BN(counter),
      side:                 side === 'Long' ? { long: {} } : { short: {} },
      priceSlippage:        new anchor.BN(priceSlippageAtomic),
      sizeUsdDelta:         new anchor.BN(sizeUsdDeltaAtomic),
      collateralDelta:      new anchor.BN(collateralDeltaAtomic),
      collateralTokenDelta: new anchor.BN(collateralDeltaAtomic),
      requestType:          { market: {} },
      jupiterMinimumOut:    null,
      entirePosition:       null,
      triggerPrice:         null,
      triggerAboveThreshold: null,
      requestTime:          null,
    };

    let methodBuilder;
    if (idlIx && idlIx.args && idlIx.args.length > 1) {
      const argsList = [];
      for (const argDef of idlIx.args) {
        if (argDef.name === 'counter') argsList.push(new anchor.BN(counter));
        else if (argDef.name === 'side') argsList.push(side === 'Long' ? { long: {} } : { short: {} });
        else if (argDef.name === 'priceSlippage') argsList.push(new anchor.BN(priceSlippageAtomic));
        else if (argDef.name === 'sizeUsdDelta') argsList.push(new anchor.BN(sizeUsdDeltaAtomic));
        else if (argDef.name === 'collateralDelta' || argDef.name === 'collateralTokenDelta') argsList.push(new anchor.BN(collateralDeltaAtomic));
        else if (argDef.name === 'requestType') argsList.push({ market: {} });
        else argsList.push(paramsObj[argDef.name] ?? new anchor.BN(0));
      }
      methodBuilder = program.methods[targetIxName](...argsList);
    } else {
      methodBuilder = program.methods[targetIxName](paramsObj);
    }

    const openIx = await methodBuilder.accounts(accountsMap).instruction();

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }));

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
    // APPROACH B: ON-CHAIN RPC TRANSACTION SIMULATION
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
          log(`[${NETWORK}] ❌ [APPROACH B SIMULATION REJECTED]:`, JSON.stringify(sim.value.err));
          if (sim.value.logs) {
            log(`[SIMULATION LOGS]:\n` + sim.value.logs.slice(-10).join('\n'));
          }
          if (!isPaper) {
            throw new Error(`Simulation failed on-chain: ${JSON.stringify(sim.value.err)}`);
          }
        } else {
          log(`[${NETWORK}] ✅ [APPROACH B SIMULATION PASSED!]`);
          log(`[${NETWORK}] Compute units consumed: ${sim.value.unitsConsumed}`);
          if (sim.value.logs && sim.value.logs.length > 0) {
            log(`[${NETWORK}] Log trace snippet: ${sim.value.logs.slice(-2).join(' | ')}`);
          }
        }
      } catch (simErr) {
        log(`[${NETWORK}] [APPROACH B ERROR]: ${simErr.message}`);
        if (!isPaper) throw simErr;
      }
    }

    // ==============================================================
    // APPROACH A: PAPER TRADING RECORDING
    // ==============================================================
    if (isPaper) {
      const paperId = `paper_${asset}_${side}_${Date.now()}`;
      _paperStore[paperId] = {
        id: paperId,
        asset,
        side,
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
      log(`[${NETWORK}] ✅ [APPROACH A PAPER TRADE CREATED]`);
      log(`[${NETWORK}] Virtual Position: ${side} ${asset} | Size: $${marginUSDC * leverage} | ID: ${paperId}`);
      return paperId;
    }

    // Simulation-only mode without paper tracking
    if (isSimulate && !isPaper) {
      log(`[${NETWORK}] [APPROACH B] Simulation completed. Skipping live broadcast.`);
      return positionRequestPDA.toBase58();
    }

    // ==============================================================
    // LIVE ON-CHAIN BROADCAST
    // ==============================================================
    const txSig = await anchor.getProvider().sendAndConfirm(tx, [kp], {
      commitment: 'confirmed',
      skipPreflight: false,
    });

    log(`[${NETWORK}] openPositionRequest confirmed: ${txSig}`);

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
  if (typeof positionRequestPubkey === 'string' && positionRequestPubkey.startsWith('paper_')) {
    const paperOrder = _paperStore[positionRequestPubkey];
    if (paperOrder) {
      return { filled: true, fillPrice: paperOrder.limitPrice };
    }
  }

  try {
    const pk = new PublicKey(positionRequestPubkey);
    const accountInfo = await connection.getAccountInfo(pk);

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
  if (typeof positionPubkey === 'string' && positionPubkey.startsWith('paper_')) {
    const paperPos = _paperStore[positionPubkey];
    if (paperPos) {
      paperPos.status = 'closed';
      paperPos.closedAt = Date.now();
      savePaperStore();
      log(`[${NETWORK}] ✅ [APPROACH A] Paper position closed: ${positionPubkey}`);
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
  getPublicKey: () => getKeypair().publicKey,
  getPublicKeyBase58: () => getKeypair().publicKey.toBase58(),
  getPaperPositions,
  clearPaperPositions,
  KEYPAIR_PATH,
};
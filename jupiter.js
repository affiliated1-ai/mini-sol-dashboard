'use strict';

require('dotenv').config();

const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
const { log } = require('./utils');

const IS_DEVNET = process.env.DEVNET === 'true' || process.env.SOLANA_NETWORK === 'devnet';
const RPC_URL = process.env.SOLANA_RPC_URL || (IS_DEVNET ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
const PROGRAM_ID = new PublicKey(process.env.DEVNET_PERP_PROGRAM_ID || 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu');
const POOL = new PublicKey(process.env.JUPITER_POOL || '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq');
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || path.join(__dirname, IS_DEVNET ? 'wallet-devnet.json' : 'wallet.json');
const MINTS = { USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') };
const CUSTODIES = { SOL: new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz') };
const KEEPER = process.env.JUPITER_KEEPER;
const API_KEEPER = process.env.JUPITER_API_KEEPER;
const DOVES_PRICE_ACCOUNT = process.env.JUPITER_DOVES_PRICE_ACCOUNT;
const PYTHNET_PRICE_ACCOUNT = process.env.JUPITER_PYTHNET_PRICE_ACCOUNT;
const connection = new Connection(RPC_URL, 'confirmed');
let keypair;
let program;
const positionsByRequest = new Map();

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`);
  return number;
}

function atomic(value, name) {
  const number = finiteNumber(value, name);
  if (number < 0) throw new Error(`${name} must not be negative`);
  const result = Math.round(number * 1e6);
  if (!Number.isSafeInteger(result)) throw new Error(`${name} is outside the supported range`);
  return new anchor.BN(result);
}

function getKeypair() {
  if (keypair) return keypair;
  if (!fs.existsSync(KEYPAIR_PATH)) throw new Error(`Wallet not found: ${KEYPAIR_PATH}`);
  keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))));
  return keypair;
}

function normalizeIdl(value) {
  if (value === 'publicKey') return 'pubkey';
  if (Array.isArray(value)) return value.map(normalizeIdl);
  if (!value || typeof value !== 'object') return value;
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'defined' && typeof child === 'string') normalized[key] = { name: child };
    else normalized[key] = normalizeIdl(child);
  }
  return normalized;
}

function getProgram() {
  if (program) return program;
  const idlPath = path.join(__dirname, 'idl', 'jupiter-perpetuals.json');
  if (!fs.existsSync(idlPath)) throw new Error(`Jupiter Perps IDL not found: ${idlPath}`);
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(getKeypair()), { commitment: 'confirmed' });
  const rawIdl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const declaredTypes = rawIdl.types || [];
  const accountTypes = rawIdl.accounts || [];
  const eventTypes = (rawIdl.events || []).map(event => ({
    name: event.name,
    type: { kind: 'struct', fields: event.fields || [] },
  }));
  const extraTypes = [...accountTypes, ...eventTypes].filter(declaration =>
    !declaredTypes.some(type => type.name === declaration.name));
  const idl = normalizeIdl({
    ...rawIdl,
    accounts: [],
    types: [...declaredTypes, ...extraTypes],
  });
  program = new anchor.Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider);
  log(`[${IS_DEVNET ? 'DEVNET' : 'MAINNET'}] Jupiter Anchor program loaded`);
  return program;
}

function derivePosition(owner, custody, side) {
  return PublicKey.findProgramAddressSync([
    Buffer.from('position'), owner.toBuffer(), POOL.toBuffer(), custody.toBuffer(), Buffer.from(side === 'Long' ? [0] : [1]),
  ], PROGRAM_ID)[0];
}

async function placeLimitOrder({ asset, side, marginUSDC, limitPrice, leverage }) {
  if (asset !== 'SOL' || !CUSTODIES[asset]) throw new Error(`${asset} is not configured for this Jupiter Perps wrapper`);
  if (!['Long', 'Short'].includes(side)) throw new Error(`Invalid order side: ${side}`);
  const margin = finiteNumber(marginUSDC, 'marginUSDC');
  const lev = finiteNumber(leverage, 'leverage');
  const price = finiteNumber(limitPrice, 'limitPrice');
  if (margin <= 0 || lev <= 0 || price <= 0) throw new Error('marginUSDC, leverage, and limitPrice must be positive');
  const missingAccounts = [
    ['JUPITER_KEEPER', KEEPER],
    ['JUPITER_API_KEEPER', API_KEEPER],
    ['JUPITER_DOVES_PRICE_ACCOUNT', DOVES_PRICE_ACCOUNT],
    ['JUPITER_PYTHNET_PRICE_ACCOUNT', PYTHNET_PRICE_ACCOUNT],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missingAccounts.length) throw new Error(`Missing Jupiter account configuration: ${missingAccounts.join(', ')}`);

  const owner = getKeypair().publicKey;
  const custody = CUSTODIES[asset];
  const position = derivePosition(owner, custody, side);
  const counterValue = Date.now();
  const counterBuffer = new anchor.BN(counterValue).toArrayLike(Buffer, 'le', 8);
  const request = PublicKey.findProgramAddressSync([Buffer.from('position_request'), position.toBuffer(), counterBuffer], PROGRAM_ID)[0];
  const collateralMint = MINTS.USDC;
  const fundingAccount = await getAssociatedTokenAddress(collateralMint, owner);
  const requestAta = await getAssociatedTokenAddress(collateralMint, request, true);
  const perpetuals = PublicKey.findProgramAddressSync([Buffer.from('perpetuals')], PROGRAM_ID)[0];
  const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM_ID)[0];

  const tx = await getProgram().methods.instantCreateLimitOrder({
    params: {
      sizeUsdDelta: atomic(margin * lev, 'sizeUsdDelta'),
      collateralTokenDelta: atomic(margin, 'collateralTokenDelta'),
      side: side === 'Long' ? { long: {} } : { short: {} },
      triggerPrice: atomic(price, 'limitPrice'),
      triggerAboveThreshold: side === 'Long',
      counter: new anchor.BN(counterValue),
      requestTime: new anchor.BN(Math.floor(Date.now() / 1000)),
    },
  }).accounts({
    keeper: new PublicKey(KEEPER), apiKeeper: new PublicKey(API_KEEPER), owner, fundingAccount, perpetuals, pool: POOL,
    position, positionRequest: request, positionRequestAta: requestAta,
    custody, collateralCustody: custody, inputMint: collateralMint, tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, eventAuthority, program: PROGRAM_ID,
    custodyDovesPriceAccount: new PublicKey(DOVES_PRICE_ACCOUNT),
    custodyPythnetPriceAccount: new PublicKey(PYTHNET_PRICE_ACCOUNT),
  }).rpc({ commitment: 'confirmed' });

  positionsByRequest.set(request.toBase58(), position);
  log(`Jupiter limit order submitted: ${request.toBase58()} (${tx})`);
  return request.toBase58();
}

async function getOrderStatus(requestPDA) {
  const account = await connection.getAccountInfo(new PublicKey(requestPDA));
  return { filled: !account, fillPrice: null };
}

async function cancelOrder() {
  throw new Error('Order cancellation is not implemented for the current Jupiter Perps IDL');
}

async function getPositionStatus(positionId) {
  const position = positionsByRequest.get(positionId) || new PublicKey(positionId);
  const account = await connection.getAccountInfo(position);
  return { closed: !account, exitPrice: null, closeReason: account ? null : 'on-chain account closed' };
}

async function closePosition() {
  throw new Error('Position close is not implemented for the current Jupiter Perps IDL');
}

module.exports = { placeLimitOrder, getOrderStatus, cancelOrder, getPositionStatus, closePosition };

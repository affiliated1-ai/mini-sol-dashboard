import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// 1. Your Base58 private key string
const base58String = "YOUR_BASE58_STRING_HERE";

// 2. Decode it into a 64-byte Uint8Array
const secretKeyUint8 = bs58.decode(base58String);

// 3. Create the Keypair
const keypair = Keypair.fromSecretKey(secretKeyUint8);

console.log("Public Key:", keypair.publicKey.toBase58());


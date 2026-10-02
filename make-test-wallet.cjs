// make-test-wallet.cjs
// Creates a THROWAWAY devnet keypair, encrypts it with AES-256-GCM, and writes
// wallet-devnet.enc.json next to this script. Prints the AES key and public key.
// Refuses to overwrite an existing file. Never use for a funded wallet.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Keypair } = require('@solana/web3.js');

const out = path.resolve(__dirname, 'wallet-devnet.enc.json');
if (fs.existsSync(out)) {
  console.error('Refusing to overwrite existing ' + out);
  process.exit(1);
}

const kp = Keypair.generate();
const keyHex = crypto.randomBytes(32).toString('hex');
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
const ct = Buffer.concat([cipher.update(JSON.stringify(Array.from(kp.secretKey)), 'utf8'), cipher.final()]);

fs.writeFileSync(out, JSON.stringify({
  iv: iv.toString('hex'),
  tag: cipher.getAuthTag().toString('hex'),
  ciphertext: ct.toString('hex'),
}, null, 2));

console.log('Wrote:            ' + out);
console.log('Expected pubkey:  ' + kp.publicKey.toBase58());
console.log('WALLET_AES_KEY:   ' + keyHex);

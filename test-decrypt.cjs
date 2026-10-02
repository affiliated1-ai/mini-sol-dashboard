// test-decrypt.cjs
// Loads bot-service.cjs (which runs loadActiveKeypair() on startup) and reports the result.
// Usage: WALLET_AES_KEY=<64 hex> [EXPECTED_PUBKEY=<base58>] node test-decrypt.cjs
const bot = require('./bot-service.cjs');
const w = bot.state.wallet;

console.log('isConfigured :', w.isConfigured);
console.log('file loaded  :', w.path);
console.log('publicKey    :', w.publicKey);
console.log('error        :', w.error);

const expected = process.env.EXPECTED_PUBKEY;
if (!w.isConfigured) {
  console.error('\nFAIL: no wallet loaded');
  process.exit(1);
}
if (expected && expected !== w.publicKey) {
  console.error('\nFAIL: public key does not match EXPECTED_PUBKEY');
  process.exit(1);
}
console.log('\nPASS: wallet decrypted' + (expected ? ' and public key matches' : ' (no EXPECTED_PUBKEY given, so key not compared)'));
process.exit(0);

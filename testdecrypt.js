KEYPAIR_PATH="./wallet.json" WALLET_PASSPHRASE="L0n3_W0lf20@13" node -e "
const fs = require('fs'), crypto = require('crypto');
const file = JSON.parse(fs.readFileSync(process.env.KEYPAIR_PATH, 'utf8'));
const key = crypto.pbkdf2Sync(process.env.WALLET_PASSPHRASE, Buffer.from(file.salt, 'hex'), 100000, 32, 'sha256');
const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(file.iv, 'hex'));
let dec = decipher.update(file.encryptedData, 'hex', 'utf8') + decipher.final('utf8');
console.log('✅ Decryption successful! Keypair length:', Uint8Array.from(JSON.parse(dec)).length, 'bytes');
"

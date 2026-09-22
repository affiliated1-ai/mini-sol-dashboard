const fs = require('fs');
const crypto = require('crypto');
const { Keypair } = require('@solana/web3.js');

function verifyWalletPassphrase(filePath, passphrase) {
  try {
    const fileData = JSON.parse(fs.readFileSync(filePath));
    const salt = Buffer.from(fileData.salt, 'hex');
    const iv = Buffer.from(fileData.iv, 'hex');

    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

    let decrypted = decipher.update(fileData.encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    const secretKey = Uint8Array.from(JSON.parse(decrypted));
    const keypair = Keypair.fromSecretKey(secretKey);

    console.log('✅ Passphrase MATCHES!');
    console.log('🔑 Public Address:', keypair.publicKey.toBase58());
    return true;
  } catch (err) {
    console.log('❌ Passphrase INVALID or file corrupted!');
    return false;
  }
}

const targetFile = process.argv || './wallet-mainnet.json';
const testPass = process.argv || '';

verifyWalletPassphrase(targetFile, testPass);

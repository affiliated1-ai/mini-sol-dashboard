const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const crypto = require('crypto');

function createEncryptedWallet(filePath, password) {
  const keypair = Keypair.generate();
  const secretKeyData = JSON.stringify(Array.from(keypair.secretKey));

  // Derive encryption key from password
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(secretKeyData, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const payload = JSON.stringify({
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    encryptedData: encrypted
  });

  fs.writeFileSync(filePath, payload);

  console.log(`✅ Encrypted wallet created: ${filePath}`);
  console.log(`🔑 Public Address: ${keypair.publicKey.toBase58()}`);
}

const targetFile = process.argv[2] || './wallet-mainnet.json';
const passphrase = process.argv[3] || 'MySecretPassphrase123';

createEncryptedWallet(targetFile, passphrase);

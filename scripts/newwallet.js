const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { Keypair } = require('@solana/web3.js');

// CLI Arguments: node createwallet.js [outputFile] [passphrase]
const targetFile = process.argv[2] || './wallet-mainnet.json';
const cliPassphrase = process.argv[3];

function getPassphrase(providedPassphrase) {
  if (providedPassphrase) return Promise.resolve(providedPassphrase);

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.stdoutMuted = true;
    rl._writeToOutput = function _writeToOutput(stringToWrite) {
      if (rl.stdoutMuted) {
        rl.output.write('*');
      } else {
        rl.output.write(stringToWrite);
      }
    };

    rl.question('Enter passphrase for new wallet: ', (input) => {
      rl.close();
      console.log('');
      resolve(input.trim());
    });
  });
}

async function createWallet() {
  try {
    const passphrase = await getPassphrase(cliPassphrase);

    if (!passphrase) {
      throw new Error('Passphrase cannot be empty.');
    }

    // 1. Generate new Solana keypair
    const keypair = Keypair.generate();
    const rawSecretKey = JSON.stringify(Array.from(keypair.secretKey));

    // 2. Generate random salt and IV
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);

    // 3. Derive 256-bit key using PBKDF2
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');

    // 4. Encrypt raw keypair with AES-256-CBC
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(rawSecretKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // 5. Build encrypted payload
    const encryptedPayload = {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      encryptedData: encrypted
    };

    // 6. Write to disk
    fs.writeFileSync(targetFile, JSON.stringify(encryptedPayload, null, 2));

    console.log('==================================================');
    console.log(`✅ Fresh AES-256 encrypted wallet created: ${targetFile}`);
    console.log(`🔑 Public Address: ${keypair.publicKey.toBase58()}`);
    console.log('==================================================');
  } catch (err) {
    console.error('❌ Failed to create wallet:', err.message);
    process.exit(1);
  }
}

createWallet();

const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// CLI Arguments: node checkbalance.js [walletFile] [passphrase] [network]
const walletFile = process.argv[2] || './wallet-mainnet.json';
const cliPassphrase = process.argv[3];
const network = process.argv[4] || 'mainnet-beta';

// Secure interactive prompt if passphrase argument is omitted
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

    rl.question('Enter wallet passphrase: ', (input) => {
      rl.close();
      console.log(''); // Add newline after hitting Enter
      resolve(input.trim());
    });
  });
}

async function checkBalance() {
  try {
    if (!fs.existsSync(walletFile)) {
      throw new Error(`Wallet file not found at: ${walletFile}`);
    }

    // 1. Get Passphrase (from CLI or Interactive Prompt)
    const passphrase = await getPassphrase(cliPassphrase);

    if (!passphrase) {
      throw new Error('Passphrase cannot be empty.');
    }

    // 2. Read encrypted wallet file
    const fileData = JSON.parse(fs.readFileSync(walletFile, 'utf8'));

    // 3. Derive key and decrypt
    const salt = Buffer.from(fileData.salt, 'hex');
    const iv = Buffer.from(fileData.iv, 'hex');
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(fileData.encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    // 4. Get Public Address
    const secretKey = Uint8Array.from(JSON.parse(decrypted));
    const keypair = Keypair.fromSecretKey(secretKey);
    const pubkey = keypair.publicKey;

    // 5. Connect to RPC
    const rpcUrl = network === 'devnet'
      ? 'https://api.devnet.solana.com'
      : 'https://api.mainnet-beta.solana.com';

    const connection = new Connection(rpcUrl, 'confirmed');
    const balance = await connection.getBalance(pubkey);

    console.log('==================================================');
    console.log(`🔑 Public Address: ${pubkey.toBase58()}`);
    console.log(`🌐 Network:        ${network}`);
    console.log(`💰 SOL Balance:    ${balance / LAMPORTS_PER_SOL} SOL`);
    console.log('==================================================');
  } catch (err) {
    console.log('==================================================');
    console.error('❌ Error:', err.message);
    console.log('==================================================');
    process.exit(1);
  }
}

checkBalance();

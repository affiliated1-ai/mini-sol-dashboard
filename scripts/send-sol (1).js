'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  clusterApiUrl
} = require('@solana/web3.js');

/**
 * Interactive CLI Prompt Helper with Input Masking for Passphrases
 */
function promptUser(query, isPassword = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    if (isPassword) {
      const stdin = process.stdin;
      const onData = (char) => {
        char = char.toString('utf8');
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            stdin.removeListener('data', onData);
            break;
          default:
            process.stdout.write('\x1B[2K\x1B[0G' + query + '*'.repeat(rl.line.length));
            break;
        }
      };
      stdin.on('data', onData);
    }

    rl.question(query, (answer) => {
      rl.close();
      if (isPassword) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/**
 * Decrypt AES-256-CBC Encrypted Wallet JSON
 * FIX: Clones secretKeyBytes when instantiating Keypair so zeroing temporary decryption
 * memory does not corrupt the keypair's internal secret key buffer.
 */
function decryptWallet(filePath, passphrase) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Wallet file not found at: ${resolvedPath}`);
  }

  const fileContent = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  let secretKeyBytes;

  // Case A: Unencrypted JSON array
  if (Array.isArray(fileContent)) {
    secretKeyBytes = Uint8Array.from(fileContent);
  }
  // Case B: AES-256 Encrypted Object ({ salt, iv, encryptedData })
  else if (fileContent.salt && fileContent.iv && fileContent.encryptedData) {
    try {
      const salt = Buffer.from(fileContent.salt, 'hex');
      const iv = Buffer.from(fileContent.iv, 'hex');
      const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');

      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(fileContent.encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      secretKeyBytes = Uint8Array.from(JSON.parse(decrypted));
    } catch (err) {
      throw new Error('Decryption failed! Invalid passphrase or corrupted wallet payload.');
    }
  } else {
    throw new Error('Unrecognized wallet format. Expected JSON array or AES encrypted object.');
  }

  // Construct Solana Keypair using an explicit CLONED Uint8Array copy
  let keypair;
  if (secretKeyBytes.length === 64) {
    keypair = Keypair.fromSecretKey(new Uint8Array(secretKeyBytes));
  } else if (secretKeyBytes.length === 32) {
    keypair = Keypair.fromSeed(new Uint8Array(secretKeyBytes));
  } else {
    throw new Error(`Invalid secret key byte length (${secretKeyBytes.length} bytes). Must be 32 or 64 bytes.`);
  }

  // Safe to zero out temporary decryption array after cloning
  secretKeyBytes.fill(0);

  return keypair;
}

/**
 * Main Standalone Transfer Script
 */
async function main() {
  console.log('\n======================================================');
  console.log('       SOLANA AES WALLET DIRECT TRANSFER SCRIPT       ');
  console.log('======================================================\n');

  try {
    // 1. Wallet File Path Prompt
    const walletPathInput = await promptUser('📁 Enter wallet file path [default: ./wallet-mainnet.json]: ');
    const walletPath = walletPathInput || './wallet-mainnet.json';

    // 2. Passphrase Prompt
    const passphrase = await promptUser('🔑 Enter AES wallet passphrase: ', true);
    if (!passphrase) {
      throw new Error('Passphrase cannot be empty.');
    }

    // 3. Decrypt Keypair
    console.log('🔓 Decrypting wallet keypair...');
    const senderKeypair = decryptWallet(walletPath, passphrase);
    console.log(`✅ Wallet unlocked! Sender Address: ${senderKeypair.publicKey.toBase58()}\n`);

    // 4. Recipient Address Prompt
    const recipientInput = await promptUser('🎯 Enter recipient SOL address: ');
    let recipientPubkey;
    try {
      recipientPubkey = new PublicKey(recipientInput);
    } catch {
      throw new Error('Invalid recipient Solana public key address!');
    }

    // 5. SOL Amount Prompt
    const amountInput = await promptUser('💰 Enter amount of SOL to send: ');
    const amountSol = parseFloat(amountInput);
    if (isNaN(amountSol) || amountSol <= 0) {
      throw new Error('Invalid SOL amount specified.');
    }
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

    // 6. Connect to Solana Network (Automatic RPC selection)
    const rpcUrl = process.env.RPC_URL || clusterApiUrl('mainnet-beta');
    const connection = new Connection(rpcUrl, 'confirmed');

    // Fetch Sender Balance & Validate Funds
    const balanceLamports = await connection.getBalance(senderKeypair.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    console.log(`💳 Wallet Balance: ${balanceSol.toFixed(4)} SOL`);

    if (balanceLamports < lamports) {
      throw new Error(`Insufficient funds! Wallet balance (${balanceSol.toFixed(4)} SOL) is less than transfer amount (${amountSol} SOL + network fee).`);
    }

    // 7. Transaction Summary & Confirmation
    console.log('\n------------------------------------------------------');
    console.log('                 TRANSACTION SUMMARY                  ');
    console.log('------------------------------------------------------');
    console.log(` Sender:    ${senderKeypair.publicKey.toBase58()}`);
    console.log(` Recipient: ${recipientPubkey.toBase58()}`);
    console.log(` Amount:    ${amountSol} SOL (${lamports.toLocaleString()} lamports)`);
    console.log('------------------------------------------------------\n');

    const confirm = await promptUser('⚠️ Confirm and send transaction? (yes/no): ');
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('❌ Transaction canceled by user.');
      process.exit(0);
    }

    // 8. Fetch Blockhash & Build Transaction
    console.log('\n🚀 Fetching latest blockhash and constructing transaction...');
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports
      })
    );

    transaction.recentBlockhash = blockhash;
    transaction.feePayer = senderKeypair.publicKey;

    // 9. Sign Transaction with Decrypted Keypair
    transaction.sign(senderKeypair);

    // 10. Broadcast Raw Transaction
    console.log('📡 Broadcasting signed transaction to Solana network...');
    const rawTransaction = transaction.serialize();
    const txHash = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });

    console.log('\n🎉 TRANSACTION SUCCESSFUL!');
    console.log(`📌 Signature / Tx Hash: ${txHash}`);
    console.log(`🔗 Solscan Explorer:    https://solscan.io/tx/${txHash}`);

  } catch (err) {
    console.error(`\n❌ ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();

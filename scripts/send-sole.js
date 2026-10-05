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
 * Interactive CLI Prompt Helper with Input Masking
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
 * Decrypt AES-256 Encrypted JSON Wallet
 */
function decryptWallet(filePath, passphrase) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Wallet file not found at: ${resolvedPath}`);
  }

  const fileContent = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  let secretKeyBytes;

  if (Array.isArray(fileContent)) {
    secretKeyBytes = Uint8Array.from(fileContent);
  } else if (fileContent.salt && fileContent.iv && fileContent.encryptedData) {
    try {
      const salt = Buffer.from(fileContent.salt, 'hex');
      const iv = Buffer.from(fileContent.iv, 'hex');
      const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');

      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(fileContent.encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      secretKeyBytes = Uint8Array.from(JSON.parse(decrypted));
    } catch (err) {
      throw new Error('Decryption failed! Incorrect AES passphrase or corrupted payload.');
    }
  } else {
    throw new Error('Unrecognized wallet format. Must be JSON array or AES encrypted object.');
  }

  let keypair;
  if (secretKeyBytes.length === 64) {
    keypair = Keypair.fromSecretKey(secretKeyBytes);
  } else if (secretKeyBytes.length === 32) {
    keypair = Keypair.fromSeed(secretKeyBytes);
  } else {
    throw new Error(`Invalid secret key byte length: ${secretKeyBytes.length}`);
  }

  // Memory Security: Zero out sensitive secret key bytes immediately
  secretKeyBytes.fill(0);
  return keypair;
}

/**
 * Main Execution Loop for node send-sole.js
 */
async function main() {
  console.log('\n======================================================');
  console.log('       SOLANA AES WALLET DIRECT TRANSFER SCRIPT       ');
  console.log('======================================================\n');

  try {
    // Variable 1: Wallet File Path
    const walletPathInput = await promptUser('📁 Enter wallet file path [default: ./wallet-mainnet.json]: ');
    const walletPath = walletPathInput || './wallet-mainnet.json';

    // Variable 2: AES Passphrase
    const passphrase = await promptUser('🔑 Enter AES wallet passphrase: ', true);
    if (!passphrase) {
      throw new Error('Passphrase is required.');
    }

    // Decrypt Wallet Keypair
    console.log('🔓 Decrypting wallet keypair...');
    const senderKeypair = decryptWallet(walletPath, passphrase);
    console.log(`✅ Wallet unlocked! Address: ${senderKeypair.publicKey.toBase58()}\n`);

    // Variable 3: Network Selection
    const netChoice = await promptUser('🌐 Select Network (1: Mainnet-Beta, 2: Devnet) [default: 1]: ');
    const isDevnet = netChoice === '2';
    const defaultRpc = isDevnet ? clusterApiUrl('devnet') : clusterApiUrl('mainnet-beta');
    
    // Variable 4: Custom RPC URL
    const customRpc = await promptUser(`📡 Enter RPC URL [default: ${defaultRpc}]: `);
    const rpcUrl = customRpc || defaultRpc;

    const connection = new Connection(rpcUrl, 'confirmed');

    // Fetch and check balance
    console.log('\n🔍 Fetching account balance...');
    const balanceLamports = await connection.getBalance(senderKeypair.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    console.log(`💳 Current Wallet Balance: ${balanceSol.toFixed(4)} SOL`);

    if (balanceLamports === 0) {
      throw new Error('Wallet has 0 SOL balance. Cannot perform transfer.');
    }

    // Variable 5: Recipient Address
    const recipientInput = await promptUser('\n🎯 Enter recipient SOL public key address: ');
    let recipientPubkey;
    try {
      recipientPubkey = new PublicKey(recipientInput);
    } catch {
      throw new Error('Invalid recipient Solana address!');
    }

    // Variable 6: SOL Transfer Amount
    const amountInput = await promptUser('💰 Enter amount of SOL to send: ');
    const amountSol = parseFloat(amountInput);
    if (isNaN(amountSol) || amountSol <= 0) {
      throw new Error('Invalid SOL amount entered.');
    }
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

    if (balanceLamports < lamports) {
      throw new Error(`Insufficient balance! Needed: ${amountSol} SOL + gas fees, Available: ${balanceSol.toFixed(4)} SOL.`);
    }

    // Review & Confirmation
    console.log('\n------------------------------------------------------');
    console.log('                 TRANSACTION CONFIRMATION             ');
    console.log('------------------------------------------------------');
    console.log(` Network:   ${isDevnet ? 'Devnet' : 'Mainnet-Beta'}`);
    console.log(` Sender:    ${senderKeypair.publicKey.toBase58()}`);
    console.log(` Recipient: ${recipientPubkey.toBase58()}`);
    console.log(` Amount:    ${amountSol} SOL (${lamports.toLocaleString()} lamports)`);
    console.log('------------------------------------------------------\n');

    const confirm = await promptUser('⚠️ Are you sure you want to send this transaction? (yes/no): ');
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('❌ Transaction canceled.');
      process.exit(0);
    }

    // Build, Sign & Send
    console.log('\n🚀 Building and signing transaction...');
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
    transaction.sign(senderKeypair);

    console.log('📡 Broadcasting to Solana network...');
    const rawTx = transaction.serialize();
    const txHash = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });

    console.log('\n🎉 SUCCESSFUL TRANSACTION!');
    console.log(`📌 Signature / Tx Hash: ${txHash}`);
    console.log(`🔗 Explorer Link:       https://solscan.io/tx/${txHash}${isDevnet ? '?cluster=devnet' : ''}`);

  } catch (err) {
    console.error(`\n❌ ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();

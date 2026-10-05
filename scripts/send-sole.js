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
  clusterApiUrl,
  SendTransactionError
} = require('@solana/web3.js');

/**
 * Prompt user in CLI with optional input masking (for passphrases)
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

  // CRITICAL FIX: Pass a CLONED Uint8Array to Keypair creation so that secretKeyBytes.fill(0)
  // does not wipe the secret key inside the Keypair object in memory!
  let keypair;
  const clonedKeyBytes = new Uint8Array(secretKeyBytes);

  if (clonedKeyBytes.length === 64) {
    keypair = Keypair.fromSecretKey(clonedKeyBytes);
  } else if (clonedKeyBytes.length === 32) {
    keypair = Keypair.fromSeed(clonedKeyBytes);
  } else {
    throw new Error(`Invalid secret key length (${clonedKeyBytes.length} bytes). Must be 32 or 64 bytes.`);
  }

  // Safe memory cleanup of temporary decryption buffer
  secretKeyBytes.fill(0);

  return keypair;
}

/**
 * Main Standalone Transfer Script
 */
async function main() {
  console.log('\n======================================================');
  console.log('       SOLANA AES-ENCRYPTED WALLET TRANSFER SCRIPT    ');
  console.log('======================================================\n');

  try {
    // 1. Get Wallet File Path
    const walletPathInput = await promptUser('📁 Enter wallet file path [default: ./wallet-mainnet.json]: ');
    const walletPath = walletPathInput || './wallet-mainnet.json';

    // 2. Prompt for AES Passphrase
    const passphrase = await promptUser('🔑 Enter AES wallet passphrase: ', true);
    if (!passphrase) {
      throw new Error('Passphrase cannot be empty.');
    }

    // 3. Decrypt Keypair
    console.log('🔓 Decrypting wallet keypair...');
    const senderKeypair = decryptWallet(walletPath, passphrase);
    console.log(`✅ Wallet unlocked! Sender Address: ${senderKeypair.publicKey.toBase58()}\n`);

    // 4. Select Network / RPC URL
    const netChoice = await promptUser('🌐 Select Network (1: Mainnet-Beta, 2: Devnet) [default: 1]: ');
    const isDevnet = netChoice === '2';
    const defaultRpc = isDevnet ? clusterApiUrl('devnet') : (process.env.RPC_URL || clusterApiUrl('mainnet-beta'));
    
    const customRpc = await promptUser(`📡 Enter RPC URL [default: ${defaultRpc}]: `);
    const rpcUrl = customRpc || defaultRpc;

    console.log(`\n🌐 Connecting to RPC endpoint: ${rpcUrl}...`);
    const connection = new Connection(rpcUrl, 'confirmed');

    // 5. Fetch Sender Balance
    const balanceLamports = await connection.getBalance(senderKeypair.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    console.log(`💳 Current Wallet Balance: ${balanceSol.toFixed(6)} SOL (${balanceLamports.toLocaleString()} lamports)`);

    if (balanceLamports === 0) {
      throw new Error(`Wallet ${senderKeypair.publicKey.toBase58()} has 0 SOL on ${isDevnet ? 'Devnet' : 'Mainnet'}. Please ensure you are on the correct network or fund the wallet.`);
    }

    // 6. Prompt for Recipient Address
    const recipientInput = await promptUser('\n🎯 Enter recipient SOL address: ');
    let recipientPubkey;
    try {
      recipientPubkey = new PublicKey(recipientInput);
    } catch {
      throw new Error('Invalid recipient Solana public key address!');
    }

    // 7. Prompt for Amount in SOL
    const amountInput = await promptUser('💰 Enter amount of SOL to send: ');
    const amountSol = parseFloat(amountInput);
    if (isNaN(amountSol) || amountSol <= 0) {
      throw new Error('Invalid SOL amount specified.');
    }
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
    const estimatedFee = 5000; // 0.000005 SOL transaction fee

    if (balanceLamports < lamports + estimatedFee) {
      throw new Error(`Insufficient funds! Transfer requires ${amountSol} SOL + ~0.000005 SOL fee (${(lamports + estimatedFee) / LAMPORTS_PER_SOL} SOL total), but wallet only has ${balanceSol} SOL.`);
    }

    // 8. Summary & Confirmation
    console.log('\n------------------------------------------------------');
    console.log('                 TRANSACTION SUMMARY                  ');
    console.log('------------------------------------------------------');
    console.log(` Network:   ${isDevnet ? 'Devnet' : 'Mainnet-Beta'}`);
    console.log(` RPC Endpoint: ${rpcUrl}`);
    console.log(` Sender:    ${senderKeypair.publicKey.toBase58()}`);
    console.log(` Recipient: ${recipientPubkey.toBase58()}`);
    console.log(` Amount:    ${amountSol} SOL (${lamports.toLocaleString()} lamports)`);
    console.log('------------------------------------------------------\n');

    const confirm = await promptUser('⚠️ Confirm and send transaction? (yes/no): ');
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('❌ Transaction canceled by user.');
      process.exit(0);
    }

    // 9. Build, Sign & Send Transaction
    console.log('\n🚀 Fetching latest blockhash and constructing transaction...');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction({
      feePayer: senderKeypair.publicKey,
      recentBlockhash: blockhash
    }).add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports
      })
    );

    // Sign with decrypted keypair (which now retains its secret key safely)
    transaction.sign(senderKeypair);

    console.log('📡 Broadcasting signed transaction to Solana network...');
    const rawTransaction = transaction.serialize();

    let txHash;
    try {
      txHash = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });

      console.log('⏳ Confirming transaction on cluster...');
      await connection.confirmTransaction({
        signature: txHash,
        blockhash,
        lastValidBlockHeight
      }, 'confirmed');

      console.log('\n🎉 TRANSACTION SUCCESSFUL!');
      console.log(`📌 Signature / Tx Hash: ${txHash}`);
      console.log(`🔗 Solscan Explorer:    https://solscan.io/tx/${txHash}${isDevnet ? '?cluster=devnet' : ''}`);
    } catch (sendErr) {
      if (sendErr instanceof SendTransactionError) {
        console.error('\n❌ SendTransactionError Logs:');
        if (sendErr.logs && sendErr.logs.length > 0) {
          sendErr.logs.forEach(log => console.error(`   > ${log}`));
        } else {
          console.error(`   > ${sendErr.message}`);
        }
      }
      throw sendErr;
    } finally {
      // Clean up sensitive keypair in memory after transaction completes
      if (senderKeypair && senderKeypair.secretKey) {
        senderKeypair.secretKey.fill(0);
      }
    }

  } catch (err) {
    console.error(`\n❌ ERROR: ${err.message}`);
    process.exit(1);
  }
}

// Execute Script
main();

import { schnorr, utils, hashes } from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';

// This file demonstrates how to achieve provably unique and unbiasable randomness
// using deterministic Bitcoin-style signatures (Schnorr with RFC6979 nonce generation).
// This approach is compatible with the on-chain `checkDataSig` function.

async function main() {
    // --- Step 1: Oracle Key Generation (Done once) ---
    // The oracle generates a private key and a corresponding public key.
    // The public key is shared publicly so anyone can verify the signatures.
    const oraclePrivateKey = utils.randomSecretKey();
    const oraclePublicKey = schnorr.getPublicKey(oraclePrivateKey);

    console.log('Oracle Public Key:', bytesToHex(oraclePublicKey));

    // --- Step 2: Oracle Generates a Deterministic Signature ---
    // The oracle receives an input, which should be a unique identifier for the event.
    // In ArkadeKitties, this would be the outpoint of the commit transaction.
    const commitOutpoint = 'a_unique_transaction_outpoint_as_bytes';
    const message = Buffer.from(commitOutpoint, 'utf-8');

    // The message to be signed is the SHA256 hash of the commit outpoint.
    if (!hashes.sha256) {
        throw new Error('sha256 hash function is not available. Ensure `@noble/hashes` is installed.');
    }
    const messageHash = hashes.sha256(message);

    // The oracle signs the message hash. By default, noble-secp256k1 uses RFC6979
    // for deterministic nonce generation, which is crucial. This means for a given
    // private key and message, the signature will always be the same.
    // The oracle has NO ability to alter the signature to influence the outcome.
    const signature = await schnorr.sign(messageHash, oraclePrivateKey);

    // The signature itself becomes the source of entropy.
    const oracleRand = signature;

    console.log('\n--- Oracle Side ---');
    console.log('Input (Commit Outpoint):', commitOutpoint);
    console.log('Generated Entropy (Signature):', bytesToHex(oracleRand));

    // The oracle provides the `oracleRand` (the signature) to the user.

    // --- Step 3: Client Verifies the Signature ---
    // The user's client receives the `oracleRand` from the oracle.
    // The client can now verify this signature against the oracle's public key
    // and the commit outpoint. This is exactly what the on-chain contract does.
    try {
        const isValid = await schnorr.verify(oracleRand, messageHash, oraclePublicKey);

        if (isValid) {
            console.log('\n--- Client Side ---');
            console.log('Verification Successful!');
            console.log('The signature is valid and can be used as oracleRand.');

            // This `oracleRand` is what the client would use in the reveal transaction.
            // It is now safe to proceed.
        } else {
            throw new Error('Signature verification failed.');
        }

    } catch (error: any) {
        console.error('\n--- Client Side ---');
        console.error('Signature Verification Failed:', error.message);
        // If verification fails, the client should not proceed.
    }
}

main();

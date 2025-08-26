# ArkAsset Integration with Arkade Script

This document demonstrates how to integrate ArkAssets with Arkade Script, providing introspection capabilities and example contracts for common use cases.

## Asset Introspection API

### Asset Group Introspection

ArkAssets extend Arkade Script with asset-specific introspection, following a pattern similar to other smart contract languages:

```javascript
// Transaction basics
bytes32 tx.txid;                               // maps to OP_TXHASH

// Asset Group Introspection
int tx.assetGroups.length;                    // Number of asset groups -> maps to OP_INSPECTNUMASSETGROUPS
AssetGroup tx.assetGroups.find(AssetId);     // Find a group by asset ID -> maps to OP_FINDASSETGROUPBYASSETID

// AssetGroup Object
AssetId tx.assetGroups[i].assetId;            // Asset ID for this group -> maps to OP_INSPECTASSETGROUPASSETID
bytes32 tx.assetGroups[i].metadataHash;       // sha256 hash of on-chain metadata -> maps to OP_INSPECTASSETGROUPMETADATAHASH
int tx.assetGroups[i].numInputs;              // Number of inputs in the group -> maps to OP_INSPECTASSETGROUPNUMIN
int tx.assetGroups[i].numOutputs;             // Number of outputs in the group -> maps to OP_INSPECTASSETGROUPNUMOUT
bigint tx.assetGroups[i].delta;              // Net change (outputs - inputs) -> maps to OP_INSPECTASSETGROUPDELTA
bigint tx.assetGroups[i].sumInputs;           // Sum of input amounts -> maps to OP_INSPECTASSETGROUPSUMIN
bigint tx.assetGroups[i].sumOutputs;          // Sum of output amounts -> maps to OP_INSPECTASSETGROUPSUMOUT
AssetInput tx.assetGroups[i].getInput(int);    // Get an input by index -> maps to OP_INSPECTASSETGROUPIN
AssetOutput tx.assetGroups[i].getOutput(int); // Get an output by index -> maps to OP_INSPECTASSETGROUPOUT

// AssetInput Object
AssetInputType tx.assetGroups[i].inputs[j].type; // LOCAL or TELEPORT
bigint tx.assetGroups[i].inputs[j].amount;       // Asset amount
// TELEPORT only:
bytes32 tx.assetGroups[i].inputs[j].commitment; // Teleport commitment

// AssetOutput Object
AssetOutputType tx.assetGroups[i].outputs[j].type; // LOCAL or TELEPORT
bigint tx.assetGroups[i].outputs[j].amount;        // Asset amount
// TELEPORT only:
bytes32 tx.assetGroups[i].outputs[j].commitment;  // Teleport commitment
// LOCAL only:
bytes tx.assetGroups[i].outputs[j].scriptPubKey; // Output script (via out_index from OP_INSPECTASSETGROUPOUT + OP_INSPECTOUTPUTSCRIPTPUBKEY)

// Enum Types
enum AssetInputType { LOCAL, TELEPORT }
enum AssetOutputType { LOCAL, TELEPORT }

// Cross-input lookups (packet-declared)
int    tx.inputs[i].assets.length;               // maps to OP_INSPECTINASSETCOUNT
AssetId tx.inputs[i].assets[j].assetId;          // maps to OP_INSPECTINASSETAT (asset id part)
bigint  tx.inputs[i].assets[j].amount;           // maps to OP_INSPECTINASSETAT (amount part)
bigint  tx.inputs[i].assets.lookup(AssetId);     // maps to OP_INSPECTINASSETLOOKUP (amount | 0)

// AssetGroup lineage pointer (control asset reference)
AssetId tx.assetGroups[i].control;                 // maps to OP_INSPECTASSETGROUPCTRL

// Output introspection (multi-asset per UTXO)
int   tx.outputs.length;                           // number of transaction outputs
bytes tx.outputs[i].scriptPubKey;                  // maps to OP_INSPECTOUTPUTSCRIPTPUBKEY
int   tx.outputs[i].assets.length;                 // maps to OP_INSPECTOUTASSETCOUNT
AssetId tx.outputs[i].assets[j].assetId;          // maps to OP_INSPECTOUTASSETAT (asset id part)
bigint  tx.outputs[i].assets[j].amount;           // maps to OP_INSPECTOUTASSETAT (amount part)
bigint  tx.outputs[i].assets.lookup(AssetId);     // maps to OP_INSPECTOUTASSETLOOKUP (amount | 0)
```

### Asset Types and Structures

```javascript
// Asset ID type
struct AssetId {
    bytes32 txid;
    int gidx;
}

// Asset reference for control assets
struct AssetRef {
    bool byId;              // true for BY_ID, false for BY_GROUP
    AssetId assetId;        // Used when byId = true
    int groupIndex;         // Used when byId = false
}

// Teleport-specific introspection records
struct TeleportOut {
    bytes32 txid;
    int vout;
    bigint amount;
}
struct TeleportIn {
    bytes32 txid;
    int vout;
    bigint amount;
}
```

## Example Contracts

### 1. Teleport Batch Swap Contract

This contract enforces that assets are teleported in and out correctly for batch swaps using commitments:

```typescript
contract TeleportBatchSwap(
    operator: PubKey
) {
    function execute(
        sig: Sig,
        inAssetId: AssetId,
        inCommitment: bytes32,
        inAmount: bigint,
        outAssetId: AssetId,
        outCommitment: bytes32,
        outAmount: bigint
    ) {
        // Verify operator signature
        require(checkSig(sig, operator));

        // Verify the expected teleport input is present
        let inGroup = tx.assetGroups.find(inAssetId);
        require(inGroup != null, "Missing expected input asset");
        // Note: A real contract would check for a specific input, but since loops are
        // not allowed, we check the first input as an example.
        require(inGroup.numInputs > 0, "Input asset group has no inputs");
        let input = inGroup.getInput(0);
        require(input.type == AssetInputType.TELEPORT, "Input is not a teleport");
        require(input.commitment == inCommitment, "Incorrect input commitment");
        require(input.amount == inAmount, "Incorrect input amount");

        // Verify the expected teleport output is present
        let outGroup = tx.assetGroups.find(outAssetId);
        require(outGroup != null, "Missing expected output asset");
        require(outGroup.numOutputs > 0, "Output asset group has no outputs");
        let output = outGroup.getOutput(0);
        require(output.type == AssetOutputType.TELEPORT, "Output is not a teleport");
        require(output.commitment == outCommitment, "Incorrect output commitment");
        require(output.amount == outAmount, "Incorrect output amount");
    }
}
```

**Use Case**: Premium VTXOs that require holding governance tokens or membership NFTs.


### 2. Teleport Batch Swap

A VTXO designed for Arkade batch swaps using teleport transfers:

```javascript
pragma arkade ^1.0.0;

// Arkade batch swap using teleport transfers
contract BatchSwapVTXO(
    pubkey userPk,
    pubkey operatorPk,
    bytes32 targetCommitment
) {
    function forfeit(signature userSig) {
        require(checkSig(userSig, userPk));
        
        // Ensure all assets are teleported with the target commitment
        // Note: This check is illustrative. A real contract would need to know which asset
        // groups to check, for example by passing the AssetIds in the constructor.
        require(tx.assetGroups.length > 0, "Transaction must have assets");
        require(tx.assetGroups[0].numOutputs > 0, "First asset group has no outputs");
        let firstOut = tx.assetGroups[0].getOutput(0);
        require(firstOut.type == AssetOutputType.TELEPORT, "First output is not a teleport");
        require(firstOut.commitment == targetCommitment, "First asset group must teleport to target");
    }
    
    function operatorSpend(signature operatorSig) {
        require(checkSig(operatorSig, operatorPk));
        // Operator can spend after timeout
        require(tx.time >= this.age + 144); // 24 hour timeout
    }
}
```

**Use Case**: Enables seamless asset continuity across VTXO batch swaps without requiring operator liquidity fronting.

### 3. Gated Asset Swap (Explicit Merkle Verification)

This contract provides a realistic implementation of metadata verification for a language without loops. It performs an explicit, unrolled Merkle proof verification for a fixed-depth tree (in this case, depth 4). This removes any reliance on abstract helper functions and represents a secure, standard pattern.

```typescript
pragma arkade ^1.0.0;

// Verifies a Merkle proof for a fixed-depth tree.
// - leaf: The hash of the data being proven.
// - root: The Merkle root from the on-chain asset state.
// - proof: An array of sibling hashes.
// - path: A bitmap indicating the position of the sibling at each level (0 for right, 1 for left).
function verifyMerkleProof(leaf: bytes32, root: bytes32, proof: bytes32[4], path: bigint): bool {
    let computed = leaf;
    // Unrolled loop for a tree of depth 4
    computed = (path & 1n) ? sha256(proof[0] + computed) : sha256(computed + proof[0]);
    computed = (path & 2n) ? sha256(proof[1] + computed) : sha256(computed + proof[1]);
    computed = (path & 4n) ? sha256(proof[2] + computed) : sha256(computed + proof[2]);
    computed = (path & 8n) ? sha256(proof[3] + computed) : sha256(computed + proof[3]);
    return computed == root;
}

contract GatedAssetSwap(
    pubkey userA, pubkey userB,
    assetId assetA, bigint amountA,
    assetId assetB, bigint amountB
) {
    function execute(
        sigA: Sig, sigB: Sig,
        keyA: bytes, valueA: bytes, leafA: bytes32, proofA: bytes32[4], pathA: bigint,
        keyB: bytes, valueB: bytes, leafB: bytes32, proofB: bytes32[4], pathB: bigint
    ) {
        require(checkSig(sigA, userA));
        require(checkSig(sigB, userB));

        let groupA = tx.assetGroups.find(assetA);
        let groupB = tx.assetGroups.find(assetB);
        require(groupA != null && groupB != null, "Missing asset groups");

        // Verify that one asset is a stablecoin by checking its metadata property.
        let isAStable = keyA == 'is_stablecoin' && valueA == 'true' && verifyMerkleProof(leafA, groupA.metadataHash, proofA, pathA);
        let isBStable = keyB == 'is_stablecoin' && valueB == 'true' && verifyMerkleProof(leafB, groupB.metadataHash, proofB, pathB);
        require(isAStable || isBStable, "One asset must be a verified stablecoin");

        // Verify the swap amounts
        require(groupA.delta == amountB - amountA, "Incorrect delta for asset A");
        require(groupB.delta == amountA - amountB, "Incorrect delta for asset B");
    }
}
```

**Use Case**: Creating decentralized exchanges (DEXs) or swap pools that enforce specific rules about the types of assets that can be traded, without relying on a centralized operator or oracle.

### 4. Multi-Asset Escrow with Teleports

An escrow that holds multiple assets and releases them via teleports using pre-agreed commitments:

```typescript
contract MultiAssetEscrow(
    seller: PubKey,
    buyer: PubKey,
    arbiter: PubKey,
    releaseHeight: int
) {
    function release(sellerSig: Sig, buyerSig: Sig, arbiterSig: Sig, assetId: AssetId, releaseCommitment: bytes32) {
        // Before timeout, need 2-of-3 signatures
        // After timeout, only seller signature is needed
        require(
            (tx.time >= releaseHeight && checkSig(sellerSig, seller)) ||
            (checkMultiSig([sellerSig, buyerSig, arbiterSig], [seller, buyer, arbiter], 2))
        );
        
        // Verify the asset is being teleported to the correct commitment
        let group = tx.assetGroups.find(assetId);
        require(group != null, "Missing asset");
        require(group.numOutputs > 0, "Asset group has no outputs");
        let out0 = group.getOutput(0);
        require(out0.type == AssetOutputType.TELEPORT, "Output is not a teleport");
        require(out0.commitment == releaseCommitment, "Missing required teleport output");
    }
}
```

**Use Case**: Cross-chain or complex trades where assets need to be delivered to specific destinations in a coordinated manner.

### 4. Asset Reissuance Controller

A contract that manages control assets for reissuance operations:

```javascript
pragma arkade ^1.0.0;

// Control asset management for reissuance
contract AssetController(
    pubkey issuerPk,
    AssetId controlAssetId,
    AssetId reissuedAssetId
) {
    function reissue(signature issuerSig, int newAmount) {
        require(checkSig(issuerSig, issuerPk));
        
        // Find control asset group
        let controlGroup = tx.assetGroups.find(controlAssetId);
        require(controlGroup != null, "Control asset not found");
        // Control asset must be present; retention (Δ=0) is not required
        
        // Find controlled asset group and verify reissuance amount
        let reissuedGroup = tx.assetGroups.find(reissuedAssetId);
        require(reissuedGroup != null, "Reissued asset not found");
        require(reissuedGroup.delta == newAmount, "Wrong reissuance amount");
    }
}
```

**Use Case**: Stablecoin issuers or asset managers who need programmatic control over supply management.

### 5. Asset Swap with Price Oracle

A decentralized exchange contract that uses price oracles for asset swaps:

```javascript
pragma arkade ^1.0.0;

// Asset swap with oracle price verification
contract AssetSwap(
    pubkey oraclePk,
    bytes32 baseAssetTxid,
    int baseAssetGidx,
    bytes32 quoteAssetTxid,
    int quoteAssetGidx,
    int maxSlippageBps  // Basis points (100 = 1%)
) {
    function swap(
        signature userSig,
        pubkey userPk,
        datasig oracleSig,
        bytes oracleMessage
    ) {
        require(checkSig(userSig, userPk));
        
        // Decode oracle price message { timestamp, basePrice, quotePrice }
        bytes4 timestampBin, bytes4 basePriceBin, bytes4 quotePriceBin = oracleMessage.split(4);
        int timestamp = int(timestampBin);
        int basePrice = int(basePriceBin);
        int quotePrice = int(quotePriceBin);
        
        // Verify oracle signature and freshness
        require(checkDataSig(oracleSig, oracleMessage, oraclePk));
        require(tx.time <= timestamp + 300); // 5 minute freshness
        
        // Find asset groups
        let baseGroup = tx.assetGroups.find({txid: baseAssetTxid, gidx: baseAssetGidx});
        let quoteGroup = tx.assetGroups.find({txid: quoteAssetTxid, gidx: quoteAssetGidx});
        require(baseGroup != null && quoteGroup != null, "Assets not found");
        
        // Calculate expected exchange rate with slippage tolerance
        int expectedRate = (basePrice * 10000) / quotePrice;
        int actualRate = (baseGroup.delta * 10000) / (-quoteGroup.delta);
        
        int slippage = abs(actualRate - expectedRate) * 10000 / expectedRate;
        require(slippage <= maxSlippageBps, "Slippage too high");
    }
}
```

**Use Case**: Automated market makers or DEX contracts that need price verification for fair swaps.

### 6. Multi-Signature Asset Vault

A vault requiring multiple signatures to release assets:

```javascript
pragma arkade ^1.0.0;

// Multi-signature vault for asset custody
contract MultiSigAssetVault(
    pubkey[3] signers,
    int requiredSigs
) {
    function release(signature[3] sigs, AssetId controlledAssetId, bytes32 targetCommitment) {
        // Verify we have enough valid signatures from the allowed signers
        require(checkMultiSig(sigs, signers, requiredSigs), "Insufficient signatures");
        
        // The controlled asset must teleport with the specified commitment
        let group = tx.assetGroups.find(controlledAssetId);
        require(group != null, "Controlled asset not found");
        require(group.numOutputs > 0, "Controlled asset group has no outputs");
        let out0 = group.getOutput(0);
        require(out0.type == AssetOutputType.TELEPORT, "First output is not a teleport");
        require(out0.commitment == targetCommitment, "Wrong target commitment");
    }
}
```

**Use Case**: Corporate treasuries or DAOs that require multiple approvals for asset movements.

## Key Integration Benefits

### 1. Teleport Support
The introspection API distinguishes between LOCAL and TELEPORT transfers, enabling batch swap contracts to enforce proper asset flow across transactions.

### 2. Asset Balance Validation
Contracts can verify asset ownership and amounts before allowing VTXO spending, enabling asset-gated functionality.

### 3. Control Asset Management
Contracts can enforce proper control asset retention during reissuance operations.

### 4. Multi-Asset Handling
The group-based structure allows contracts to handle multiple asset types in a single transaction efficiently.

### 5. Cross-Transaction Coordination
Teleport transfers enable complex multi-party protocols where assets need to move between different transactions in a coordinated manner.

## Implementation Notes

- All introspection data is read-only and reflects the current transaction's ArkAsset packet
- Teleport validation requires both source and target transactions to confirm
- Asset amounts are handled as 64-bit integers following ArkAsset specification
- Control asset validation follows the standard ArkAsset authorization model
- Error messages should be descriptive to aid in debugging contract execution

This integration maintains Arkade Script's familiar syntax while adding powerful asset introspection capabilities that leverage ArkAsset's teleport system for seamless batch swap operations and advanced asset management scenarios.

---

## 4. Synthetic Asset Contract

Based on the "Synthetic asset smart contract for the Liquid network" paper, this contract locks collateral to issue a synthetic asset that tracks a reference price. It includes clauses for redemption by the sponsor, liquidation by the issuer if the collateral value falls, and cooperative re-issuance.

### Synthetic Asset Covenant

This contract manages the locked collateral for a synthetic asset. It has three spending paths:

1.  **Redeem**: The sponsor can redeem their collateral by burning the originally issued synthetic assets after a lock-up period.
2.  **Liquidate**: The issuer can liquidate the position if the reference price drops below a threshold, using a signature from a trusted oracle.
3.  **Reissue**: The sponsor and issuer can cooperatively close the current contract to roll the collateral into a new one with updated parameters.

```typescript
contract SyntheticAssetCovenant(
    // Parties
    sponsorPk: PubKey,
    issuerPk: PubKey,
    oraclePk: PubKey,

    // Contract terms
    collateralAsset: AssetId,
    collateralAmount: bigint,
    synthAsset: AssetId,
    synthAmount: bigint,
    payoutAmount: bigint, // Fee for the issuer on redemption

    // Thresholds
    liquidationPriceLevel: bigint, // Pre-calculated liquidation price threshold
    minLockupDuration: int // Minimum time before sponsor can redeem
) {
    // Path 1: Sponsor redeems the collateral
    function redeem(sponsorSig: Sig) {
        require(checkSig(sponsorSig, sponsorPk));
        require(tx.age >= minLockupDuration);

        // Verify asset movements using deltas
        let synthGroup = tx.assetGroups.find(synthAsset);
        let collateralGroup = tx.assetGroups.find(collateralAsset);
        require(synthGroup != null && collateralGroup != null, "Asset groups not found");

        // 1. The exact amount of synth must be burned (delta = -synthAmount)
        require(synthGroup.delta == -synthAmount, "Incorrect synth amount burned");

        // 2. The collateral must be returned, minus the issuer's payout.
        // This means the total collateral delta must be -payoutAmount.
        require(collateralGroup.delta == -payoutAmount, "Incorrect collateral payout");

        // 3. The payout must be sent to the issuer.
        // This is implicitly checked by the delta calculation. The sponsor's script
        // ensures the remaining collateral is returned to them, so the -payoutAmount delta
        // must have been sent to the issuer.
    }

    // Path 2: Issuer liquidates an under-collateralized position
    function liquidate(issuerSig: Sig, oracleSig: Sig, priceData: bytes) {
        require(checkSig(issuerSig, issuerPk));
        require(checkDataSig(oracleSig, sha256(priceData), oraclePk));

        // priceData is a 12-byte block: 4-byte timestamp + 8-byte price level
        bytes4 timestamp = priceData.slice(0, 4);
        bytes8 currentPriceLevel = priceData.slice(4, 12);

        // Verify the price is below the liquidation threshold and the oracle signature is fresh
        require(currentPriceLevel.toInt64() < liquidationPriceLevel, "Price not below liquidation level");
        require(timestamp.toUint32() >= this.creationTime(), "Oracle signature too old");

        // Find the synthetic asset group
        let synthGroup = tx.assetGroups.find(synthAsset);
        require(synthGroup != null, "Synthetic asset not found");

        // Verify the exact amount of synth is burned (delta = -synthAmount)
        require(synthGroup.delta == -synthAmount, "Incorrect synth amount burned");

        // The collateral is claimed by the issuer, so its delta is -collateralAmount.
        let collateralGroup = tx.assetGroups.find(collateralAsset);
        require(collateralGroup != null, "Collateral asset not found");
        require(collateralGroup.delta == -collateralAmount, "Incorrect collateral amount liquidated");
    }

    // Path 3: Cooperative re-issuance to a new covenant
    function reissue(sponsorSig: Sig, issuerSig: Sig) {
        require(checkSig(sponsorSig, sponsorPk));
        require(checkSig(issuerSig, issuerPk));

        // Find the synthetic asset group
        let synthGroup = tx.assetGroups.find(synthAsset);
        require(synthGroup != null, "Synthetic asset not found");

        // Verify the exact amount of synth is burned (delta = -synthAmount).
        // The collateral is spent into a new covenant, so its delta is 0.
        require(synthGroup.delta == -synthAmount, "Incorrect synth amount burned");

        let collateralGroup = tx.assetGroups.find(collateralAsset);
        require(collateralGroup != null, "Collateral asset not found");
        require(collateralGroup.delta == 0, "Collateral must be passed to a new covenant");
    }
}
```

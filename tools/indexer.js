// tools/indexer.js
// ArkAssetV1 indexer with JSON storage. Parses OP_RETURNs, verifies groups, and updates
// per-UTXO asset balances and asset definitions.
//
// Storage layout under state/:
// - assets.json: { "txid:gidx": { control: "txid:gidx", metadata: { "key": "value" } } }
// - utxos.json:  { "txid:vout": { "txid:gidx": "amount" } }  // amount as decimal string
// - transactions.json: { "txid": { txid, vin, vout, processed_at } }  // processed transactions
//
// Transaction JSON format expected by CLI:
// {
//   txid: "...",                                     // hex string (32 bytes hex)
//   vin:  [ { txid: "...", vout: 0 }, ... ],         // previous outpoints
//   vout: [ { n: 0, scriptPubKey: "6a..." }, ... ]    // outputs with script hex
// }
//
// Verification rules implemented (summary):
// - For each group, compute effective AssetId:
//     * If group.assetId present => use it.
//     * Else => fresh: (tx.txid, groupIndex) (genesis group).
// - Σin from referenced inputs must be available in the spent prev UTXOs for that AssetId.
// - Σout is declared in the group. Δ = Σout - Σin.
// - Δ > 0 rules:
//     * Fresh asset (no AssetId) => allowed; define control from group.control (resolved to BY_ID).
//     * Existing asset => require its controlling asset be present in same tx with Δ = 0 (retained).
//       Immediate controller only (hierarchical rule: A needs C retained; C needs S retained if C is reissued).
// - Δ = 0: transfer okay.
// - Δ < 0: burn allowed.
// - Spent prev UTXOs must have all asset balances fully consumed across groups (no leftovers on a spent input).
// - Outputs are credited accordingly.
//
// NOTE: This indexer trusts only the ArkAsset packet for asset movement but cross-checks with stored balances.
// It does not parse Bitcoin scripts beyond OP_RETURN detection; it assumes the rest of the tx structure is valid.

const fs = require('fs');
const path = require('path');
const codec = require('./arkass-codec.js');

// ---------------- Storage ----------------
class JsonStorage {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.state = { assets: {}, utxos: {}, transactions: {}, blockHeight: -1 };
  }

  _statePath(height) {
    return path.join(this.rootDir, `state_${height}.json`);
  }

  _getLatestHeight() {
    this.ensureDir();
    const files = fs.readdirSync(this.rootDir);
    const heights = files
      .map(f => f.match(/^state_(\d+)\.json$/))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10));
    return heights.length > 0 ? Math.max(...heights) : -1;
  }

  ensureDir() {
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true });
  }

  load(height) {
    const heightToLoad = height === undefined ? this._getLatestHeight() : height;
    if (heightToLoad === -1) {
      this.state = { assets: {}, utxos: {}, transactions: {}, blockHeight: -1 };
      return;
    }
    const statePath = this._statePath(heightToLoad);
    if (fs.existsSync(statePath)) {
      this.state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } else {
      throw new Error(`State file for height ${heightToLoad} not found.`);
    }
  }

  save(height) {
    this.ensureDir();
    if (height === undefined) throw new Error('Must provide height to save state.');
    this.state.blockHeight = height;
    fs.writeFileSync(this._statePath(height), JSON.stringify(this.state, null, 2));
  }

  delete(height) {
    const statePath = this._statePath(height);
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  }

  // Helpers
  static assetKey(txidHex, gidx) { return `${txidHex}:${gidx}`; }
  static utxoKey(txidHex, vout) { return `${txidHex}:${vout}`; }
}

// ---------------- Indexer ----------------
class Indexer {
  constructor({ stateDir = path.join(process.cwd(), 'state') } = {}) {
    this.store = new JsonStorage(stateDir);
    this.store.load(); // Loads the latest state
    this.pendingTeleports = new Map(); // Track teleports waiting for target confirmation
  }

  // Get current block height
  getHeight() {
    return this.store.state.blockHeight;
  }

  // Topologically sort transactions within a block based on their dependencies.
  _topologicallySortTransactions(transactions) {
    const txMap = new Map(transactions.map(tx => [tx.txid, tx]));
    const inDegree = new Map(transactions.map(tx => [tx.txid, 0]));
    const adj = new Map(transactions.map(tx => [tx.txid, []]));

    for (const tx of transactions) {
      for (const vin of tx.vin) {
        if (txMap.has(vin.txid)) { // It's an intra-block dependency
          adj.get(vin.txid).push(tx.txid);
          inDegree.set(tx.txid, inDegree.get(tx.txid) + 1);
        }
      }
    }

    const queue = transactions.filter(tx => inDegree.get(tx.txid) === 0);
    const sorted = [];

    while (queue.length > 0) {
      const currentTx = queue.shift();
      sorted.push(currentTx);

      for (const dependentTxid of adj.get(currentTx.txid)) {
        inDegree.set(dependentTxid, inDegree.get(dependentTxid) - 1);
        if (inDegree.get(dependentTxid) === 0) {
          queue.push(txMap.get(dependentTxid));
        }
      }
    }

    if (sorted.length !== transactions.length) {
      throw new Error('Transaction dependency cycle detected in block.');
    }

    return sorted;
  }

  // Apply a new block of transactions
  applyBlock({ height, transactions }) {
    if (height !== this.store.state.blockHeight + 1) {
      throw new Error(`Cannot apply block ${height}; current height is ${this.store.state.blockHeight}`);
    }

    // Topologically sort transactions to handle intra-block dependencies correctly.
    const sortedTxs = this._topologicallySortTransactions(transactions);

    // Work on a copy of the state; only commit on full success
    const tempState = JSON.parse(JSON.stringify(this.store.state));

    for (const tx of sortedTxs) {
      try {
        this._applyTransaction(tx, tempState);
      } catch (error) {
        // If any tx fails, the whole block is invalid. Discard changes.
        throw new Error(`Failed to apply transaction ${tx.txid} in block ${height}: ${error.message}`);
      }
    }

    // All transactions in the block were successful. Commit the new state.
    this.store.state = tempState;
    this.store.save(height);
    return { changed: true, newHeight: height };
  }

  // Rollback the last applied block
  rollbackLastBlock() {
    const currentHeight = this.store.state.blockHeight;
    if (currentHeight === -1) {
      console.warn('Cannot rollback; at genesis state.');
      return { changed: false };
    }

    this.store.delete(currentHeight);
    this.store.load(); // Reloads the latest state (which is now the previous one)
    return { changed: true, newHeight: this.store.state.blockHeight };
  }

  // Parse ArkAsset OP_RETURN from tx.vout[]; returns { groups, outputIndex } or null if none.
  parseArkassFromTx(tx) {
    for (const out of tx.vout || []) {
      const hex = (out.scriptPubKey || '').toLowerCase();
      if (!hex.startsWith('6a')) continue; // not OP_RETURN
      try {
        const buf = Buffer.from(hex, 'hex');
        const parsed = codec.parseOpReturnScript(buf);
        return { ...parsed, outputIndex: out.n };
      } catch (e) {
        // Not ArkAsset payload; continue
      }
    }
    return null;
  }

  // Internal method to apply a single transaction's effects to a given state object.
  _applyTransaction(tx, state) {
    // Store the transaction
    state.transactions[tx.txid] = {
      txid: tx.txid,
      vin: tx.vin,
      vout: tx.vout,
      processed_at: new Date().toISOString()
    };
    // 1) Parse ArkAsset packet
    const parsed = this.parseArkassFromTx(tx);
    if (!parsed) {
      // Implicit burn policy: if any spent inputs carry known asset balances and
      // there is no ArkAsset OP_RETURN in this transaction, all such balances
      // are considered burned. We remove them from state and do not credit any outputs.
      const burned = [];
      for (const prev of tx.vin || []) {
        const prevKey = JsonStorage.utxoKey(prev.txid, prev.vout);
        const prevAssets = state.utxos[prevKey];
        if (!prevAssets) continue;
        for (const [assetKey, amountStr] of Object.entries(prevAssets)) {
          burned.push({ prevout: prevKey, assetKey, amount: amountStr });
        }
        delete state.utxos[prevKey];
      }
      if (burned.length > 0) {
        return { changed: true, reason: 'implicit_burn', burned };
      }
      return { changed: false, reason: 'no_arkass' };
    }

    const { groups = [], updates = [] } = parsed;

    // 2) Compute effective AssetIds per group. This is needed to resolve BY_GROUP refs ahead of time.
    const eff = groups.map((g, gidx) => ({
      idx: gidx,
      assetId: g.assetId ? { txidHex: g.assetId.txidHex, gidx: g.assetId.gidx } : { txidHex: tx.txid, gidx },
      controlRef: g.control || null,
      inputs: g.inputs || [],
      outputs: g.outputs || [],
    }));

    // Generic resolver for AssetRefs (used by metadata updates and control definitions)
    const resolveAssetRef = (ref) => {
      if (!ref) return null;
      if (ref.kind === 'BY_ID') return ref.assetid;
      if (ref.kind === 'BY_GROUP') {
        const target = eff[ref.gidx];
        if (!target) throw new Error(`AssetRef BY_GROUP references missing group ${ref.gidx}`);
        return target.assetId;
      }
      throw new Error('unknown asset ref kind');
    };

    // Process Metadata Updates first
    for (const update of updates) {
      const resolvedAssetId = resolveAssetRef(update.assetRef);
      if (!resolvedAssetId) throw new Error('Metadata update contains an unresolvable AssetRef');

      const assetKey = JsonStorage.assetKey(resolvedAssetId.txidHex, resolvedAssetId.gidx);
      const def = state.assets[assetKey];
      if (!def) throw new Error(`Metadata update for unknown asset ${assetKey}`);
      if (!def.control) throw new Error(`Metadata update for uncontrolled asset ${assetKey}`);

      // Authorization: find who owns the control asset
      const controlAssetKey = def.control;
      let controlUtxoKey = null;
      for (const [utxo, assets] of Object.entries(state.utxos)) {
        if (assets[controlAssetKey]) { controlUtxoKey = utxo; break; }
      }
      if (!controlUtxoKey) throw new Error(`Control asset ${controlAssetKey} not found in any UTXO for asset ${assetKey}`);

      // Check if tx spends the control UTXO
      const [controlTxid, controlVoutStr] = controlUtxoKey.split(':');
      const controlVout = parseInt(controlVoutStr, 10);
      const spendsControl = tx.vin.some(i => i.txid === controlTxid && i.vout === controlVout);
      if (!spendsControl) throw new Error(`Tx does not spend required control UTXO ${controlUtxoKey} for asset ${assetKey}`);

      // Auth successful. Apply metadata update (replace, not merge).
      def.metadata = update.metadata;
    }

    // If only metadata updates happened, we can save and exit early.
    if (groups.length === 0) {
      if (updates.length > 0) {
        return { changed: true, reason: 'metadata_update' };
      }
      return { changed: false, reason: 'no_op' }; // Should not happen if parsed is not null
    }

    // 4) Compute Σin / Σout / Δ per group and track per-prevout consumption
    const groupSums = [];
    const prevoutConsumption = {}; // prevoutKey => { assetKey => amount }

    const getUtxoAssets = (txid, vout) => state.utxos[JsonStorage.utxoKey(txid, vout)] || {};

    for (const g of eff) {
      const assetKey = JsonStorage.assetKey(g.assetId.txidHex, g.assetId.gidx);
      let sumIn = 0n;
      for (const inp of g.inputs) {
        if (inp.type === 'LOCAL') {
          const prevAssets = getUtxoAssets(tx.vin[inp.i].txid, tx.vin[inp.i].vout);
          sumIn += BigInt(inp.amt);
          const prevKey = JsonStorage.utxoKey(tx.vin[inp.i].txid, tx.vin[inp.i].vout);
          if (!prevoutConsumption[prevKey]) prevoutConsumption[prevKey] = {};
          if (!prevoutConsumption[prevKey][assetKey]) prevoutConsumption[prevKey][assetKey] = 0n;
          prevoutConsumption[prevKey][assetKey] += BigInt(inp.amt);
        } else if (inp.type === 'TELEPORT') {
          // Verify this teleport input matches a pending teleport by commitment
          const pendingTeleport = this.pendingTeleports.get(inp.commitment);
          if (!pendingTeleport) {
            throw new Error(`TELEPORT input with commitment ${inp.commitment} not found in pending teleports`);
          }
          if (pendingTeleport.assetId.txidHex !== g.assetId.txidHex || 
              pendingTeleport.assetId.gidx !== g.assetId.gidx ||
              pendingTeleport.amount !== BigInt(inp.amt)) {
            throw new Error(`TELEPORT input commitment ${inp.commitment} asset mismatch`);
          }
          // Remove the consumed teleport
          this.pendingTeleports.delete(inp.commitment);
          sumIn += BigInt(inp.amt);
        }
      }
      let sumOut = 0n;
      for (const out of g.outputs) {
        // Handle both LOCAL and TELEPORT variants
        if (out.type === 'LOCAL') {
          sumOut += BigInt(out.amt);
        } else if (out.type === 'TELEPORT') {
          sumOut += BigInt(out.amt);
          // Store pending teleport by commitment
          if (this.pendingTeleports.has(out.commitment)) {
            throw new Error(`Duplicate teleport commitment ${out.commitment}`);
          }
          this.pendingTeleports.set(out.commitment, {
            assetId: g.assetId,
            amount: BigInt(out.amt),
            sourceTxid: tx.txid
          });
        }
      }
      const delta = sumOut - sumIn;
      groupSums.push({ assetKey, sumIn, sumOut, delta });
    }

    // 5) Verify issuance/reissuance control rules
    // Build a lookup by assetKey for this tx's group deltas
    const deltaByAsset = new Map(groupSums.map(x => [x.assetKey, x.delta]));

    const requireControlRetained = (controlledAssetKey) => {
      const def = state.assets[controlledAssetKey];
      if (!def || !def.control) throw new Error(`asset ${controlledAssetKey} has no stored control definition`);
      const controlAssetKey = def.control;
      const delta = deltaByAsset.get(controlAssetKey);
      if (delta === undefined) throw new Error(`control asset ${controlAssetKey} not present in tx`);
      if (delta !== 0n) throw new Error(`control asset ${controlAssetKey} must be retained (Δ=0), got Δ=${delta}`);
      return controlAssetKey;
    };

    groups.forEach((_, gidx) => {
      const { assetKey, delta } = groupSums[gidx];
      const hasStoredDef = !!state.assets[assetKey];
      const isFresh = !hasStoredDef && eff[gidx].assetId.txidHex === tx.txid; // genesis within this tx
      if (delta > 0n) {
        if (isFresh) {
          // Allowed; control will be defined by this group (may be null => uncontrolled asset)
        } else {
          // Reissuance: must retain controller
          requireControlRetained(assetKey);
        }
      }
    });

    // 6) Ensure spent inputs fully accounted per asset
    for (let vinIdx = 0; vinIdx < (tx.vin || []).length; vinIdx++) {
      const prev = tx.vin[vinIdx]; if (!prev) continue;
      const prevKey = JsonStorage.utxoKey(prev.txid, prev.vout);
      const prevAssets = state.utxos[prevKey];
      if (!prevAssets) continue; // input had no assets tracked
      for (const [assetKey, amountStr] of Object.entries(prevAssets)) {
        const want = BigInt(amountStr);
        const used = prevoutConsumption[prevKey] && prevoutConsumption[prevKey][assetKey] || 0n;
        if (used !== want) {
          throw new Error(`input ${prevKey} asset ${assetKey} must be fully consumed; used ${used}, have ${want}`);
        }
      }
    }

    // 7) Apply state changes
    // 7.1 Deduct from prev UTXOs
    for (const [prevKey, consumed] of Object.entries(prevoutConsumption)) {
      const prevAssets = state.utxos[prevKey];
      if (!prevAssets) continue;
      for (const [assetKey, amount] of Object.entries(consumed)) {
        const remain = BigInt(prevAssets[assetKey]) - amount;
        if (remain < 0n) throw new Error('negative remain invariant');
        if (remain === 0n) delete prevAssets[assetKey]; else prevAssets[assetKey] = remain.toString();
        if (Object.keys(prevAssets).length === 0) delete state.utxos[prevKey];
      }
    }

    // 7.2 Credit outputs
    for (const g of eff) {
      const assetKey = JsonStorage.assetKey(g.assetId.txidHex, g.assetId.gidx);
      for (const out of g.outputs) {
        // Only credit LOCAL outputs to UTXOs in this transaction
        if (out.type === 'LOCAL') {
          const outKey = JsonStorage.utxoKey(tx.txid, out.o);
          if (!state.utxos[outKey]) state.utxos[outKey] = {};
          if (!state.utxos[outKey][assetKey]) state.utxos[outKey][assetKey] = 0n;
          state.utxos[outKey][assetKey] += BigInt(out.amt);
        }
        // TELEPORT outputs are already handled in groupSums calculation
      }
    }

    // 7.3 Define fresh assets controls
    eff.forEach((g) => {
      const assetKey = JsonStorage.assetKey(g.assetId.txidHex, g.assetId.gidx);
      const hasDef = !!state.assets[assetKey];
      if (!hasDef && g.assetId.txidHex === tx.txid) {
        const resolvedControlId = resolveAssetRef(g.controlRef);
        const controlAssetKey = resolvedControlId ? JsonStorage.assetKey(resolvedControlId.txidHex, resolvedControlId.gidx) : null;
        const initialMetadata = groups[g.idx].metadata || {};
        state.assets[assetKey] = { control: controlAssetKey, metadata: initialMetadata };
      }
    });

    // Process incoming teleports to this transaction
    this._processIncomingTeleports(tx, state);

    return { changed: true };
  }

  // Process incoming teleports to this transaction
  _processIncomingTeleports(tx, state) {
    // This method is no longer needed with commitment-based teleports
    // Teleports are now handled directly in the packet processing
  }
}

module.exports = { Indexer, JsonStorage };

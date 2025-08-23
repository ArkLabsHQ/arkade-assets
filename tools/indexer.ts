// tools/indexer.ts
// ArkAssetV1 indexer with JSON storage.

import * as codec from './arkass-codec';
import { Packet, Group, AssetId, AssetRef, AssetInput, AssetOutput } from './arkass-codec';

// ----------------- TYPE DEFINITIONS -----------------

const MIN_TELEPORT_CONFIRMATIONS = 6;

interface TxVin {
  txid: string;
  vout: number;
}

interface TxVout {
  n: number;
  scriptPubKey: string;
}

interface Tx {
  txid: string;
  vin: TxVin[];
  vout: TxVout[];
}

interface AssetDefinition {
  control: string | null;
  metadata: { [key: string]: string };
}

interface AssetState { [assetKey: string]: AssetDefinition; }
interface UtxoContent { [assetKey: string]: string; }
interface UtxoState { [utxoKey: string]: UtxoContent; }
interface PendingTeleport {
  assetId: AssetId;
  amount: string;
  sourceTxid: string;
  sourceHeight?: number; // Undefined for arkade-native teleports
}

interface PendingTeleportsState { [commitment: string]: PendingTeleport; }

interface TransactionState { [txid: string]: Tx & { status: 'confirmed' | 'arkade', processed_at: string } }

export interface State {
  assets: AssetState;
  utxos: UtxoState;
  transactions: TransactionState;
  pendingTeleports: PendingTeleportsState;
  blockHeight: number;
}

interface EffectiveGroup {
  idx: number;
  assetId: AssetId;
  controlRef: AssetRef | null;
  inputs: AssetInput[];
  outputs: AssetOutput[];
}

// ---------------- Storage ----------------

export interface Storage {
  state: State;
  load(height?: number): void;
  save(height: number): void;
  delete(height: number): void;
  getRootDir(): string;
}


// ---------------- Indexer ----------------

export class Indexer {
  public store: Storage;

  constructor(storage: Storage) {
    this.store = storage;
    this.store.load();
    if (!this.store.state.pendingTeleports) {
      this.store.state.pendingTeleports = {};
    }
  }

  getHeight(): number {
    return this.store.state.blockHeight;
  }

  private _topologicallySortTransactions(transactions: Tx[]): Tx[] {
    const txMap = new Map(transactions.map(tx => [tx.txid, tx]));
    const inDegree = new Map(transactions.map(tx => [tx.txid, 0]));
    const adj = new Map(transactions.map(tx => [tx.txid, [] as string[]]));

    for (const tx of transactions) {
      for (const vin of tx.vin) {
        if (txMap.has(vin.txid)) {
          adj.get(vin.txid)!.push(tx.txid);
          inDegree.set(tx.txid, inDegree.get(tx.txid)! + 1);
        }
      }
    }

    const queue = transactions.filter(tx => inDegree.get(tx.txid) === 0);
    const sorted: Tx[] = [];

    while (queue.length > 0) {
      const currentTx = queue.shift()!;
      sorted.push(currentTx);

      for (const dependentTxid of adj.get(currentTx.txid)!) {
        inDegree.set(dependentTxid, inDegree.get(dependentTxid)! - 1);
        if (inDegree.get(dependentTxid) === 0) {
          queue.push(txMap.get(dependentTxid)!);
        }
      }
    }

    if (sorted.length !== transactions.length) {
      throw new Error('Transaction dependency cycle detected in block.');
    }
    return sorted;
  }

  applyBlock({ height, transactions }: { height: number; transactions: Tx[] }): { changed: boolean; newHeight: number } {
    if (height !== this.store.state.blockHeight + 1) {
      throw new Error(`Cannot apply block ${height}; current height is ${this.store.state.blockHeight}`);
    }

    // Mark mempool transactions as confirmed
    for (const tx of transactions) {
      if (this.store.state.transactions[tx.txid]) {
        this.store.state.transactions[tx.txid].status = 'confirmed';
      }
    }

    const sortedTxs = this._topologicallySortTransactions(transactions);
    const tempState: State = JSON.parse(JSON.stringify(this.store.state));

    for (const tx of sortedTxs) {
      try {
        this._applyTransaction(tx, tempState, height);
      } catch (error: any) {
        throw new Error(`Failed to apply transaction ${tx.txid} in block ${height}: ${error.message}`);
      }
    }

    this.store.state = tempState;
    this.store.save(height);
    return { changed: true, newHeight: height };
  }

  rollbackLastBlock(): { changed: boolean; newHeight?: number } {
    const currentHeight = this.store.state.blockHeight;
    if (currentHeight === -1) {
      console.warn('Cannot rollback; at genesis state.');
      return { changed: false };
    }

    // Preserve the current mempool transactions
    const currentMempoolTxs = Object.values(this.store.state.transactions)
      .filter(tx => tx.status === 'arkade');

    // Load the state of the block to be rolled back to identify its transactions
    const lastBlockState: State = JSON.parse(JSON.stringify(this.store.state));

    // Invalidate any teleports that were created in the rolled-back block
    for (const [commitment, teleport] of Object.entries(lastBlockState.pendingTeleports)) {
      if (!this.store.state.pendingTeleports[commitment]) {
        delete lastBlockState.pendingTeleports[commitment];
      }
    }

    // Load the previous state
    this.store.delete(currentHeight);
    this.store.load(); // Loads state for currentHeight - 1

    // Identify transactions that were confirmed in the rolled-back block
    const revertedBlockTxIds = new Set(
      Object.keys(lastBlockState.transactions).filter(txid => 
        !this.store.state.transactions[txid] || this.store.state.transactions[txid].status !== 'confirmed'
      )
    );

    // Add the reverted and preserved mempool transactions back into the state
    for (const tx of Object.values(lastBlockState.transactions)) {
      if (revertedBlockTxIds.has(tx.txid)) {
        this.store.state.transactions[tx.txid] = { ...tx, status: 'arkade' };
      }
    }
    for (const tx of currentMempoolTxs) {
        if (!this.store.state.transactions[tx.txid]) {
            this.store.state.transactions[tx.txid] = tx;
        }
    }

    this.store.save(this.store.state.blockHeight);

    return { changed: true, newHeight: this.store.state.blockHeight };
  }

  public getSpeculativeState(): State {
    const speculativeState = JSON.parse(JSON.stringify(this.store.state));
    const mempoolTxs = Object.values(this.store.state.transactions)
      .filter(tx => tx.status === 'arkade')
      .sort((a, b) => a.processed_at.localeCompare(b.processed_at));

    for (const tx of mempoolTxs) {
      this._applyTransaction(tx, speculativeState);
    }
    return speculativeState;
  }

  public applyToArkadeVirtualMempool(tx: Tx): { success: boolean; error?: string } {
    if (this.store.state.transactions[tx.txid]) {
      return { success: true }; // Already present, treat as success
    }

    const speculativeState = this.getSpeculativeState();
    try {
      this._applyTransaction(tx, speculativeState);
      this.store.state.transactions[tx.txid] = { ...tx, status: 'arkade', processed_at: new Date().toISOString() };
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  parseArkassFromTx(tx: Tx): (Packet & { outputIndex: number }) | null {
    for (const out of tx.vout || []) {
      const hex = (out.scriptPubKey || '').toLowerCase();
      if (!hex.startsWith('6a')) continue;
      try {
        const bytes = codec.hexToBytes(hex);
        const parsed = codec.parseOpReturnScript(bytes);
        return { ...parsed, outputIndex: out.n };
      } catch (e) { /* Not ArkAsset payload */ }
    }
    return null;
  }

  private _applyTransaction(tx: Tx, state: State, blockHeight?: number): { changed: boolean; reason?: string; burned?: any[] } {
    // Don't re-add to transactions if it's already there from the mempool
    if (!state.transactions[tx.txid]) {
        state.transactions[tx.txid] = { ...tx, status: 'confirmed', processed_at: new Date().toISOString() };
    }

    const parsed = this.parseArkassFromTx(tx);
    if (!parsed) {
      const burned = [];
      for (const prev of tx.vin || []) {
        const prevKey = Indexer.utxoKey(prev.txid, prev.vout);
        const prevAssets = state.utxos[prevKey];
        if (!prevAssets) continue;
        for (const [assetKey, amountStr] of Object.entries(prevAssets)) {
          burned.push({ prevout: prevKey, assetKey, amount: amountStr });
        }
        delete state.utxos[prevKey];
      }
      return burned.length > 0 ? { changed: true, reason: 'implicit_burn', burned } : { changed: false, reason: 'no_arkass' };
    }

    const { groups = [] } = parsed;
    if (groups.length === 0) {
      return { changed: false, reason: 'no_op' };
    }

    const eff: EffectiveGroup[] = groups.map((g, gidx) => ({
      idx: gidx,
      assetId: g.assetId ? { txidHex: g.assetId.txidHex, gidx: g.assetId.gidx } : { txidHex: tx.txid, gidx },
      controlRef: g.control || null,
      inputs: g.inputs || [],
      outputs: g.outputs || [],
    }));

    const resolveAssetRef = (ref: AssetRef | null): AssetId | null => {
      if (!ref) return null;
      if ('txidHex' in ref && ref.txidHex) return ref;
      const target = eff[ref.gidx];
      if (!target) throw new Error(`AssetRef BY_GROUP references missing group ${ref.gidx}`);
      return target.assetId;
    };

    const groupSums: { assetKey: string, sumIn: bigint, sumOut: bigint, delta: bigint }[] = [];
    const prevoutConsumption: { [prevoutKey: string]: { [assetKey: string]: bigint } } = {};

    const getUtxoAssets = (txid: string, vout: number) => state.utxos[Indexer.utxoKey(txid, vout)] || {};

    for (const g of eff) {
      const assetKey = Indexer.assetKey(g.assetId.txidHex, g.assetId.gidx);
      let sumIn = 0n;
      for (const inp of g.inputs) {
        if (inp.type === 'LOCAL') {
          sumIn += BigInt(inp.amt);
          const prevKey = Indexer.utxoKey(tx.vin[inp.i].txid, tx.vin[inp.i].vout);
          if (!prevoutConsumption[prevKey]) prevoutConsumption[prevKey] = {};
          if (!prevoutConsumption[prevKey][assetKey]) prevoutConsumption[prevKey][assetKey] = 0n;
          prevoutConsumption[prevKey][assetKey] += BigInt(inp.amt);
                } else if (inp.type === 'TELEPORT') {
          const pending = state.pendingTeleports[inp.commitment];
          if (!pending) throw new Error(`TELEPORT input commitment ${inp.commitment} not found`);

          // If a teleport originates from a confirmed block, it requires a confirmation delay.
          if (pending.sourceHeight !== undefined) {
            const currentHeight = blockHeight ?? state.blockHeight;
            const confirmations = currentHeight - pending.sourceHeight;
            if (confirmations < MIN_TELEPORT_CONFIRMATIONS) {
              throw new Error(`TELEPORT input ${inp.commitment} does not have enough confirmations: ${confirmations}/${MIN_TELEPORT_CONFIRMATIONS}`);
            }
          }

          if (pending.assetId.txidHex !== g.assetId.txidHex || pending.assetId.gidx !== g.assetId.gidx || BigInt(pending.amount) !== BigInt(inp.amt)) {
            throw new Error(`TELEPORT input ${inp.commitment} mismatch`);
          }
          delete state.pendingTeleports[inp.commitment];
          sumIn += BigInt(inp.amt);
        }
      }
      let sumOut = 0n;
      for (const out of g.outputs) {
        sumOut += BigInt(out.amt);
        if (out.type === 'TELEPORT') {
          if (state.pendingTeleports[out.commitment]) {
            // If it's an unconfirmed teleport being confirmed, update its sourceHeight.
            if (blockHeight !== undefined && state.pendingTeleports[out.commitment].sourceHeight === undefined) {
              state.pendingTeleports[out.commitment].sourceHeight = blockHeight;
            } else {
              throw new Error(`Duplicate teleport commitment ${out.commitment}`);
            }
          } else {
            // Add new teleport to pending list.
            state.pendingTeleports[out.commitment] = { assetId: g.assetId, amount: BigInt(out.amt).toString(), sourceTxid: tx.txid, sourceHeight: blockHeight };
          }
        }
      }
      groupSums.push({ assetKey, sumIn, sumOut, delta: sumOut - sumIn });
    }

    const deltaByAsset = new Map(groupSums.map(x => [x.assetKey, x.delta]));
    const requireControlRetained = (controlledAssetKey: string) => {
      const def = state.assets[controlledAssetKey];
      if (!def || !def.control) throw new Error(`Asset ${controlledAssetKey} has no control definition`);
      const delta = deltaByAsset.get(def.control);
      if (delta === undefined) throw new Error(`Control asset ${def.control} not present in tx`);
      if (delta !== 0n) throw new Error(`Control asset ${def.control} must be retained (Δ=0), got Δ=${delta}`);
    };

    groups.forEach((_, gidx) => {
      const { assetKey, delta } = groupSums[gidx];
      const isFresh = !state.assets[assetKey] && eff[gidx].assetId.txidHex === tx.txid;
      if (delta > 0n && !isFresh) requireControlRetained(assetKey);
    });

    for (const vin of tx.vin || []) {
      const prevKey = Indexer.utxoKey(vin.txid, vin.vout);
      const prevAssets = state.utxos[prevKey];
      if (!prevAssets) continue;
      for (const [assetKey, amountStr] of Object.entries(prevAssets)) {
        const want = BigInt(amountStr);
        const used = prevoutConsumption[prevKey]?.[assetKey] || 0n;
        if (used !== want) throw new Error(`Input ${prevKey} asset ${assetKey} must be fully consumed; used ${used}, have ${want}`);
      }
    }

    for (const [prevKey, consumed] of Object.entries(prevoutConsumption)) {
      const prevAssets = state.utxos[prevKey];
      if (!prevAssets) continue;
      for (const [assetKey, amount] of Object.entries(consumed)) {
        const remain = BigInt(prevAssets[assetKey]) - amount;
        if (remain < 0n) throw new Error('Negative remain invariant');
        if (remain === 0n) delete prevAssets[assetKey]; else prevAssets[assetKey] = remain.toString();
      }
      if (Object.keys(prevAssets).length === 0) delete state.utxos[prevKey];
    }

    for (const g of eff) {
      const assetKey = Indexer.assetKey(g.assetId.txidHex, g.assetId.gidx);
      for (const out of g.outputs) {
        if (out.type === 'LOCAL') {
          const outKey = Indexer.utxoKey(tx.txid, out.o);
          if (!state.utxos[outKey]) state.utxos[outKey] = {};
          const currentAmt = BigInt(state.utxos[outKey][assetKey] || 0n);
          state.utxos[outKey][assetKey] = (currentAmt + BigInt(out.amt)).toString();
        }
      }
    }

    eff.forEach((g) => {
      const assetKey = Indexer.assetKey(g.assetId.txidHex, g.assetId.gidx);
      const groupData = groups[g.idx];
      if (!state.assets[assetKey] && g.assetId.txidHex === tx.txid) { // Genesis
        const resolved = resolveAssetRef(g.controlRef);
        const controlKey = resolved ? Indexer.assetKey(resolved.txidHex, resolved.gidx) : null;
        state.assets[assetKey] = { control: controlKey, metadata: groupData.metadata || {} };
      } else if (state.assets[assetKey] && groupData.metadata) { // Metadata Update
        const def = state.assets[assetKey];
        if (!def.control) throw new Error(`Metadata update for uncontrolled asset ${assetKey}`);
        const controlUtxoKey = Object.keys(state.utxos).find(k => state.utxos[k][def.control!]);
        if (!controlUtxoKey) throw new Error(`Control asset ${def.control} not found for ${assetKey}`);
        const [controlTxid, controlVoutStr] = controlUtxoKey.split(':');
        if (!tx.vin.some(i => i.txid === controlTxid && i.vout === parseInt(controlVoutStr))) {
          throw new Error(`Tx does not spend control UTXO ${controlUtxoKey} for ${assetKey}`);
        }
        def.metadata = groupData.metadata;
      }
    });

    return { changed: true };
  }

  static assetKey(txidHex: string, gidx: number): string { return `${txidHex}:${gidx}`; }
  static utxoKey(txidHex: string, vout: number): string { return `${txidHex}:${vout}`; }
}

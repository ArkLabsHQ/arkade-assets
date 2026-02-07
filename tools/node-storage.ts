import * as fs from 'fs';
import * as path from 'path';
import { State, Storage } from './indexer';

export class NodeFileStorage implements Storage {
  public state: State;
  private _rootDir: string;

  public getRootDir(): string {
    return this._rootDir;
  }

  constructor(rootDir: string) {
    this._rootDir = rootDir;
    this.state = { assets: {}, utxos: {}, transactions: {}, blockHeight: -1 };
  }

  private _statePath(height: number): string {
    return path.join(this._rootDir, `state_${height}.json`);
  }

  private _getLatestHeight(): number {
    this.ensureDir();
    const files = fs.readdirSync(this._rootDir);
    const heights = files
      .map(f => f.match(/^state_(\d+)\.json$/))
      .filter(Boolean)
      .map(m => parseInt((m as RegExpMatchArray)[1], 10));
    return heights.length > 0 ? Math.max(...heights) : -1;
  }

  ensureDir(): void {
    if (!fs.existsSync(this._rootDir)) fs.mkdirSync(this._rootDir, { recursive: true });
  }

  load(height?: number): void {
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

  save(height: number): void {
    this.ensureDir();
    if (height === undefined) throw new Error('Must provide height to save state.');
    this.state.blockHeight = height;
    fs.writeFileSync(this._statePath(height), JSON.stringify(this.state, null, 2));
  }

  delete(height: number): void {
    const statePath = this._statePath(height);
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  }
}

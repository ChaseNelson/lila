import { Work, CevalEngine, CevalState, BrowserEngineInfo } from '../types';
import { Protocol } from '../protocol';
import { objectStorage } from 'common/objectStorage';
import { sharedWasmMemory } from '../util';
import { LegacyBot } from './legacyBot';
import type StockfishWeb from 'lila-stockfish-web';

export class StockfishWebEngine extends LegacyBot implements CevalEngine {
  failed: Error;
  protocol: Protocol;
  sfweb?: StockfishWeb;
  loaded = () => {};
  isLoaded = new Promise<void>(resolve => {
    this.loaded = resolve;
  });

  constructor(
    readonly info: BrowserEngineInfo,
    readonly progress?: (download?: { bytes: number; total: number }, error?: string) => void,
    readonly variantMap?: (v: string) => string,
  ) {
    super(info);
    this.protocol = new Protocol(variantMap);
    this.boot().catch(e => {
      console.error(e);
      this.failed = e;
      progress?.(undefined, e.message);
    });
  }
  get module() {
    return {
      postMessage: (x: string) => this.sfweb?.postMessage(x),
      listen: (x: (y: string) => void) => {
        if (this.sfweb) this.sfweb.listen = x;
      },
    };
  }
  load(): Promise<void> {
    return this.isLoaded;
  }

  getInfo() {
    return this.info;
  }

  async boot() {
    const [version, root, js] = [this.info.assets.version, this.info.assets.root, this.info.assets.js];
    const makeModule = await import(lichess.assetUrl(`${root}/${js}`, { version }));

    const module: StockfishWeb = await new Promise((resolve, reject) => {
      makeModule
        .default({
          wasmMemory: sharedWasmMemory(this.info.minMem!),
          onError: (msg: string) => reject(new Error(msg)),
          locateFile: (name: string) =>
            lichess.assetUrl(`${root}/${name}`, { version, sameDomain: name.endsWith('.worker.js') }),
        })
        .then(resolve)
        .catch(reject);
    });
    if (!this.info.id.endsWith('hce')) {
      const nnueStore = await objectStorage<Uint8Array>({ store: 'nnue' }).catch(() => undefined);
      const nnueFilename = module.getRecommendedNnue();

      module.onError = (msg: string) => {
        if (msg.startsWith('BAD_NNUE')) {
          // stockfish doesn't like our nnue file, let's remove it from IDB.
          // this will happen before nnueStore.put completes so let that finish before deletion.
          // otherwise, the resulting object store will best be described as undefined
          setTimeout(() => {
            console.warn(`Corrupt NNUE file, removing ${nnueFilename} from IDB`);
            nnueStore?.remove(nnueFilename);
          }, 2000);
        } else {
          console.error(msg);
          this.progress?.(undefined, msg);
        }
      };
      let nnueBuffer = await nnueStore?.get(nnueFilename).catch(() => undefined);

      if (!nnueBuffer || nnueBuffer.byteLength < 128 * 1024) {
        const req = new XMLHttpRequest();

        req.open('get', lichess.assetUrl(`lifat/nnue/${nnueFilename}`, { noVersion: true }), true);
        req.responseType = 'arraybuffer';
        req.onprogress = e => this.progress?.({ bytes: e.loaded, total: e.total });

        nnueBuffer = await new Promise((resolve, reject) => {
          req.onerror = () => reject(new Error(`NNUE download failed: ${req.status}`));
          req.onload = () => {
            if (req.status / 100 === 2) resolve(new Uint8Array(req.response));
            else reject(new Error(`NNUE download failed: ${req.status}`));
          };
          req.send();
        });
        this.progress?.();
        nnueStore?.put(nnueFilename, nnueBuffer!).catch(() => console.warn('IDB store failed'));
      }
      module.setNnueBuffer(nnueBuffer!);
    }
    module.listen = (data: string) => this.protocol.received(data);
    this.protocol.connected(cmd => module.postMessage(cmd));
    this.sfweb = module;
    this.loaded();
  }

  getState() {
    return this.failed
      ? CevalState.Failed
      : !this.module
        ? CevalState.Loading
        : this.protocol.isComputing()
          ? CevalState.Computing
          : CevalState.Idle;
  }

  start = (work?: Work) => this.protocol.compute(work);
  stop = () => this.protocol.compute(undefined);
  engineName = () => this.protocol.engineName;
  destroy = () => {
    this.module?.postMessage('quit');
    this.sfweb = undefined;
  };
}

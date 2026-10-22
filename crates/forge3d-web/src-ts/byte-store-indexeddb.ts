import {Forge3DError} from "./runtime-failure.js";
import type {PersistentByteStore} from "./byte-cache.js";
interface IdbRequestLike<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface IdbStoreLike {
  get(key: string): IdbRequestLike<unknown>;
  put(value: unknown, key: string): IdbRequestLike<unknown>;
  delete(key: string): IdbRequestLike<unknown>;
  clear(): IdbRequestLike<unknown>;
}

interface IdbTransactionLike {
  oncomplete:(()=>void)|null;
  onabort:(()=>void)|null;
  onerror:(()=>void)|null;
  error:unknown;
  abort():void;
  objectStore(name: string): IdbStoreLike;
}

interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): IdbStoreLike;
  transaction(name: string, mode: string): IdbTransactionLike;
  close(): void;
}

interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: ((event: unknown) => void) | null;
}

interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

function indexedDbFactory(): IdbFactoryLike | undefined {
  const candidate = (
    globalThis as typeof globalThis & { indexedDB?: IdbFactoryLike }
  ).indexedDB;
  if (candidate !== undefined && typeof candidate.open === "function") {
    return candidate;
  }
  return undefined;
}

function idbRequest<T>(request: IdbRequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

const IDB_STORE_NAME = "entries";

export function indexedDbByteStore(namespace: string): PersistentByteStore {
  // Each operation closes its own connection. Failed opens are never memoized.
  const database = async () => {
    const factory=indexedDbFactory();
    if(!factory)throw new Forge3DError("UNSUPPORTED_FEATURE","IndexedDB is unavailable");
    const request=factory.open(namespace,1);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(IDB_STORE_NAME))db.createObjectStore(IDB_STORE_NAME);};
    return idbRequest(request);
  };
  const operation=async(mode:"readonly"|"readwrite",run:(store:IdbStoreLike)=>IdbRequestLike<unknown>)=>{
    const db=await database();
    try {
      const tx=db.transaction(IDB_STORE_NAME,mode);
      return await new Promise<unknown>((resolve,reject)=>{
        let result:unknown,requestError:unknown;
        const clear=()=>{tx.oncomplete=null;tx.onabort=null;tx.onerror=null;};
        tx.oncomplete=()=>{clear();resolve(result);};
        tx.onabort=()=>{clear();reject(requestError??tx.error??new Error("IndexedDB transaction aborted"));};
        // Request errors normally abort the transaction. Settle only on terminal events.
        tx.onerror=()=>{requestError??=tx.error;};
        try {
          const request=run(tx.objectStore(IDB_STORE_NAME));
          request.onsuccess=()=>{result=request.result;};
          request.onerror=()=>{requestError=request.error;};
        }catch(error){requestError=error;try{tx.abort();}catch{clear();reject(error);}}
      });
    }finally{db.close();}
  };
  return {
    async get(key) {
      const value = await operation("readonly",store=>store.get(key));
      if (value instanceof Uint8Array) {
        return value;
      }
      if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
      }
      return undefined;
    },
    async put(key, value) {
      await operation("readwrite",store=>store.put(value, key));
    },
    async delete(key) {
      await operation("readwrite",store=>store.delete(key));
    },
    async clear() {
      await operation("readwrite",store=>store.clear());
    },
  };
}

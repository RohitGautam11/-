/**
 * Keeps the (non-extractable) identity key in IndexedDB so the app reopens without the password.
 * The CryptoKey object is stored as-is; its raw bytes can never be read back out by scripts.
 */
const DB = "vartalap-keys";
const STORE = "identity";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function saveIdentity(userId: string, key: CryptoKey) {
  await run("readwrite", (s) => s.put(key, userId));
}

export async function loadIdentity(userId: string): Promise<CryptoKey | null> {
  try {
    return (await run<CryptoKey | undefined>("readonly", (s) => s.get(userId))) ?? null;
  } catch {
    return null;
  }
}

export async function clearIdentities() {
  try {
    await run("readwrite", (s) => s.clear());
  } catch {
    // nothing stored
  }
}

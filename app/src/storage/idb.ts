/** Minimal promise wrapper around IndexedDB. Values here are already encrypted. */

export const DB_NAME = 'veil';
const DB_VERSION = 1;
export type StoreName = 'meta' | 'kv' | 'msgs' | 'chunks';
const STORES: StoreName[] = ['meta', 'kv', 'msgs', 'chunks'];

let dbp: Promise<IDBDatabase> | undefined;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('database blocked by another tab'));
  });
  return dbp;
}

async function tx(store: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(store, mode).objectStore(store);
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  return req((await tx(store, 'readonly')).get(key)) as Promise<T | undefined>;
}

export async function put(store: StoreName, key: string, value: unknown): Promise<void> {
  await req((await tx(store, 'readwrite')).put(value, key));
}

export async function del(store: StoreName, key: string | IDBKeyRange): Promise<void> {
  await req((await tx(store, 'readwrite')).delete(key));
}

/** Range covering every key that starts with `prefix`. */
export const prefixRange = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, prefix + '￿');

export async function entries<T>(store: StoreName, prefix: string): Promise<[string, T][]> {
  const s = await tx(store, 'readonly');
  const range = prefixRange(prefix);
  const [keys, values] = await Promise.all([req(s.getAllKeys(range)), req(s.getAll(range))]);
  return keys.map((k, i) => [String(k), values[i] as T]);
}

/**
 * Newest-first page of entries under `prefix`, strictly below `before` (exclusive).
 * Returns them in ascending key order.
 */
export async function pageBefore<T>(store: StoreName, prefix: string, before: string | undefined, limit: number): Promise<[string, T][]> {
  const s = await tx(store, 'readonly');
  const range = IDBKeyRange.bound(prefix, before ?? prefix + '\uffff', false, before !== undefined);
  return new Promise((resolve, reject) => {
    const out: [string, T][] = [];
    const r = s.openCursor(range, 'prev');
    r.onsuccess = () => {
      const c = r.result;
      if (!c || out.length >= limit) return resolve(out.reverse());
      out.push([String(c.key), c.value as T]);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}

export async function wipeDatabase(): Promise<void> {
  const db = await dbp?.catch(() => undefined);
  db?.close();
  dbp = undefined;
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

import { openDB } from "idb";

let connection: ReturnType<typeof openDB> | undefined;
const database = () => connection ??= openDB("tiphys-browser-v1", 1, { upgrade(db) { db.createObjectStore("records"); } });
export async function readRecord<T>(key: string): Promise<T | undefined> { return (await database()).get("records", key); }
export async function writeRecord(key: string, value: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const db = await database();
  const tx = db.transaction("records", "readwrite");
  const abort = () => { try { tx.abort(); } catch { /* Commit already completed. */ } };
  signal?.addEventListener("abort", abort, { once: true });
  try { await tx.store.put(value, key); await tx.done; }
  finally { signal?.removeEventListener("abort", abort); }
}
export async function deleteRecord(key: string) { return (await database()).delete("records", key); }
export async function records<T>(prefix: string): Promise<T[]> {
  const db = await database();
  return db.getAll("records", IDBKeyRange.bound(prefix, `${prefix}\uffff`));
}

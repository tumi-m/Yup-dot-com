"use client";

/**
 * On-device storage (IndexedDB) for the no-account journey.
 *
 * - `docs`: documents a guest opened in the editor. Work survives a reload,
 *   the way PDFescape keeps an anonymous session, without any upload.
 * - `handoff`: files passed between pages — the homepage dropzone into a tool,
 *   or one tool's result into the next — so the user never re-uploads.
 */

const DB_NAME = "pdf-wizard";
const DB_VERSION = 1;

export interface LocalDoc {
  id: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
  updatedAt: number;
}

export interface HandoffFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("handoff")) db.createObjectStore("handoff");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  store: "docs" | "handoff",
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => {
      resolve(req.result as T);
      db.close();
    };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const STORE_FAILED =
  "Couldn't store the document on this device. Free up some space or allow site storage, then try again.";

/**
 * Keeps a document on this device. When the browser won't (site data blocked:
 * "The operation is insecure.", or storage full), it throws STORE_FAILED
 * rather than the browser's own words.
 */
export async function saveLocalDoc(doc: LocalDoc): Promise<IDBValidKey> {
  try {
    return await tx<IDBValidKey>("docs", "readwrite", (s) => s.put(doc));
  } catch {
    throw new Error(STORE_FAILED);
  }
}
export const getLocalDoc = (id: string) => tx<LocalDoc | undefined>("docs", "readonly", (s) => s.get(id));
export const deleteLocalDoc = (id: string) => tx<undefined>("docs", "readwrite", (s) => s.delete(id));
export async function listLocalDocs(): Promise<LocalDoc[]> {
  const all = await tx<LocalDoc[]>("docs", "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function setHandoff(files: HandoffFile[]) {
  await tx("handoff", "readwrite", (s) => s.put(files, "pending"));
}

/**
 * Stores files for the next page. Resolves false instead of throwing when the
 * browser won't keep them (site data blocked, or storage full), so the caller
 * can say so and stay where it is.
 */
export async function tryHandoff(files: (HandoffFile | Promise<HandoffFile>)[]): Promise<boolean> {
  try {
    await setHandoff(await Promise.all(files));
    return true;
  } catch {
    return false;
  }
}

/** Reads and clears the pending handoff, so a refresh doesn't re-apply it. */
export async function takeHandoff(): Promise<HandoffFile[]> {
  const files = await tx<HandoffFile[] | undefined>("handoff", "readonly", (s) => s.get("pending"));
  await tx("handoff", "readwrite", (s) => s.delete("pending"));
  return files ?? [];
}

export async function fileToHandoff(file: File | Blob, name?: string): Promise<HandoffFile> {
  return {
    name: name ?? (file instanceof File ? file.name : "document.pdf"),
    type: file.type || "application/pdf",
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

export function handoffToFile(h: HandoffFile): File {
  return new File([h.bytes.slice() as unknown as BlobPart], h.name, { type: h.type });
}

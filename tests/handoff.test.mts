// Passing files to the next page must report a storage failure, never throw:
// the homepage and the Next chips stay usable and say what happened.
import { fileToHandoff, tryHandoff, type HandoffFile } from "../lib/local-store.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const g = globalThis as { indexedDB?: unknown };
let unhandled = 0;
process.on("unhandledRejection", () => unhandled++);

/** Just enough of IndexedDB for one put; `put` decides how the write goes. */
function fakeIndexedDB(put: (value: unknown) => void) {
  return {
    open() {
      const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = {};
      const db = {
        objectStoreNames: { contains: () => true },
        close() {},
        transaction() {
          const t: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error: unknown; objectStore: () => unknown } = {
            error: null,
            objectStore: () => ({
              put(value: unknown) {
                put(value);
                setTimeout(() => t.oncomplete?.(), 0);
                return { result: "pending" };
              },
            }),
          };
          return t;
        },
      };
      req.result = db;
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    },
  };
}

const pdf = new File(["%PDF-1.7\n"], "a.pdf", { type: "application/pdf" });

// Stored: true, with the files as given.
let stored: HandoffFile[] | null = null;
g.indexedDB = fakeIndexedDB((v) => (stored = v as HandoffFile[]));
check("stored: true", (await tryHandoff([fileToHandoff(pdf)])) === true);
check("stored: the file arrives", stored !== null && (stored as HandoffFile[])[0]?.name === "a.pdf", stored);

// Storage full: put throws.
g.indexedDB = fakeIndexedDB(() => {
  throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
});
check("storage full: false, no throw", (await tryHandoff([fileToHandoff(pdf)])) === false);

// Site data blocked: opening the database throws.
g.indexedDB = {
  open() {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
};
check("site data blocked: false, no throw", (await tryHandoff([fileToHandoff(pdf)])) === false);

// No IndexedDB at all.
delete g.indexedDB;
check("no IndexedDB: false, no throw", (await tryHandoff([fileToHandoff(pdf)])) === false);

// The file itself can't be read.
g.indexedDB = fakeIndexedDB(() => {});
const unreadable = { name: "x.pdf", type: "application/pdf", arrayBuffer: () => Promise.reject(new Error("NotReadableError")) } as unknown as File;
check("unreadable file: false, no throw", (await tryHandoff([fileToHandoff(unreadable), fileToHandoff(pdf)])) === false);

await new Promise((r) => setTimeout(r, 20));
check("no unhandled rejections", unhandled === 0, unhandled);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);

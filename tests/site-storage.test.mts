// Edit PDF with site data blocked (Firefox "block cookies", Chrome "don't
// allow sites to save data") or a full disk: picking a PDF showed the
// browser's own words, "The operation is insecure.", and nothing opened.
import { readFileSync } from "node:fs";
import { saveLocalDoc, tryHandoff, STORE_FAILED } from "../lib/local-store.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};
const doc = { id: "d1", name: "a.pdf", bytes: new Uint8Array([1, 2, 3]), pageCount: 1, updatedAt: 0 };
const g = globalThis as Record<string, unknown>;

// Firefox with site data blocked: indexedDB.open throws at once.
g.indexedDB = {
  open() {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
};
let message = await failure(() => saveLocalDoc(doc));
check("site data blocked: says to allow site storage", message === STORE_FAILED, message);
check("the handoff between tools still just says no", (await tryHandoff([{ name: "a.pdf", type: "application/pdf", bytes: doc.bytes }])) === false);

// Storage full: the database opens, the write is refused.
const later = (fn: () => void) => setTimeout(fn, 0);
g.indexedDB = {
  open() {
    const req: Record<string, unknown> = {};
    later(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        close() {},
        transaction() {
          const t: Record<string, unknown> = {
            objectStore: () => ({ put: () => ({}) }),
          };
          later(() => {
            t.error = new DOMException("The quota has been exceeded.", "QuotaExceededError");
            (t.onabort as () => void)();
          });
          return t;
        },
      };
      (req.onsuccess as () => void)();
    });
    return req;
  },
};
message = await failure(() => saveLocalDoc(doc));
check("storage full: the same plain message", message === STORE_FAILED, message);

// Picking a PDF and "Blank page" say the same thing.
const launch = readFileSync(new URL("../components/tools/EditorLaunch.tsx", import.meta.url), "utf8");
check("Blank page uses the same message", /: STORE_FAILED\)/.test(launch) && !/Couldn't store the document/.test(launch));
check("Choose PDF shows the error's own message", /err instanceof Error \? err\.message/.test(launch));

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);

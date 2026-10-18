/**
 * Back (a popstate) in the PDF and PPTX editors asks before unsaved edits
 * are thrown away, using a small stand-in for the window and its history.
 */
import { guardUnsaved, LEAVE_PROMPT } from "../lib/editor/unsaved-guard.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

type Listener = (e: unknown) => void;

/** A window with one document's history: back and forward fire popstate later, like a browser. */
function fakeWindow(urls: string[]) {
  const entries = urls.map((url) => ({ url, state: null as unknown }));
  let index = entries.length - 1;
  const listeners = new Map<string, Set<Listener>>();
  const answers: boolean[] = [];
  const asked: string[] = [];
  const fire = (type: string, e: unknown = {}) => [...(listeners.get(type) ?? [])].forEach((fn) => fn(e));
  const go = (delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= entries.length) return;
    setTimeout(() => {
      index = to;
      fire("popstate");
    }, 0);
  };
  const url = () => new URL(entries[index].url, "https://example.test");
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state: unknown, _unused: string, to?: string) {
      entries.splice(index + 1);
      entries.push({ url: to ?? entries[index].url, state });
      index++;
    },
    back: () => go(-1),
    forward: () => go(1),
  };
  const location = {
    get pathname() { return url().pathname; },
    get search() { return url().search; },
    get href() { return url().href; },
    get origin() { return url().origin; },
  };
  const win = {
    history,
    location,
    confirm(message: string) {
      asked.push(message);
      return answers.shift() ?? false;
    },
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
  };
  return {
    win: win as unknown as Window,
    history,
    asked,
    answers,
    at: () => entries[index].url,
    count: (type: string) => listeners.get(type)?.size ?? 0,
    /** Lets queued back/forward steps (and the ones they start) finish. */
    settle: async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); },
  };
}

// Nothing to lose: no extra entry, and Back leaves without asking.
{
  const w = fakeWindow(["/tools/edit-pdf", "/edit/1"]);
  const g = guardUnsaved(w.win, () => false);
  check("clean: no extra history entry", w.history.length === 2);
  check("clean: nothing listens for a tab close", w.count("beforeunload") === 0);
  w.history.back();
  await w.settle();
  check("clean: Back leaves without asking", w.at() === "/tools/edit-pdf" && w.asked.length === 0, { at: w.at(), asked: w.asked });
  g.stop();
}

// Unsaved edits: Back asks; No stays, Yes leaves.
{
  const w = fakeWindow(["/tools/edit-pdf", "/edit/1"]);
  let dirty = false;
  const g = guardUnsaved(w.win, () => dirty);
  dirty = true;
  g.sync();
  check("dirty: one extra entry for the same page", w.history.length === 3 && w.at() === "/edit/1");
  check("dirty: a tab close asks too", w.count("beforeunload") === 1);
  g.sync();
  dirty = false;
  g.sync();
  dirty = true;
  g.sync();
  check("dirty again: still only one extra entry", w.history.length === 3, w.history.length);

  w.answers.push(false);
  w.history.back();
  await w.settle();
  check("Back + No: asked once with the leave prompt", w.asked.length === 1 && w.asked[0] === LEAVE_PROMPT, w.asked);
  check("Back + No: still on the page, back on the extra entry", w.at() === "/edit/1" && w.history.state !== null, w.at());
  check("Back + No: no entry added", w.history.length === 3, w.history.length);

  w.answers.push(false);
  w.history.back();
  await w.settle();
  check("second Back + No: asks again and stays", w.asked.length === 2 && w.at() === "/edit/1" && w.history.state !== null);

  w.answers.push(true);
  w.history.back();
  await w.settle();
  check("Back + Yes: leaves to the page before", w.at() === "/tools/edit-pdf" && w.asked.length === 3, { at: w.at(), asked: w.asked.length });
  check("Back + Yes: a tab close there doesn't ask again", w.count("beforeunload") === 0);
  g.stop();
  check("stop: no listeners left", w.count("popstate") + w.count("click") + w.count("beforeunload") === 0);
}

// Saved after editing: the extra entry is still there, but one Back still leaves.
{
  const w = fakeWindow(["/tools", "/tools/edit-pptx"]);
  let dirty = true;
  const g = guardUnsaved(w.win, () => dirty);
  dirty = false;
  g.sync();
  check("saved: the extra entry stays, nothing asks on a tab close", w.history.length === 3 && w.count("beforeunload") === 0);
  w.history.back();
  await w.settle();
  check("saved: one Back leaves, no prompt", w.at() === "/tools" && w.asked.length === 0, { at: w.at(), asked: w.asked });
  g.stop();
}

// Opened again on the extra entry (Back from a later page): one Back still leaves.
{
  const w = fakeWindow(["/tools/edit-pdf", "/edit/1"]);
  const first = guardUnsaved(w.win, () => true);
  first.stop(); // a link took the user on, then they came back here
  const g = guardUnsaved(w.win, () => false);
  w.history.back();
  await w.settle();
  check("reopened on the extra entry: one Back leaves", w.at() === "/tools/edit-pdf" && w.asked.length === 0, { at: w.at() });
  g.stop();
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);

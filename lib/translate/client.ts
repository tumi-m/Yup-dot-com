/**
 * Sends a document's passages to /api/ai/translate from the page, a request
 * at a time and two at once, and gathers the translations by id. Cancel
 * aborts the requests themselves, and the route then stops the model. When
 * the minute's requests are used up it waits and tries again; a request
 * that fails part way is tried once more for what didn't come back; any
 * other refusal (the day's allowance, a busy service) stops the whole run.
 * Translations are gathered into the caller's map when it gives one, so
 * after Cancel or a failure the next run sends only what is still missing.
 * Plain code: tests hand it their own fetch.
 */
import { abortError, isAbort } from "../abort";
import { PARALLEL_BATCHES, type TranslateEvent } from "./format";
import { batchSegments } from "./segments";

export class TranslateError extends Error {
  constructor(
    message: string,
    /** The route's reason: "translate" (allowance used), "burst", "busy"; "failed" when the service failed part way. */
    readonly reason?: string,
    /** An upgrade raises the limit that was reached. */
    readonly upgrade = false,
    readonly status?: number
  ) {
    super(message);
    this.name = "TranslateError";
  }
}

export const CONNECTION_LOST = "The connection to the translation service was lost. Check your connection and try again.";

export interface TranslateOptions {
  /** Language code to translate into. */
  target: string;
  /** Language code of the document, or "auto". */
  source?: string;
  signal?: AbortSignal;
  /** Passages translated so far, of all. */
  onProgress?: (done: number, total: number) => void;
  /** Seconds the run waits before trying again; 0 when it goes on. */
  onWait?: (seconds: number) => void;
  fetch?: typeof fetch;
  endpoint?: string;
  /** Wait after "too many requests at once". */
  burstWaitMs?: number;
  /**
   * Translations already in hand, by id: those passages aren't sent again,
   * and new ones are added here as they arrive.
   */
  kept?: Map<string, string>;
}

export interface TranslateResult {
  translations: Map<string, string>;
  /** Ids of passages the service didn't translate. */
  missing: string[];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => (signal.removeEventListener("abort", stop), resolve()), ms);
    const stop = () => (clearTimeout(timer), reject(abortError()));
    signal.addEventListener("abort", stop, { once: true });
  });

type Sent = { wait: true } | { wait?: false; done: boolean; error: string | null };

export async function translateSegments<S extends { id: string; text: string }>(segments: S[], o: TranslateOptions): Promise<TranslateResult> {
  const doFetch = o.fetch ?? fetch;
  const endpoint = o.endpoint ?? "/api/ai/translate";
  const translations = o.kept ?? new Map<string, string>();
  const total = segments.length;
  // One controller for every request: the first failure, or Cancel, stops them all.
  const run = new AbortController();
  const onAbort = () => run.abort();
  if (o.signal?.aborted) throw abortError();
  o.signal?.addEventListener("abort", onAbort, { once: true });

  async function send(batch: S[]): Promise<Sent> {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: o.target, source: o.source ?? "auto", segments: batch.map((s) => ({ id: s.id, text: s.text })) }),
        signal: run.signal,
      });
    } catch (err) {
      if (run.signal.aborted || isAbort(err)) throw abortError();
      return { done: false, error: CONNECTION_LOST };
    }
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; upgrade?: boolean };
      if (res.status === 429 && data.reason === "burst") return { wait: true };
      const message = res.status === 400 || !data.error ? "Something went wrong. Please try again." : data.error;
      throw new TranslateError(message, data.reason, !!data.upgrade, res.status);
    }
    const ids = new Set(batch.map((s) => s.id));
    let done = false;
    let error: string | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const read = (line: string) => {
      if (!line.trim()) return;
      let event: TranslateEvent;
      try {
        event = JSON.parse(line) as TranslateEvent;
      } catch {
        return;
      }
      // Only this request's passages, and only as text: nothing here is ever HTML.
      if (event.type === "segment" && ids.has(event.id) && typeof event.text === "string" && event.text) {
        translations.set(event.id, event.text);
        o.onProgress?.(translations.size, total);
      } else if (event.type === "done") done = true;
      else if (event.type === "error") error = typeof event.message === "string" ? event.message : "Something went wrong.";
    };
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          read(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      read(buffer + decoder.decode());
    } catch (err) {
      if (run.signal.aborted || isAbort(err)) throw abortError();
      return { done: false, error: CONNECTION_LOST };
    }
    return { done: done && !error, error: done || error ? error : CONNECTION_LOST };
  }

  async function translateBatch(batch: S[]) {
    let todo = batch;
    let failed: string | null = null;
    let waited = 0;
    for (;;) {
      let sent: Sent;
      try {
        sent = await send(todo);
      } catch (err) {
        // Asking again after a failure found the day used up: the failure is
        // what stopped it, not the person's own use, so it is said as one.
        if (failed && err instanceof TranslateError && err.reason === "translate") throw new TranslateError(failed, "failed");
        throw err;
      }
      if (sent.wait) {
        if (++waited > 3) throw new TranslateError("Too many requests at once. Try again in a minute.", "burst");
        const ms = o.burstWaitMs ?? 20_000;
        o.onWait?.(Math.ceil(ms / 1000));
        await sleep(ms, run.signal);
        o.onWait?.(0);
        continue;
      }
      if (sent.done) return;
      // Failed part way, or at once: what didn't come back is asked for once more.
      todo = todo.filter((s) => !translations.has(s.id));
      if (!todo.length) return;
      if (failed) throw new TranslateError(sent.error ?? CONNECTION_LOST, "failed");
      failed = sent.error ?? CONNECTION_LOST;
    }
  }

  const batches = batchSegments(segments.filter((s) => !translations.has(s.id)));
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (!failure && next < batches.length) {
      const batch = batches[next++];
      try {
        await translateBatch(batch);
      } catch (err) {
        failure ??= err;
        run.abort();
      }
    }
  };
  o.onProgress?.(segments.filter((s) => translations.has(s.id)).length, total);
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL_BATCHES, batches.length) }, worker));
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
  }
  if (o.signal?.aborted) throw abortError();
  if (failure) throw failure;
  return { translations, missing: segments.filter((s) => !translations.has(s.id)).map((s) => s.id) };
}

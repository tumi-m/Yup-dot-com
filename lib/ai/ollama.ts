/**
 * Small Ollama chat client for the PDF assistant: one fetch to the native
 * `POST /api/chat` endpoint, an NDJSON stream parser, and error mapping.
 * No SDK.
 *
 * Talks to Ollama Cloud (https://ollama.com, needs OLLAMA_API_KEY) by default,
 * or to a self-hosted server via OLLAMA_HOST (key optional).
 *
 * Only answer text is ever yielded. Reasoning arrives in `message.thinking`
 * and is dropped here, as is any `<think>…</think>` block a self-hosted model
 * writes inline, so chain-of-thought never reaches the browser.
 */

export const CLOUD_HOST = "https://ollama.com";
/**
 * DeepSeek V4.1 Flash. Direct calls to ollama.com use the name listed by
 * GET https://ollama.com/api/tags; the Ollama CLI and a signed-in
 * self-hosted server use the library tag with the `:cloud` suffix.
 */
export const DEFAULT_CLOUD_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_SELF_HOSTED_MODEL = "deepseek-v4.1-flash:cloud";
/** Document Q&A rarely needs deep reasoning; a low level keeps answers fast. */
const DEFAULT_THINK: Think = "low";
const DEFAULT_CONTEXT_TOKENS = 1_000_000;
const MIN_CONTEXT_TOKENS = 8_192;

export type Think = boolean | "low" | "medium" | "high" | "max";

export interface OllamaConfig {
  /** Normalised base URL without a trailing slash or `/api`. */
  host: string;
  apiKey?: string;
  model: string;
  /** Omitted from the request when undefined, so the model default applies. */
  think?: Think;
  /** Context window the prompt is fitted into. */
  contextTokens: number;
  /** Sent as `options.num_ctx`; only when OLLAMA_CONTEXT_TOKENS is set. */
  numCtx?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type OllamaErrorKind =
  | "auth" // 401/403: bad or missing key, or the plan doesn't include the model
  | "model" // 404: model name not found on this host
  | "rate_limit" // 429
  | "bad_request" // other 4xx
  | "unavailable" // 5xx, network failure, broken stream
  | "timeout"
  | "aborted";

/** `message` is for server logs only; show users `userMessage()` instead. */
export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

const USER_MESSAGES: Record<OllamaErrorKind, string> = {
  auth: "The AI assistant isn't available right now.",
  model: "The AI assistant isn't available right now.",
  rate_limit: "The assistant is busy right now. Try again in a moment.",
  bad_request: "The assistant couldn't process this document.",
  unavailable: "The assistant ran into a problem. Please try again.",
  timeout: "The assistant took too long to answer. Please try again.",
  aborted: "Stopped.",
};

export function userMessage(error: unknown): string {
  return USER_MESSAGES[error instanceof OllamaError ? error.kind : "unavailable"];
}

/**
 * Accepts what people put in OLLAMA_HOST: a full URL, `host:port`, `:port`,
 * or a URL ending in `/api`. Without a scheme it is plain HTTP on 11434, as
 * the Ollama CLI assumes.
 */
export function normalizeHost(raw: string): string {
  let host = raw.trim();
  if (host.startsWith(":")) host = `127.0.0.1${host}`;
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(host);
  const url = new URL(explicit ? host : `http://${host}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OLLAMA_HOST must be http(s)");
  if (!explicit && !url.port) url.port = "11434";
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export function isCloudHost(host: string): boolean {
  const name = new URL(host).hostname;
  return name === "ollama.com" || name.endsWith(".ollama.com");
}

function parseThink(raw: string | undefined): Think | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "true" || value === "on") return true;
  if (value === "false" || value === "off" || value === "none") return false;
  if (value === "low" || value === "medium" || value === "high" || value === "max") return value;
  console.error(`OLLAMA_THINK="${raw}" is not one of low, medium, high, max, true, false; using the model default.`);
  return undefined;
}

/**
 * Reads the AI settings, or returns null when the assistant isn't configured:
 * Ollama Cloud without OLLAMA_API_KEY, or an unusable OLLAMA_HOST.
 */
export function ollamaConfig(env: Record<string, string | undefined> = process.env): OllamaConfig | null {
  const apiKey = env.OLLAMA_API_KEY?.trim() || undefined;
  let host = CLOUD_HOST;
  if (env.OLLAMA_HOST?.trim()) {
    try {
      host = normalizeHost(env.OLLAMA_HOST);
    } catch {
      console.error(`OLLAMA_HOST="${env.OLLAMA_HOST}" is not a valid http(s) URL.`);
      return null;
    }
  }
  const cloud = isCloudHost(host);
  if (cloud && !apiKey) return null;

  let model = env.OLLAMA_MODEL?.trim() || (cloud ? DEFAULT_CLOUD_MODEL : DEFAULT_SELF_HOSTED_MODEL);
  // The ":cloud" tag is for the CLI and signed-in local servers; ollama.com's
  // own API lists the same model without it.
  if (cloud) model = model.replace(/[:-]cloud$/, "");
  // A level is only sent by default to the model it is known to accept; other
  // models get their own default unless OLLAMA_THINK says otherwise.
  const think = parseThink(env.OLLAMA_THINK) ?? (/^deepseek-v4\.1-flash(:|$)/.test(model) ? DEFAULT_THINK : undefined);
  const ctx = Math.floor(Number(env.OLLAMA_CONTEXT_TOKENS));
  const numCtx = Number.isFinite(ctx) && ctx > 0 ? Math.max(MIN_CONTEXT_TOKENS, ctx) : undefined;

  return { host, apiKey, model, think, contextTokens: numCtx ?? DEFAULT_CONTEXT_TOKENS, numCtx };
}

/**
 * Splits a byte stream into parsed JSON lines. Lines may be split across
 * chunks anywhere, including inside a multi-byte character.
 */
export async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
  { onChunk, signal }: { onChunk?: () => void; signal?: AbortSignal } = {}
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const parse = (line: string) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new OllamaError("unavailable", `Unreadable line in Ollama's response: ${line.slice(0, 120)}`);
    }
  };
  // Don't rely on the fetch implementation to end a pending read on abort.
  const onAbort = () => reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield parse(line);
      }
    }
    finished = true;
    const last = (buffer + decoder.decode()).trim();
    if (last) yield parse(last);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // The consumer stopped early: close the connection instead of draining it.
    if (!finished) reader.cancel().catch(() => {});
  }
}

/**
 * Removes `<think>…</think>` blocks from streamed text. Tags may be split
 * across pushes; an unclosed block swallows the rest of the text.
 */
export function createThinkFilter() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let inside = false;
  let pending = "";
  // Length of the longest suffix of `text` that is a prefix of `tag`.
  const partial = (text: string, tag: string) => {
    for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
      if (text.endsWith(tag.slice(0, n))) return n;
    }
    return 0;
  };
  return {
    push(text: string): string {
      let buf = pending + text;
      let out = "";
      pending = "";
      for (;;) {
        const tag = inside ? CLOSE : OPEN;
        const at = buf.indexOf(tag);
        if (at >= 0) {
          if (!inside) out += buf.slice(0, at);
          buf = buf.slice(at + tag.length);
          inside = !inside;
          continue;
        }
        const keep = partial(buf, tag);
        if (!inside) out += buf.slice(0, buf.length - keep);
        pending = buf.slice(buf.length - keep);
        return out;
      }
    },
    flush(): string {
      const rest = inside ? "" : pending;
      pending = "";
      return rest;
    },
  };
}

export interface StreamOptions {
  /** Abort from the caller, e.g. the browser hanging up. */
  signal?: AbortSignal;
  /** Epoch ms after which the request is abandoned (keep under maxDuration). */
  deadline?: number;
  /** Wait for the response to start; long documents take a while to read. */
  headersTimeoutMs?: number;
  /** Longest silence allowed between streamed chunks. */
  idleTimeoutMs?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

export interface StreamResult {
  /** Ollama's `done_reason`, e.g. "stop" or "length". */
  doneReason: string | null;
}

interface ChatChunk {
  message?: { content?: unknown; thinking?: unknown };
  done?: boolean;
  done_reason?: string;
  error?: unknown;
}

async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error.slice(0, 300);
  } catch {}
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function httpError(status: number, detail: string, config: OllamaConfig): OllamaError {
  const said = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) {
    return new OllamaError(
      "auth",
      `Ollama at ${config.host} refused the request (${status}${said}). Check OLLAMA_API_KEY` +
        (isCloudHost(config.host) ? ` and that your Ollama plan includes ${config.model}.` : "."),
      status
    );
  }
  if (status === 404) {
    return new OllamaError(
      "model",
      `Ollama at ${config.host} has no model "${config.model}" (404${said}). Set OLLAMA_MODEL to a name listed by GET ${config.host}/api/tags.`,
      status
    );
  }
  if (status === 429) return new OllamaError("rate_limit", `Ollama rate limit (429${said})`, status);
  if (status >= 500) return new OllamaError("unavailable", `Ollama server error (${status}${said})`, status);
  return new OllamaError("bad_request", `Ollama rejected the request (${status}${said})`, status);
}

/**
 * Streams the answer to `messages`, yielding answer text only. Network
 * failures and 5xx responses are retried once, before anything is streamed.
 * Throws OllamaError.
 */
export async function* streamChat(
  config: OllamaConfig,
  request: { messages: ChatMessage[]; maxAnswerTokens?: number },
  opts: StreamOptions = {}
): AsyncGenerator<string, StreamResult, undefined> {
  const doFetch = opts.fetch ?? fetch;
  const deadline = opts.deadline ?? Date.now() + 110_000;
  const headersTimeoutMs = opts.headersTimeoutMs ?? 60_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  const retryDelayMs = opts.retryDelayMs ?? 800;

  // One controller for the upstream request; the first reason to stop wins.
  const upstream = new AbortController();
  const state: { reason: OllamaError | null } = { reason: null };
  const stop = (reason: OllamaError) => {
    if (state.reason) return;
    state.reason = reason;
    upstream.abort(reason);
  };
  const onAbort = () => stop(new OllamaError("aborted", "Request aborted by the client"));
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const deadlineTimer = setTimeout(
    () => stop(new OllamaError("timeout", "Ollama didn't finish before the deadline")),
    Math.max(0, deadline - Date.now())
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number, what: string) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(new OllamaError("timeout", `No ${what} from Ollama in ${ms / 1000}s`)), ms);
  };

  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/x-ndjson" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const options: Record<string, number> = {};
  if (request.maxAnswerTokens) options.num_predict = request.maxAnswerTokens;
  if (config.numCtx) options.num_ctx = config.numCtx;
  const payload = JSON.stringify({
    model: config.model,
    messages: request.messages,
    stream: true,
    ...(config.think !== undefined && { think: config.think }),
    ...(Object.keys(options).length > 0 && { options }),
  });

  const pause = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (upstream.signal.aborted) return reject(state.reason);
      const timer = setTimeout(resolve, ms);
      upstream.signal.addEventListener("abort", () => (clearTimeout(timer), reject(state.reason)), { once: true });
    });
  const canRetry = () => deadline - Date.now() > retryDelayMs + 10_000;

  try {
    let response: Response | undefined;
    for (let attempt = 0; !response; attempt++) {
      arm(headersTimeoutMs, "response");
      let res: Response;
      try {
        res = await doFetch(`${config.host}/api/chat`, { method: "POST", headers, body: payload, signal: upstream.signal });
      } catch (error) {
        if (state.reason) throw state.reason;
        if (attempt === 0 && canRetry()) {
          await pause(retryDelayMs);
          continue;
        }
        throw new OllamaError("unavailable", `Couldn't reach Ollama at ${config.host}: ${(error as Error).message}`);
      }
      if (res.ok && res.body) {
        response = res;
        break;
      }
      const error = httpError(res.status, await errorDetail(res), config);
      if (error.kind === "unavailable" && attempt === 0 && canRetry()) {
        await pause(retryDelayMs);
        continue;
      }
      throw error;
    }

    const filter = createThinkFilter();
    let started = false;
    // Answer text, minus the blank lines models put after their reasoning.
    const answer = (text: string) => {
      if (!started) text = text.replace(/^\s+/, "");
      if (text) started = true;
      return text;
    };

    arm(idleTimeoutMs, "data");
    const lines = parseNdjson(response.body!, { onChunk: () => arm(idleTimeoutMs, "data"), signal: upstream.signal });
    for await (const value of lines) {
      const chunk = value as ChatChunk;
      if (chunk.error !== undefined) {
        throw new OllamaError("unavailable", `Ollama stream error: ${String(chunk.error).slice(0, 300)}`);
      }
      // chunk.message.thinking is deliberately ignored.
      const content = chunk.message?.content;
      if (typeof content === "string" && content) {
        const text = answer(filter.push(content));
        if (text) yield text;
      }
      if (chunk.done) {
        const rest = answer(filter.flush());
        if (rest) yield rest;
        return { doneReason: chunk.done_reason ?? null };
      }
    }
    throw new OllamaError("unavailable", "Ollama's stream ended before the answer was complete");
  } catch (error) {
    if (state.reason) throw state.reason;
    if (error instanceof OllamaError) throw error;
    throw new OllamaError("unavailable", `Ollama request failed: ${(error as Error)?.message ?? String(error)}`);
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    // Closes the upstream connection if the caller stopped reading early.
    if (!state.reason) upstream.abort();
  }
}

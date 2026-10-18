/** What a cancelled job throws, as fetch does. */
export const abortError = () => new DOMException("Cancelled.", "AbortError");

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

/** Stops a long job between steps once the person cancels or leaves the page. */
export function stopIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

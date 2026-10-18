/**
 * Code that loads when it's needed (the PDF toolkit, the slide parser, the
 * editor) can fail to arrive: offline, a flaky connection, or a deploy that
 * replaced the chunk. Trying again usually works, so these failures must
 * never blame the file or show the bundler's message.
 */

const LOAD_FAILED =
  /ChunkLoadError|Failed to load chunk|Loading (?:CSS )?chunk|Failed to fetch|dynamically imported module|Importing a module script failed|NetworkError|^Load failed$/i;

/** True when a dynamic import or the fetch behind it failed. */
export function isLoadError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  return name === "ChunkLoadError" || LOAD_FAILED.test(message);
}

/** "Couldn't load the tool. Check your connection and try again." */
export function loadErrorMessage(what = "the tool"): string {
  return `Couldn't load ${what}. Check your connection and try again.`;
}

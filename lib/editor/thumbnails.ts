/**
 * How the page list draws its thumbnails: only near the visible part of the
 * list, a few at a time. Drawing every page at once froze a 2000-page
 * document's tab for half a minute and took gigabytes. Kept free of React so
 * it can be unit tested.
 */

/** Thumbnails within this distance of the visible list are drawn; further ones let go of their pixels. */
export const NEAR_MARGIN = "600px 0px";

/** Pages drawn at the same time. */
export const DRAWN_AT_ONCE = 2;

/**
 * Runs at most `limit` tasks at once, the others in the order they came. A
 * task that no longer matters when its turn comes should return at once.
 */
export function taskLimiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    // A finished task hands its place straight to the next, so none can slip in between.
    if (running < limit) running++;
    else await new Promise<void>((go) => waiting.push(go));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

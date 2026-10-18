/** Pure helpers for lists people remove items from or reorder, kept apart so tests can run them. */

/** Which item takes focus when one is removed: the next, else the one before; null when none is left. */
export function focusAfterRemove(ids: string[], removed: string): string | null {
  const i = ids.indexOf(removed);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** What a screen reader hears when a file is moved with the arrow keys. */
export function movedMessage(name: string, to: number, total: number): string {
  return `${name} moved to position ${to + 1} of ${total}`;
}

/**
 * What a live region says while slides are worked through: the start, then
 * each quarter. Not every slide or percent, which a screen reader would queue
 * and still be reading after the result has arrived. The result announces
 * the end itself.
 */
export function slideProgressNote(done: number, total: number, start: string): string {
  // The last slide changes nothing: the result is about to say it's done.
  const counted = Math.min(done, total - 1);
  const quarter = Math.min(3, Math.floor((counted / Math.max(1, total)) * 4));
  return quarter <= 0 ? start : `${quarter * 25}% done`;
}

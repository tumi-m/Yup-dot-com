/**
 * Whether this browser opens HEIC photos (Safari does; Chrome, Edge and
 * Firefox don't), asked once by opening a one-pixel HEIC made for the
 * purpose. Loaded only on pages that take HEIC.
 */

/** A 1 x 1 red HEIC picture, 458 bytes. */
const SAMPLE =
  "AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABfG1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAImlsb2MAAAAAREAAAQABAAAAAAGcAAEAAAAAAAAAKgAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGh2YzEAAAAADnBpdG0AAAAAAAEAAAD8aXBycAAAANxpcGNvAAAAdWh2Y0MBA3AAAACQAAAAAAAe8AD8/fj4AAAPA2AAAQAYQAEMAf//A3AAAAMAkAAAAwAAAwAeugJAYQABAClCAQEDcAAAAwCQAAADAAADAB6gIIEFluqumubgIaDAgAAADIAAAAMAhGIAAQAGRAHBc8GJAAAAE2NvbHJuY2x4AAEADQAGgAAAABRpc3BlAAAAAAAAAEAAAABAAAAAKGNsYXAAAAABAAAAAQAAAAEAAAAB////wQAAAAL////BAAAAAgAAABBwaXhpAAAAAAMICAgAAAAYaXBtYQAAAAAAAAABAAEFgQIDBYQAAAAybWRhdAAAACYoAa8FEhNVIPq6Ujuf1BHlwGIqNrSo5MYYJ3RGm7JnS26HBU7VQA==";

let answer: Promise<boolean> | null = null;

export function canOpenHeic(): Promise<boolean> {
  answer ??= (async () => {
    if (typeof createImageBitmap !== "function") return false;
    try {
      const bytes = Uint8Array.from(atob(SAMPLE), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/heic" }));
      const ok = bitmap.width === 1 && bitmap.height === 1;
      bitmap.close();
      return ok;
    } catch {
      return false;
    }
  })();
  return answer;
}

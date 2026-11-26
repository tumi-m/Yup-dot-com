/**
 * The phone's camera for Scan to PDF: the rear camera at the best
 * resolution it gives, and what to tell people when it won't start. The
 * stream is only ever shown on the page; frames become photos on the device
 * (photo.ts) and are never sent anywhere.
 */

/** Rear camera, as many pixels as it offers: the browser picks the nearest it has. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 4096 } },
};

/** Where getUserMedia exists here: a secure page in a browser that has it (some in-app browsers don't). */
export function canUseCamera(nav: Partial<Navigator> | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  return !!nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === "function";
}

/** What went wrong, in words. */
export interface CameraProblem {
  message: string;
  /** There is no camera to use: the live view isn't offered again. */
  noCamera?: boolean;
  /** Refused: browsers remember that, so the camera app is offered from then on. */
  refused?: boolean;
}

/** The camera's error as people should read it; on a phone the camera app is the way round, elsewhere photos. */
export function cameraProblem(err: unknown, phone = true): CameraProblem {
  const name = typeof err === "object" && err && "name" in err ? String((err as { name: unknown }).name) : "";
  const instead = phone ? "take a photo instead" : "choose photos instead";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return { message: `Camera access is off for this site. Allow it in your browser's settings, or ${instead}.`, refused: true };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { message: `No camera found. ${phone ? "Take a photo with your camera app, or choose photos." : "Choose photos instead."}`, noCamera: true };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return { message: `The camera is busy in another app. Close it and try again, or ${instead}.` };
    default:
      return { message: `The camera didn't start. Try again, or ${instead}.` };
  }
}

/** Opens the camera: the rear one at its best, else any camera at all. */
export async function openCamera(): Promise<MediaStream> {
  const media = navigator.mediaDevices;
  try {
    return await media.getUserMedia(CAMERA_CONSTRAINTS);
  } catch (err) {
    // A camera that can't meet the size or the side: take what there is.
    if ((err as Error)?.name !== "OverconstrainedError") throw err;
    return media.getUserMedia({ audio: false, video: true });
  }
}

/** Turns the camera off (its light goes out). */
export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * True when this document was loaded at another address and then moved here
 * in the page (a link inside the site). The camera permission comes with the
 * first page's headers, and only this page's allow it, so the page loads
 * itself once more before the camera can start.
 */
export function loadedElsewhere(path: string): boolean {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return false;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!nav?.name) return false;
  try {
    return new URL(nav.name).pathname.replace(/\/$/, "") !== path;
  } catch {
    return false;
  }
}

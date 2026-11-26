/**
 * The Permissions-Policy header (next.config.ts). Camera, microphone and
 * location are off on every page, so nothing on the site, or put into it,
 * can ask for them; the camera is allowed, for this site only, on the pages
 * that use it.
 */

/** Pages that may ask for the camera. */
export const CAMERA_PAGES = ["/tools/scan-to-pdf"];

export function permissionsPolicy(camera = false): string {
  return `camera=(${camera ? "self" : ""}), microphone=(), geolocation=()`;
}

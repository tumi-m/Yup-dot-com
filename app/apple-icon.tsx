import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * The home-screen icon on iPhone and iPad, which don't use the SVG favicon:
 * app/icon.svg's hat on the full square (iOS rounds the corners itself).
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#7c3aed" }}>
        <svg width="150" height="150" viewBox="0 0 24 24">
          <path d="M5 18.5c0-.9 3.1-1.6 7-1.6s7 .7 7 1.6-3.1 1.6-7 1.6-7-.7-7-1.6Z" fill="#ffffff" opacity="0.45" />
          <path d="M12 3.2c.4 0 .7.25.85.66l4.3 11.7c.18.49-.16 1-.68 1.08-1.2.2-2.8.36-4.47.36s-3.27-.16-4.47-.36c-.52-.08-.86-.59-.68-1.08l4.3-11.7c.15-.41.45-.66.85-.66Z" fill="#ffffff" />
          <path d="M12 7.6l.62 1.45 1.55.18-1.16 1.05.35 1.53-1.36-.8-1.36.8.35-1.53-1.16-1.05 1.55-.18L12 7.6Z" fill="#fbbf24" />
        </svg>
      </div>
    ),
    size
  );
}

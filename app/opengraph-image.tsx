import { ImageResponse } from "next/og";

export const alt = "PDF Wizard";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The shared-link preview for every page. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1e1037 0%, #4c1d95 45%, #a21caf 80%, #f59e0b 120%)",
          color: "white",
        }}
      >
        <svg width="160" height="160" viewBox="0 0 24 24">
          <rect width="24" height="24" rx="6" fill="#7c3aed" />
          <path d="M5 18.5c0-.9 3.1-1.6 7-1.6s7 .7 7 1.6-3.1 1.6-7 1.6-7-.7-7-1.6Z" fill="#ffffff" opacity="0.45" />
          <path d="M12 3.2c.4 0 .7.25.85.66l4.3 11.7c.18.49-.16 1-.68 1.08-1.2.2-2.8.36-4.47.36s-3.27-.16-4.47-.36c-.52-.08-.86-.59-.68-1.08l4.3-11.7c.15-.41.45-.66.85-.66Z" fill="#ffffff" />
          <path d="M12 7.6l.62 1.45 1.55.18-1.16 1.05.35 1.53-1.36-.8-1.36.8.35-1.53-1.16-1.05 1.55-.18L12 7.6Z" fill="#fbbf24" />
        </svg>
        <div style={{ marginTop: 40, fontSize: 96, fontWeight: 700, letterSpacing: -2 }}>PDF Wizard</div>
        <div style={{ marginTop: 12, fontSize: 40, opacity: 0.85 }}>PDFs, slides and video. In your browser.</div>
      </div>
    ),
    size
  );
}

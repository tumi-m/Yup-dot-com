"use client";

/**
 * Last-resort error page, used when the root layout itself fails. It renders
 * its own document without the app's stylesheet, so styles are inline.
 */
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          color: "#111827",
          background: "linear-gradient(to bottom, #f1ebfe, #ffffff)",
        }}
      >
        <title>A spell misfired | PDF Wizard</title>
        <main style={{ textAlign: "center", padding: 24 }}>
          <svg viewBox="0 0 24 24" width="72" height="72" aria-hidden="true" style={{ color: "#7c3aed" }}>
            <path d="M3 19.5c0-1 4-2 9-2s9 1 9 2-4 2-9 2-9-1-9-2Z" fill="currentColor" opacity="0.35" />
            <path
              d="M12 2.2c.5 0 .8.3 1 .8l5.4 14.4c.2.5-.2 1-.8 1.1-1.4.3-3.4.5-5.6.5s-4.2-.2-5.6-.5c-.6-.1-1-.6-.8-1.1L11 3c.2-.5.5-.8 1-.8Z"
              fill="currentColor"
            />
            <path d="M12 7.4l.7 1.6 1.7.2-1.3 1.2.4 1.7-1.5-.9-1.5.9.4-1.7-1.3-1.2 1.7-.2.7-1.6Z" fill="#fde047" />
          </svg>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: "24px 0 32px" }}>A spell misfired</h1>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => retry()}
              style={{
                height: 44,
                padding: "0 24px",
                borderRadius: 10,
                border: "none",
                background: "#7c3aed",
                color: "#fff",
                fontSize: 16,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/* A full page load: the client router is what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                height: 44,
                padding: "0 24px",
                borderRadius: 10,
                border: "1px solid #e4dff0",
                background: "#fff",
                color: "#111827",
                fontSize: 16,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                textDecoration: "none",
              }}
            >
              Back home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}

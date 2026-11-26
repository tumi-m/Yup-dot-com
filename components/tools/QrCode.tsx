"use client";

import { useEffect, useState } from "react";

/**
 * A QR code for a link, drawn as SVG on the device. The encoder (uqr, MIT)
 * loads with this component only, so no other page carries it.
 */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const [cells, setCells] = useState<boolean[][] | null>(null);

  useEffect(() => {
    let live = true;
    import("uqr")
      .then(({ encode }) => live && setCells(encode(text, { ecc: "M", border: 2 }).data))
      .catch(() => live && setCells(null));
    return () => {
      live = false;
    };
  }, [text]);

  if (!cells) return <div aria-hidden className={className} />;
  const size = cells.length;
  // One path of unit squares: small, and crisp at any size.
  let d = "";
  cells.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    })
  );
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={className} shapeRendering="crispEdges">
      {/* Dark on white in either theme: phone cameras read it that way. */}
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

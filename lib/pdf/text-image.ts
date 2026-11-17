/**
 * Renders wrapped text (any script) to a transparent PNG, sized in points,
 * for what the standard PDF fonts can't draw. Lines past `maxHeight` are left
 * out. Browser only; returns null where canvas isn't available.
 */
export async function renderTextImage(
  text: string,
  fontSize: number,
  color: string,
  bold: boolean,
  maxWidth: number,
  maxHeight = Infinity
): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  const k = 4; // pixels per point, for print-quality edges
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const font = `${bold ? "bold " : ""}${fontSize * k}px Helvetica, Arial, "Noto Sans", sans-serif`;
  ctx.font = font;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    // Split on spaces, or between characters for scripts written without them.
    for (const word of paragraph.match(/\S+\s*|\s+/g) ?? [""]) {
      const candidate = line + word;
      if (!line || ctx.measureText(candidate.trimEnd()).width <= maxWidth * k) line = candidate;
      else {
        lines.push(line.trimEnd());
        line = word;
      }
      while (ctx.measureText(line.trimEnd()).width > maxWidth * k && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth * k) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  const lineHeight = fontSize * 1.2;
  // At least one line, even when the box is shorter than that.
  lines.splice(Math.max(1, Math.floor(maxHeight / lineHeight)));
  const width = Math.max(1, Math.min(maxWidth, Math.max(...lines.map((l) => ctx.measureText(l).width / k))));
  const height = lines.length * lineHeight;
  canvas.width = Math.ceil(width * k);
  canvas.height = Math.ceil(height * k);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  lines.forEach((line, i) => ctx.fillText(line, 0, (i * lineHeight + fontSize) * k));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width / k, height: canvas.height / k };
}

/** What to say when the Paste button can't read the clipboard. */
export function pasteBlockedHint({ touch, mac }: { touch: boolean; mac: boolean }): string {
  // Phones and tablets have no Ctrl key.
  if (touch) return "Clipboard blocked. Long-press the box and choose Paste.";
  return `Clipboard blocked. Paste with ${mac ? "⌘V" : "Ctrl+V"}.`;
}

/** The hint for this device. */
export function pasteBlockedMessage(): string {
  if (typeof window === "undefined") return pasteBlockedHint({ touch: false, mac: false });
  return pasteBlockedHint({
    touch: window.matchMedia("(pointer: coarse)").matches,
    mac: /Mac|iPhone|iPad/i.test(navigator.platform),
  });
}

import { PDFDocument } from "pdf-lib";

/**
 * Opens a PDF to change it. One restricted by an owner password only opens
 * without a password in every reader, so it opens here too, decrypted. One
 * that needs a password to open still fails with pdf-lib's "encrypted"
 * error, which reads "Unlock it first".
 */
export async function openPdf(bytes: ArrayBuffer | Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    if (!/encrypted/i.test(err instanceof Error ? err.message : "")) throw err;
    let plain: Uint8Array;
    try {
      const { unlockPdf } = await import("./security");
      plain = await unlockPdf(bytes, "");
    } catch {
      // It needs a password.
      throw err;
    }
    return PDFDocument.load(plain);
  }
}

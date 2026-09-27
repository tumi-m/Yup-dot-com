import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";

/**
 * Password protection and removal.
 *
 * Upstream pdf-lib cannot write encrypted PDFs, so this module uses the
 * @cantoo/pdf-lib fork, which adds the standard security handler (AES-256
 * where supported). It is isolated here so the rest of the codebase keeps
 * using upstream pdf-lib.
 */

export interface ProtectOptions {
  /** Required to open the document. */
  userPassword: string;
  /** Grants full access; defaults to the user password when omitted. */
  ownerPassword?: string;
  allowPrinting?: boolean;
  allowCopying?: boolean;
  allowModifying?: boolean;
}

export async function protectPdf(
  bytes: Uint8Array | ArrayBuffer,
  opts: ProtectOptions
): Promise<Uint8Array> {
  if (!opts.userPassword) throw new Error("Please enter a password.");
  const doc = await SecurePDFDocument.load(bytes);
  doc.encrypt({
    userPassword: opts.userPassword,
    ownerPassword: opts.ownerPassword || opts.userPassword,
    permissions: {
      printing: opts.allowPrinting ? "highResolution" : false,
      copying: !!opts.allowCopying,
      modifying: !!opts.allowModifying,
      annotating: !!opts.allowModifying,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: !!opts.allowModifying,
    },
  });
  return doc.save({ useObjectStreams: false });
}

/** Opens an encrypted PDF with its password and saves an unencrypted copy. */
export async function unlockPdf(
  bytes: Uint8Array | ArrayBuffer,
  password: string
): Promise<Uint8Array> {
  let doc: SecurePDFDocument;
  try {
    doc = await SecurePDFDocument.load(bytes, { password });
  } catch {
    throw new Error("That password didn't work. Check it and try again.");
  }
  // Saving without calling encrypt() writes the document in the clear.
  return doc.save();
}

/** True when the document carries an /Encrypt dictionary. */
export async function isEncrypted(bytes: Uint8Array | ArrayBuffer): Promise<boolean> {
  const doc = await SecurePDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.isEncrypted;
}

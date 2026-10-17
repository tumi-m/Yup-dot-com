import {
  PDFDocument as SecurePDFDocument,
  PDFDict,
  PDFInvalidObject,
  PDFName,
} from "@cantoo/pdf-lib";

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
  /**
   * Grants full access. When omitted a random one is used, so the open
   * password alone can't lift the print/copy/edit restrictions.
   */
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
    ownerPassword: opts.ownerPassword || randomPassword(),
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

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
  dropEncryptionLeftovers(doc);
  // Saving without calling encrypt() writes the document in the clear.
  return doc.save();
}

/**
 * Decrypting leaves the source's old security dictionary in the document, and
 * an old cross-reference stream (kept as raw bytes that still name /Encrypt).
 * Written back out, they make the copy read as encrypted again.
 */
function dropEncryptionLeftovers(doc: SecurePDFDocument) {
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    let leftover = false;
    if (obj instanceof PDFInvalidObject) {
      const raw = new Uint8Array(obj.sizeInBytes());
      obj.copyBytesInto(raw, 0);
      leftover = /\/Type\s*\/XRef\b/.test(new TextDecoder("latin1").decode(raw));
    } else if (obj instanceof PDFDict) {
      leftover =
        obj.get(PDFName.of("Filter")) === PDFName.of("Standard") &&
        obj.has(PDFName.of("O")) &&
        obj.has(PDFName.of("U"));
    }
    if (leftover) ctx.delete(ref);
  }
}

/** True when the document carries an /Encrypt dictionary. */
export async function isEncrypted(bytes: Uint8Array | ArrayBuffer): Promise<boolean> {
  const doc = await SecurePDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.isEncrypted;
}

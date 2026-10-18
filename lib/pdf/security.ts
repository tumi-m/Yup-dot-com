import {
  PDFDocument as SecurePDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFStream,
  PDFString,
  type PDFObject,
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
  encryptStrings(doc);
  return doc.save({ useObjectStreams: false });
}

/**
 * The fork encrypts streams but writes strings as they are: the title and
 * author, bookmarks, link addresses, form values. Readers then "decrypt" them
 * into noise, and anyone can read them without the password. This encrypts
 * each one with its object's key, as the standard handler expects. The
 * security dictionary and a signature's Contents stay as they are.
 */
function encryptStrings(doc: SecurePDFDocument) {
  const ctx = doc.context;
  const security = ctx.security;
  if (!security) return;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref === ctx.trailerInfo.Encrypt) continue;
    const encrypt = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    const seal = (value: PDFObject): PDFObject => {
      if (value instanceof PDFString || value instanceof PDFHexString) return PDFHexString.fromBytes(encrypt(value.asBytes()));
      if (value instanceof PDFArray) {
        for (let i = 0; i < value.size(); i++) value.set(i, seal(value.get(i)));
      } else if (value instanceof PDFDict) {
        const signature = value.get(PDFName.of("Type")) === PDFName.of("Sig");
        for (const [key, v] of value.entries()) {
          if (!(signature && key === PDFName.of("Contents"))) value.set(key, seal(v));
        }
      }
      return value;
    };
    seal(obj instanceof PDFStream ? obj.dict : obj);
  }
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

/**
 * Pages in an encrypted PDF that opens without a password: one an owner
 * password only restricts (printing, copying, editing). Throws when it needs
 * a password to open.
 */
export async function pageCountWithoutPassword(bytes: Uint8Array | ArrayBuffer): Promise<number> {
  const doc = await SecurePDFDocument.load(bytes, { password: "" });
  return doc.getPageCount();
}

import type { PlanId } from "./types";

/**
 * Usage tiers. Guests (no account) get the whole product; limits exist only
 * where they are the upgrade lever competitors use (file size, batch size) or
 * where usage costs real money (AI). Nothing here gates a first task.
 */
export type Tier = "guest" | PlanId;

export interface TierLimits {
  maxFileBytes: number;
  maxBatchFiles: number;
  aiAnswersPerDay: number;
  /** Characters of document text the AI will read. */
  aiDocumentChars: number;
  /** Video/audio downloads (X, TikTok, Instagram; YouTube when enabled) per day. */
  mediaDownloadsPerDay: number;
  /** Google Slides link imports per day. */
  linkImportsPerDay: number;
  /** Sample Finder song lookups per day (hand-checked results and cached links are free). */
  sampleLookupsPerDay: number;
  /** Documents saved out of Edit PDF, Sign PDF and Edit PPTX per day (Infinity: unlimited). */
  editsPerDay: number;
  /** Edited files carry a small "Made with PDF Wizard" mark. */
  watermark: boolean;
  /** Pages in each file Compare PDFs reads: every page's words are held at once. */
  comparePages: number;
  /** Pages Redact PDF rebuilds in one go: each becomes a picture, held until the file is written. */
  redactPages: number;
  /**
   * Characters of document text Translate PDF sends to the model a day
   * (about 3,000 to a full page). Output costs more than input, so this is
   * well under what Chat with PDF reads a day.
   */
  translateCharsPerDay: number;
  /**
   * Word and Excel to PDF: files converted a day. Each is uploaded to the
   * media worker and run through LibreOffice, the one tool that costs server
   * time per file.
   */
  officeConversionsPerDay: number;
  /** Largest Word or Excel file uploaded for conversion. */
  officeMaxBytes: number;
}

const MB = 1024 * 1024;

export const LIMITS: Record<Tier, TierLimits> = {
  guest: { maxFileBytes: 50 * MB, maxBatchFiles: 10, aiAnswersPerDay: 3, aiDocumentChars: 150_000, mediaDownloadsPerDay: 5, linkImportsPerDay: 20, sampleLookupsPerDay: 10, editsPerDay: 1, watermark: true, comparePages: 200, redactPages: 100, translateCharsPerDay: 15_000, officeConversionsPerDay: 5, officeMaxBytes: 25 * MB },
  free: { maxFileBytes: 50 * MB, maxBatchFiles: 10, aiAnswersPerDay: 10, aiDocumentChars: 300_000, mediaDownloadsPerDay: 10, linkImportsPerDay: 50, sampleLookupsPerDay: 30, editsPerDay: 1, watermark: true, comparePages: 200, redactPages: 100, translateCharsPerDay: 60_000, officeConversionsPerDay: 10, officeMaxBytes: 25 * MB },
  pro: { maxFileBytes: 500 * MB, maxBatchFiles: 200, aiAnswersPerDay: 40, aiDocumentChars: 600_000, mediaDownloadsPerDay: 200, linkImportsPerDay: 500, sampleLookupsPerDay: 300, editsPerDay: Infinity, watermark: false, comparePages: 2000, redactPages: 1000, translateCharsPerDay: 400_000, officeConversionsPerDay: 200, officeMaxBytes: 100 * MB },
  team: { maxFileBytes: 500 * MB, maxBatchFiles: 200, aiAnswersPerDay: 40, aiDocumentChars: 600_000, mediaDownloadsPerDay: 200, linkImportsPerDay: 500, sampleLookupsPerDay: 300, editsPerDay: Infinity, watermark: false, comparePages: 2000, redactPages: 1000, translateCharsPerDay: 400_000, officeConversionsPerDay: 200, officeMaxBytes: 100 * MB },
};

export function limitsFor(tier: Tier): TierLimits {
  return LIMITS[tier];
}

export function formatLimitBytes(bytes: number) {
  return `${Math.round(bytes / MB)} MB`;
}

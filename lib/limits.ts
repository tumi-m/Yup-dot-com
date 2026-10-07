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
  /** Video/audio downloads (YouTube, X) per day. */
  mediaDownloadsPerDay: number;
  /** Google Slides link imports per day. */
  linkImportsPerDay: number;
  /** Documents saved out of Edit PDF, Sign PDF and Edit PPTX per day (Infinity: unlimited). */
  editsPerDay: number;
  /** Edited files carry a small "Made with PDF Wizard" mark. */
  watermark: boolean;
}

const MB = 1024 * 1024;

export const LIMITS: Record<Tier, TierLimits> = {
  guest: { maxFileBytes: 50 * MB, maxBatchFiles: 10, aiAnswersPerDay: 3, aiDocumentChars: 150_000, mediaDownloadsPerDay: 5, linkImportsPerDay: 20, editsPerDay: 1, watermark: true },
  free: { maxFileBytes: 50 * MB, maxBatchFiles: 10, aiAnswersPerDay: 10, aiDocumentChars: 300_000, mediaDownloadsPerDay: 10, linkImportsPerDay: 50, editsPerDay: 1, watermark: true },
  pro: { maxFileBytes: 500 * MB, maxBatchFiles: 200, aiAnswersPerDay: 40, aiDocumentChars: 600_000, mediaDownloadsPerDay: 200, linkImportsPerDay: 500, editsPerDay: Infinity, watermark: false },
  team: { maxFileBytes: 500 * MB, maxBatchFiles: 200, aiAnswersPerDay: 40, aiDocumentChars: 600_000, mediaDownloadsPerDay: 200, linkImportsPerDay: 500, editsPerDay: Infinity, watermark: false },
};

export function limitsFor(tier: Tier): TierLimits {
  return LIMITS[tier];
}

export function formatLimitBytes(bytes: number) {
  return `${Math.round(bytes / MB)} MB`;
}

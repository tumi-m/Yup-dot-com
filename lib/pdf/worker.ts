/**
 * Single place that configures the pdf.js worker.
 *
 * Served from this app's own origin (see scripts/copy-vendor.mjs) under a
 * version-stamped path, so the worker always matches the pdf.js API — pdf.js
 * refuses to run on a version mismatch — and can be cached forever.
 * NEXT_PUBLIC_PDFJS_WORKER_SRC overrides it (the Node test suite uses this).
 */
export function configureWorker(pdfjsLib: {
  GlobalWorkerOptions: { workerSrc: string };
  version: string;
}) {
  if (pdfjsLib.GlobalWorkerOptions.workerSrc) return;
  const override = process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    override && override.length > 0
      ? override
      : `/vendor/pdfjs/${pdfjsLib.version}/pdf.worker.min.mjs`;
}

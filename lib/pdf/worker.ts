/**
 * Single place that configures the pdf.js worker.
 *
 * Defaults to a version-pinned CDN build. Deployments behind a strict CSP (or
 * with no outbound CDN access) can self-host the worker and point
 * NEXT_PUBLIC_PDFJS_WORKER_SRC at it, e.g. "/pdf.worker.min.mjs".
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
      : `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
}

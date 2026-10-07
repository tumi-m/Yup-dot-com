"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Crown, Loader2, Pencil, Trash2, Upload } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getPageCount } from "@/lib/pdf/operations";
import { formatBytes, formatDate, uuid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dropzone } from "@/components/ui/dropzone";
import { AnimatePresence, motion } from "motion/react";
import { DUR, EASE_OUT, Reveal, staggerDelay } from "@/components/motion/primitives";
import { getTool } from "@/lib/tools";
import { cn } from "@/lib/utils";
import type { DocumentRecord, PlanId } from "@/lib/types";

const QUICK = ["merge-pdf", "compress-pdf", "pdf-to-word", "ocr-pdf", "protect-pdf", "chat-with-pdf", "split-pdf", "pdf-to-excel"];

/** A tinted page with its page count, in place of a real preview. */
function PageThumb({ pages }: { pages: number }) {
  return (
    <div className="relative flex h-28 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-violet-50 via-fuchsia-50 to-amber-50">
      {pages > 1 && <div aria-hidden className="absolute h-20 w-16 translate-x-1.5 translate-y-1 rotate-6 rounded-md bg-white/70 shadow-sm" />}
      <div aria-hidden className="relative h-20 w-16 rounded-md bg-white p-2 shadow-md shadow-primary/10 transition-transform duration-300 ease-out group-hover:-rotate-3">
        <div className="h-1 w-3/4 rounded bg-primary/40" />
        <div className="mt-1.5 space-y-1">
          <div className="h-0.5 w-full rounded bg-secondary-foreground/15" />
          <div className="h-0.5 w-full rounded bg-secondary-foreground/15" />
          <div className="h-0.5 w-4/5 rounded bg-secondary-foreground/15" />
          <div className="h-0.5 w-full rounded bg-secondary-foreground/15" />
          <div className="h-0.5 w-3/5 rounded bg-secondary-foreground/15" />
        </div>
      </div>
      <span className="absolute bottom-2 right-2 rounded-full bg-background/90 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
        {pages}
      </span>
    </div>
  );
}

export function DashboardClient({
  initialDocuments,
  plan,
  maxDocuments,
}: {
  initialDocuments: DocumentRecord[];
  plan: PlanId;
  maxDocuments: number;
}) {
  const router = useRouter();
  const supabase = createClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [docs, setDocs] = useState<DocumentRecord[]>(initialDocuments);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const atLimit = maxDocuments !== -1 && docs.length >= maxDocuments;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    if (atLimit) {
      setError(
        `You've reached the ${maxDocuments}-document limit on the ${plan} plan. Upgrade for more.`
      );
      return;
    }

    const file = files[0];
    if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) {
      setError("Please choose a PDF file.");
      return;
    }

    setUploading(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated.");

      const bytes = new Uint8Array(await file.arrayBuffer());
      const pageCount = await getPageCount(bytes);

      const docId = uuid();
      const storagePath = `${user.id}/${docId}.pdf`;

      // The row comes first: storage only accepts files that belong to a
      // document, and the database enforces the plan's document limit.
      const { data: row, error: insertError } = await supabase
        .from("documents")
        .insert({
          id: docId,
          owner_id: user.id,
          name: file.name.replace(/\.pdf$/i, ""),
          storage_path: storagePath,
          size_bytes: file.size,
          page_count: pageCount,
        })
        .select("*")
        .single();
      if (insertError) throw new Error(insertError.message);

      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(storagePath, file, {
          contentType: "application/pdf",
          upsert: false,
        });
      if (uploadError) {
        await supabase.from("documents").delete().eq("id", docId);
        throw uploadError;
      }

      setDocs((prev) => [row as DocumentRecord, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleDelete(doc: DocumentRecord) {
    setPendingDelete(null);
    const prev = docs;
    setDocs((d) => d.filter((x) => x.id !== doc.id));
    const { error } = await supabase.from("documents").delete().eq("id", doc.id);
    await supabase.storage.from("documents").remove([doc.storage_path]);
    if (error) {
      setError("Failed to delete document.");
      setDocs(prev);
    }
    router.refresh();
  }

  return (
    <main id="main"
      className="container py-10"
      // Drop a PDF anywhere on the page.
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDragging(false);
        if (e.isDefaultPrevented() || e.nativeEvent.defaultPrevented) return; // the drop zone took it
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your documents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {docs.length} {docs.length === 1 ? "document" : "documents"}
            {maxDocuments !== -1 && ` of ${maxDocuments}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {atLimit && (
            <Button asChild variant="outline" className="h-11">
              <Link href="/settings/billing">
                <Crown /> Upgrade
              </Link>
            </Button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => handleFiles(e.target.files)}
          />
          {docs.length > 0 && (
            <Button className="h-11" onClick={() => fileInput.current?.click()} disabled={uploading || atLimit}>
              {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
              Upload PDF
            </Button>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            key="error"
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: DUR.base, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <span className="mt-4 flex items-center gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
            </span>
          </motion.p>
        )}
      </AnimatePresence>

      {docs.length === 0 ? (
        <Dropzone
          className="mt-10 py-20"
          label="Drop a PDF"
          button="Upload PDF"
          accept="application/pdf"
          onFiles={handleFiles}
          dragging={dragging}
          busy={uploading}
          disabled={atLimit}
        />
      ) : (
        <div
          className={cn(
            "relative mt-8 grid gap-4 rounded-3xl transition-shadow sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
            dragging && "ring-2 ring-primary ring-offset-8 ring-offset-background"
          )}
        >
          {docs.map((doc, i) => (
            <div
              key={doc.id}
              className="group flex min-w-0 flex-col rounded-2xl border border-border bg-card p-5 transition-[transform,box-shadow,border-color] duration-300 ease-out hover:-translate-y-[3px] hover:border-primary/40 hover:shadow-lg motion-safe:animate-rise motion-reduce:transform-none"
              style={{ animationDelay: `${staggerDelay(i)}s` }}
            >
              <PageThumb pages={doc.page_count} />
              <h3 className="mt-4 truncate font-semibold" title={doc.name}>
                {doc.name}
              </h3>
              <p className="text-xs text-muted-foreground">
                {doc.page_count} {doc.page_count === 1 ? "page" : "pages"} · {formatBytes(doc.size_bytes)}
              </p>
              <p className="text-xs text-muted-foreground">Updated {formatDate(doc.updated_at)}</p>
              <div className="mt-4 flex gap-2">
                <Button asChild className="h-11 flex-1">
                  <Link href={`/editor/${doc.id}`}>
                    <Pencil /> Edit
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  className="h-11 w-11 p-0"
                  onClick={() => setPendingDelete(doc)}
                  aria-label={`Delete ${doc.name}`}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="pr-8">Delete {pendingDelete ? `“${pendingDelete.name}”` : "document"}?</DialogTitle>
            <DialogDescription>This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="outline" className="h-11" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" className="h-11" onClick={() => pendingDelete && handleDelete(pendingDelete)}>
              <Trash2 /> Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <section className="mt-14">
        <h2 className="mb-4 text-lg font-semibold">Tools</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK.map((slug) => {
            const tool = getTool(slug);
            if (!tool) return null;
            return (
              <Reveal key={slug}>
                <Link
                  href={`/tools/${slug}`}
                  className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card p-3 transition-[transform,box-shadow,border-color] duration-300 ease-out hover:-translate-y-[3px] hover:border-primary/40 hover:shadow-md"
                >
                  <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg", tool.tint)}>
                    <tool.icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium">{tool.name}</span>
                </Link>
              </Reveal>
            );
          })}
        </div>
      </section>
    </main>
  );
}

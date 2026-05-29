"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Upload,
  FileText,
  Loader2,
  Trash2,
  Pencil,
  Crown,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getPageCount } from "@/lib/pdf/operations";
import { formatBytes, formatDate, uuid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { DocumentRecord, PlanId } from "@/lib/types";

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

      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(storagePath, file, {
          contentType: "application/pdf",
          upsert: false,
        });
      if (uploadError) throw uploadError;

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
      if (insertError) throw insertError;

      setDocs((prev) => [row as DocumentRecord, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleDelete(doc: DocumentRecord) {
    if (!confirm(`Delete "${doc.name}"? This cannot be undone.`)) return;
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
    <main className="container py-10">
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
            <Button asChild variant="outline">
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
            onChange={(e) => handleFiles(e.target.files)}
          />
          <Button
            onClick={() => fileInput.current?.click()}
            disabled={uploading || atLimit}
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            Upload PDF
          </Button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {docs.length === 0 ? (
        <button
          onClick={() => fileInput.current?.click()}
          className="mt-10 flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border py-24 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <FileText className="h-10 w-10" />
          <p className="mt-3 font-medium">No documents yet</p>
          <p className="text-sm">Upload a PDF to get started</p>
        </button>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {docs.map((doc) => (
            <div
              key={doc.id}
              className="group flex flex-col rounded-2xl border border-border bg-card p-5 transition-shadow hover:shadow-md"
            >
              <div className="flex h-28 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                <FileText className="h-10 w-10" />
              </div>
              <h3 className="mt-4 truncate font-semibold" title={doc.name}>
                {doc.name}
              </h3>
              <p className="text-xs text-muted-foreground">
                {doc.page_count} {doc.page_count === 1 ? "page" : "pages"} ·{" "}
                {formatBytes(doc.size_bytes)}
              </p>
              <p className="text-xs text-muted-foreground">
                Updated {formatDate(doc.updated_at)}
              </p>
              <div className="mt-4 flex gap-2">
                <Button asChild size="sm" className="flex-1">
                  <Link href={`/editor/${doc.id}`}>
                    <Pencil /> Edit
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleDelete(doc)}
                  aria-label="Delete"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

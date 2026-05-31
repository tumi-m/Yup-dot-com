"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getPageCount } from "@/lib/pdf/operations";
import { uuid } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Sends an uploaded PDF into the full editor. Editing relies on secure cloud
 * storage, so anonymous users are routed to sign up first.
 */
export function EditorLaunch() {
  const router = useRouter();
  const supabase = createClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/signup?redirect=/dashboard");
        return;
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const pageCount = await getPageCount(bytes);
      const docId = uuid();
      const storagePath = `${user.id}/${docId}.pdf`;

      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(storagePath, file, { contentType: "application/pdf" });
      if (upErr) throw upErr;

      const { error: insErr } = await supabase.from("documents").insert({
        id: docId,
        owner_id: user.id,
        name: file.name.replace(/\.pdf$/i, ""),
        storage_path: storagePath,
        size_bytes: file.size,
        page_count: pageCount,
      });
      if (insErr) throw insErr;

      router.push(`/editor/${docId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the editor.");
      setBusy(false);
    }
  }

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handleFile(e.dataTransfer.files);
      }}
      className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center transition-colors hover:border-primary"
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => handleFile(e.target.files)}
      />
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <UploadCloud className="h-6 w-6" />
      </div>
      <p className="mt-3 font-medium">Drop a PDF here to start editing</p>
      <Button className="mt-3" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Choose file
      </Button>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <p className="mt-3 text-xs text-muted-foreground">
        The editor saves to your secure library — a free account is required.
      </p>
    </div>
  );
}

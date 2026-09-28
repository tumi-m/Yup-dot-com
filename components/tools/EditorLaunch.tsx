"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import { UploadCloud, Loader2, FilePlus2 } from "lucide-react";
import { PDFDocument } from "pdf-lib";
import { tryCreateClient } from "@/lib/supabase/client";
import { getPageCount } from "@/lib/pdf/operations";
import { saveLocalDoc, takeHandoff, handoffToFile } from "@/lib/local-store";
import { limitsFor, type Tier } from "@/lib/limits";
import { uuid, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SPRING } from "@/components/motion/primitives";
import { UpgradeDialog } from "@/components/upsell/Upsell";

/**
 * Opens a PDF in the editor with no account required.
 * Signed-in users get the document in their cloud library; everyone else
 * edits on-device (IndexedDB), exactly like PDFescape's free online editor.
 */
export function EditorLaunch({ tier }: { tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [upsell, setUpsell] = useState(false);
  const limits = limitsFor(tier);

  async function openLocal(bytes: Uint8Array, name: string, pageCount: number) {
    const id = uuid();
    await saveLocalDoc({ id, name, bytes, pageCount, updatedAt: Date.now() });
    router.push(`/edit/${id}`);
  }

  async function openFile(file: File) {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setError("Please choose a PDF file.");
      return;
    }
    if (file.size > limits.maxFileBytes) {
      setUpsell(true);
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let pageCount: number;
      try {
        pageCount = await getPageCount(bytes);
      } catch {
        throw new Error("Couldn't open that PDF. It may be damaged or password-protected.");
      }

      const supabase = tryCreateClient();
      const user = supabase ? (await supabase.auth.getUser()).data.user : null;

      if (!supabase || !user) {
        await openLocal(bytes, file.name, pageCount);
        return;
      }

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

  async function blankDocument() {
    setBusy(true);
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]); // A4
    await openLocal(await doc.save(), "Untitled.pdf", 1);
  }

  // A file handed over from the homepage or another tool opens immediately.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((files) => files[0] && openFile(handoffToFile(files[0])))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <motion.div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) openFile(f);
        }}
        animate={{ scale: dragging ? 1.02 : 1 }}
        transition={SPRING}
        className={cn(
          "rounded-3xl border-2 border-dashed bg-card p-10 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/60"
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openFile(f);
            e.target.value = "";
          }}
        />
        <motion.div
          animate={busy ? { rotate: 360 } : { y: [0, -5, 0] }}
          transition={busy ? { duration: 1.1, repeat: Infinity, ease: "linear" } : { duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"
        >
          {busy ? <Loader2 className="h-7 w-7" /> : <UploadCloud className="h-7 w-7" />}
        </motion.div>
        <p className="mt-4 text-lg font-semibold">{busy ? "Opening the editor…" : "Drop a PDF to start editing"}</p>
        <div className="mt-4 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <Button onClick={() => inputRef.current?.click()} disabled={busy}>
            Choose PDF
          </Button>
          <Button variant="outline" onClick={blankDocument} disabled={busy}>
            <FilePlus2 /> Blank page
          </Button>
        </div>
      </motion.div>
      {error && (
        <p role="alert" data-testid="tool-error" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <UpgradeDialog open={upsell} onOpenChange={setUpsell} reason="file-size" tier={tier} />
    </div>
  );
}

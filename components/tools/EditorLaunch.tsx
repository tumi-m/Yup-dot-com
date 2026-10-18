"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence } from "motion/react";
import { FilePlus2 } from "lucide-react";
import { saveLocalDoc, takeHandoff, handoffToFile, STORE_FAILED } from "@/lib/local-store";
import { limitsFor, type Tier } from "@/lib/limits";
import { uuid } from "@/lib/utils";
import { isLoadError, loadErrorMessage } from "@/lib/load-error";
import { Button } from "@/components/ui/button";
import { ToolDropzone } from "@/components/ui/dropzone";
import { InlineError } from "@/components/motion/primitives";
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
        const { getPageCount } = await import("@/lib/pdf/operations");
        pageCount = await getPageCount(bytes);
      } catch (err) {
        if (isLoadError(err)) throw err;
        throw new Error("Couldn't open that PDF. It may be damaged or password-protected.");
      }

      const { tryCreateClient } = await import("@/lib/supabase/client");
      const supabase = tryCreateClient();
      const user = supabase ? (await supabase.auth.getUser()).data.user : null;

      if (!supabase || !user) {
        await openLocal(bytes, file.name, pageCount);
        return;
      }

      const docId = uuid();
      const storagePath = `${user.id}/${docId}.pdf`;
      // The row comes first: storage only accepts files that belong to a
      // document. If the cloud library is full (Free keeps 5), edit on-device.
      const { error: insErr } = await supabase.from("documents").insert({
        id: docId,
        owner_id: user.id,
        name: file.name.replace(/\.pdf$/i, ""),
        storage_path: storagePath,
        size_bytes: file.size,
        page_count: pageCount,
      });
      if (insErr) {
        await openLocal(bytes, file.name, pageCount);
        return;
      }
      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(storagePath, file, { contentType: "application/pdf" });
      if (upErr) {
        await supabase.from("documents").delete().eq("id", docId);
        throw upErr;
      }
      router.push(`/editor/${docId}`);
    } catch (err) {
      // The editor's code didn't arrive (offline): the file is fine.
      setError(isLoadError(err) ? loadErrorMessage("the editor") : err instanceof Error ? err.message : "Could not open the editor.");
      setBusy(false);
    }
  }

  async function blankDocument() {
    setError(null);
    setBusy(true);
    try {
      const { PDFDocument } = await import("pdf-lib");
      const doc = await PDFDocument.create();
      doc.addPage([595.28, 841.89]); // A4
      await openLocal(await doc.save(), "Untitled.pdf", 1);
    } catch (err) {
      setError(isLoadError(err) ? loadErrorMessage("the editor") : STORE_FAILED);
      setBusy(false);
    }
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
      <ToolDropzone
        label={busy ? "Opening the editor…" : "Drop a PDF to start editing"}
        dragLabel="Release to open"
        busy={busy}
        onFiles={(files) => files[0] && openFile(files[0])}
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
        <div className="mt-4 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <Button className="h-11" onClick={() => inputRef.current?.click()} disabled={busy}>
            Choose PDF
          </Button>
          <Button variant="outline" className="h-11" onClick={blankDocument} disabled={busy}>
            <FilePlus2 /> Blank page
          </Button>
        </div>
      </ToolDropzone>
      <AnimatePresence>{error && <InlineError key="error" message={error} />}</AnimatePresence>
      <UpgradeDialog open={upsell} onOpenChange={setUpsell} reason="file-size" tier={tier} />
    </div>
  );
}

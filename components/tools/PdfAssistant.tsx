"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, FileText, RotateCcw, Sparkles, Square, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolDropzone } from "@/components/ui/dropzone";
import { ENTER, ENTER_T, InlineError, SUCCESS, staggerDelay } from "@/components/motion/primitives";
import { scrollBehavior } from "@/components/motion/focus";
import { cn, formatBytes } from "@/lib/utils";
import { useSearchParams } from "next/navigation";
import type { Tier } from "@/lib/limits";
import { handoffToFile, takeHandoff } from "@/lib/local-store";
import { UpgradeDialog } from "@/components/upsell/Upsell";
import { trackToolUsed } from "@/lib/analytics";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface LoadedDoc {
  name: string;
  size: number;
  pages: number;
  text: string;
}

const SUGGESTIONS = [
  "Summarize",
  "Key numbers and dates",
  "Action items",
];

/** Minimal, safe Markdown: headings, bullets, numbered lists, bold, inline code. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-secondary px-1 py-0.5 text-[0.85em]">{p.slice(1, -1)}</code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  );
}

function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    out.push(
      <Tag key={out.length} className={cn("my-2 space-y-1 pl-5", list.ordered ? "list-decimal" : "list-disc")}>
        {list.items.map((it, i) => (
          <li key={i}><Inline text={it} /></li>
        ))}
      </Tag>
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flush();
    if (heading) {
      out.push(<p key={out.length} className="mt-3 font-semibold"><Inline text={heading[2]} /></p>);
    } else if (line.trim()) {
      out.push(<p key={out.length} className="my-1.5 leading-relaxed"><Inline text={line} /></p>);
    }
  }
  flush();
  return <>{out}</>;
}

export function PdfAssistant({ tier = "guest" }: { tier?: Tier }) {
  const params = useSearchParams();
  const [upsell, setUpsell] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [pagesRead, setPagesRead] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [parsing, setParsing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  /** The finished answer, read out once instead of word by word. */
  const [announce, setAnnounce] = useState("");
  const [error, setError] = useState<{ message: string; needsLogin?: boolean } | null>(null);

  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((files) => files[0] && loadFile(handoffToFile(files[0])))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Answers left today, shown before the first question.
  const docLoaded = !!doc;
  useEffect(() => {
    if (!docLoaded) return;
    let live = true;
    fetch("/api/ai/chat", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && typeof d?.remaining === "number") setRemaining(d.remaining);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [docLoaded]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: scrollBehavior() });
  }, [messages]);

  async function loadFile(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setError({ message: "Please choose a PDF file." });
      return;
    }
    setError(null);
    setParsing(true);
    try {
      const { parseDocument, toPagedText } = await import("@/lib/pdf/parse");
      const parsed = await parseDocument(new Uint8Array(await file.arrayBuffer()));
      if (parsed.likelyScanned) {
        setError({ message: "This PDF is a scan. Run OCR PDF first." });
        return;
      }
      setDoc({ name: file.name, size: file.size, pages: parsed.pageCount, text: toPagedText(parsed) });
      setMessages([]);
    } catch {
      setError({ message: "Couldn't read that PDF. It may be damaged or password-protected." });
    } finally {
      setParsing(false);
    }
  }

  async function ask(question: string) {
    if (!doc || !question.trim() || streaming) return;
    setError(null);
    const history: ChatMessage[] = [...messages, { role: "user", content: question.trim() }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setDraft("");
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setAnnounce("");
    let answer = "";

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentName: doc.name, documentText: doc.text, messages: history }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setMessages(history.slice(0, -1));
        setDraft(question);
        if (res.status === 429 && data.reason === "ai") {
          setRemaining(0);
          if (data.upgrade) {
            setUpsell(true);
            return;
          }
        }
        setError({ message: data.error ?? "Something went wrong.", needsLogin: res.status === 401 });
        return;
      }
      const left = res.headers.get("x-ai-remaining");
      if (left !== null) setRemaining(Number(left));
      setPagesRead(res.headers.get("x-ai-pages"));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line) as { type: string; text?: string; message?: string };
          if (event.type === "text" && event.text) {
            answer += event.text;
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = { role: "assistant", content: next[next.length - 1].content + event.text };
              return next;
            });
          } else if (event.type === "error") {
            setError({ message: event.message ?? "Something went wrong." });
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError({ message: "Connection lost. Please try again." });
    } finally {
      setStreaming(false);
      if (answer) {
        setAnnounce(answer.replace(/[*_`#>]+/g, ""));
        trackToolUsed("chat-with-pdf");
      }
      abortRef.current = null;
      // Drop an assistant bubble that never received text.
      setMessages((m) => (m.length && m[m.length - 1].role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m));
    }
  }

  if (!doc) {
    return (
      <div className="space-y-4">
        <ToolDropzone
          label={parsing ? "Reading your document…" : "Drop a PDF to start the conversation"}
          dragLabel="Release to open"
          busy={parsing}
          icon={Sparkles}
          tileClassName="bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-primary/30"
          onFiles={(files) => loadFile(files[0])}
        >
          <input ref={inputRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ""; }} />
          {!parsing && (
            <Button className="mt-4" onClick={() => inputRef.current?.click()}>
              <UploadCloud /> Choose PDF
            </Button>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            Only the PDF's text is sent to the AI.
          </p>
        </ToolDropzone>
        <AnimatePresence>{error && <InlineError key="error" message={error.message} />}</AnimatePresence>
      </div>
    );
  }

  return (
    <motion.div
      initial={ENTER.initial}
      animate={ENTER.animate}
      className="overflow-hidden rounded-3xl border border-border bg-card shadow-xl shadow-primary/5"
    >
      <div className="flex items-center gap-3 border-b border-border bg-secondary/40 px-5 py-3">
        <FileText className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{doc.name}</p>
          <p className="text-xs text-muted-foreground">
            {doc.pages} page{doc.pages === 1 ? "" : "s"} · {formatBytes(doc.size)}
            {pagesRead && (
              <span className="text-amber-700 dark:text-amber-400"> · reads pages 1–{pagesRead.split("/")[0]}</span>
            )}
          </p>
        </div>
        {remaining !== null && (
          <span data-testid="ai-remaining" className="shrink-0 rounded-full bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
            {remaining} left today
          </span>
        )}
        <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => { abortRef.current?.abort(); setDoc(null); setMessages([]); setError(null); setPagesRead(null); }}>
          <RotateCcw /> New PDF
        </Button>
      </div>

      <p className="sr-only" aria-live="polite">{announce}</p>
      <div
        ref={scrollRef}
        // Focusable so the conversation scrolls from the keyboard too.
        tabIndex={0}
        role="region"
        aria-label="Conversation"
        className="h-[460px] space-y-4 overflow-y-auto px-5 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="font-semibold">What would you like to know?</p>
            <p className="mt-1 text-sm text-muted-foreground">Answers cite the pages they come from.</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s, i) => (
                <motion.button
                  key={s}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...ENTER_T, delay: SUCCESS.title + staggerDelay(i) }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => ask(s)}
                  className="rounded-full border border-border bg-background px-3.5 py-1.5 text-sm transition-colors duration-200 hover:border-primary/50 hover:text-primary hover:duration-100"
                >
                  {s}
                </motion.button>
              ))}
            </div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={ENTER_T}
              className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
                  m.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-secondary"
                )}
              >
                <span className="sr-only">{m.role === "user" ? "You: " : "Assistant: "}</span>
                {m.role === "assistant" ? (
                  m.content ? (
                    <Markdown text={m.content} />
                  ) : (
                    <span className="flex gap-1 py-1.5" aria-label="Thinking">
                      {/* CSS, so the dots keep moving while the answer streams in. */}
                      {[0, 1, 2].map((d) => (
                        <span
                          key={d}
                          className="h-2 w-2 rounded-full bg-primary/60 motion-safe:animate-typing"
                          style={{ animationDelay: `${d * 0.15}s` }}
                        />
                      ))}
                    </span>
                  )
                ) : (
                  m.content
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {error && (
          <InlineError key="error" message={error.message} className="mx-5 mb-3 py-2.5">
            {error.needsLogin && (
              <Link href="/login?redirect=/tools/chat-with-pdf" className="font-semibold underline">Sign in</Link>
            )}
          </InlineError>
        )}
      </AnimatePresence>

      <form
        onSubmit={(e) => { e.preventDefault(); ask(draft); }}
        className="flex items-end gap-2 border-t border-border p-3"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); }
          }}
          rows={1}
          placeholder="Ask anything about this PDF…"
          aria-label="Your question"
          className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        {streaming ? (
          <Button type="button" size="icon" variant="outline" className="h-11 w-11" onClick={() => abortRef.current?.abort()} aria-label="Stop">
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="submit" size="icon" className="h-11 w-11" disabled={!draft.trim()} aria-label="Send">
            <ArrowUp />
          </Button>
        )}
      </form>
      <UpgradeDialog open={upsell} onOpenChange={setUpsell} reason="ai" tier={tier} returnTo="/tools/chat-with-pdf" />
    </motion.div>
  );
}

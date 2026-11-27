"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { LANGUAGES, languageByCode, pdfSupported, searchLanguages, type Language } from "@/lib/translate/languages";
import { cn } from "@/lib/utils";

/** "Detect automatically", offered as the source language. */
export const AUTO = "auto";

const label = (l: Language) => (l.native === l.name ? l.name : `${l.name} · ${l.native}`);

/**
 * A searchable language list: a text box that filters as you type (by
 * English name, the language's own name, other names or code), with the
 * matches in a list below it. Arrow keys move through the list, Enter
 * picks, Escape closes; it follows the ARIA combobox pattern, so a screen
 * reader names the option in reach.
 */
export function LanguagePicker({
  id,
  label: fieldLabel,
  hint,
  value,
  onChange,
  auto = false,
  inputRef,
  invalid = false,
  disabled = false,
}: {
  id: string;
  label: string;
  hint?: string;
  /** A language code, AUTO, or "" for none yet. */
  value: string;
  onChange: (code: string) => void;
  /** Offer "Detect automatically" first. */
  auto?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const listId = useId();
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const selected = value === AUTO ? null : languageByCode(value);
  const shown = selected ? label(selected) : value === AUTO && auto ? "Detect automatically" : "";
  const options = useMemo(() => {
    const found = searchLanguages(query, LANGUAGES);
    return auto && !query.trim() ? [null, ...found] : found;
  }, [query, auto]);
  const optionId = (i: number) => `${listId}-${i}`;

  function openList(from = "") {
    setQuery(from);
    setOpen(true);
    const current = options.findIndex((o) => (o ? o.code === value : value === AUTO));
    setActive(from ? 0 : Math.max(0, current));
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  function pick(option: Language | null) {
    onChange(option ? option.code : AUTO);
    close();
  }

  function move(to: number) {
    const i = Math.max(0, Math.min(options.length - 1, to));
    setActive(i);
    list.current?.querySelector(`#${CSS.escape(optionId(i))}`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Enter while an IME is composing (Japanese, Chinese, Korean) picks a candidate.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      move(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (open && (e.key === "PageDown" || e.key === "PageUp")) {
      e.preventDefault();
      move(active + (e.key === "PageDown" ? 8 : -8));
    } else if (open && (e.key === "Home" || e.key === "End") && !query) {
      e.preventDefault();
      move(e.key === "Home" ? 0 : options.length - 1);
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (options[active] !== undefined) pick(options[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  }

  const activeOption = open && options.length ? optionId(active) : undefined;

  return (
    <div className="relative min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {fieldLabel}
      </label>
      <div className="relative">
        <input
          ref={(el) => {
            if (typeof inputRef === "function") inputRef(el);
            else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
          }}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption}
          aria-describedby={hint ? hintId : undefined}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={open ? "Type to search" : auto ? "Detect automatically" : "Choose a language"}
          value={open ? query : shown}
          onChange={(e) => {
            // Typing over the chosen language searches for what was typed, not the name plus it.
            const typed = open ? e.target.value : e.target.value.replace(shown, "");
            setQuery(typed);
            setActive(0);
            if (!open) setOpen(true);
            list.current?.scrollTo({ top: 0 });
          }}
          onFocus={(e) => e.target.select()}
          onClick={() => (open ? close() : openList())}
          onKeyDown={onKeyDown}
          onBlur={close}
          className={cn(
            "h-11 w-full min-w-0 rounded-xl border bg-background pl-3.5 pr-10 text-sm outline-none transition-colors focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
            invalid ? "border-destructive" : "border-input"
          )}
        />
        <ChevronDown aria-hidden className={cn("pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
      </div>
      {hint && (
        <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label={fieldLabel}
        hidden={!open}
        className="absolute inset-x-0 z-30 mt-1.5 max-h-64 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-1 text-sm shadow-xl"
      >
        {open && !options.length && <li className="px-3 py-2.5 text-muted-foreground">No language matches “{query.trim()}”.</li>}
        {open &&
          options.map((option, i) => {
            const isSelected = option ? option.code === value : value === AUTO;
            return (
              <li
                key={option?.code ?? AUTO}
                id={optionId(i)}
                role="option"
                aria-selected={isSelected}
                // Picked on press, before the box loses focus and closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(option);
                }}
                onMouseMove={() => active !== i && setActive(i)}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 sm:min-h-9",
                  i === active && "bg-accent text-accent-foreground forced-colors:outline forced-colors:outline-2 forced-colors:-outline-offset-2 forced-colors:outline-[Highlight]"
                )}
              >
                <Check aria-hidden className={cn("h-4 w-4 shrink-0 text-primary", !isSelected && "invisible")} />
                {option ? (
                  <>
                    <span className="min-w-0 flex-1 truncate">
                      {option.name}
                      {option.native !== option.name && (
                        <span className="text-muted-foreground">
                          {" · "}
                          <bdi lang={option.code}>{option.native}</bdi>
                        </span>
                      )}
                    </span>
                    {!pdfSupported(option) && <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">Word only</span>}
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate">Detect automatically</span>
                )}
              </li>
            );
          })}
      </ul>
    </div>
  );
}

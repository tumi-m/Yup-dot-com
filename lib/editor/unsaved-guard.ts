"use client";

import { useEffect, useRef } from "react";

export const LEAVE_PROMPT = "Discard changes and leave?";

/** Marks the extra history entry that keeps Back on the page. */
const MARK = "__unsavedGuard";

export interface UnsavedGuard {
  /** Call whenever the dirty flag may have changed. */
  sync(): void;
  stop(): void;
}

/**
 * Asks before unsaved edits are thrown away. A tab close or reload fires
 * beforeunload. An in-app link and Back (a popstate) navigate without
 * unloading, so they are caught here. For Back, an extra entry for this page
 * sits on top of the history while there are edits: Back takes it off and the
 * page stays, so we can ask, then put it back or carry on back.
 */
export function guardUnsaved(win: Window, isDirty: () => boolean): UnsavedGuard {
  const { history, location } = win;
  const here = () => location.pathname + location.search;
  const marked = () => !!(history.state as Record<string, unknown> | null)?.[MARK];
  /** The page whose extra entry is the current one, or null. */
  let held: string | null = marked() ? here() : null;
  /** Going forward again to the extra entry after a "no". */
  let returning = false;
  let asking = false;

  const warn = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = "";
  };
  const onLink = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    const to = new URL(a.href, location.href);
    if (to.origin !== location.origin) return; // a full navigation: beforeunload asks
    if (to.pathname === location.pathname && to.search === location.search) return;
    if (!win.confirm(LEAVE_PROMPT)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const listen = (on: boolean) => {
    if (on === asking) return;
    asking = on;
    if (on) {
      win.addEventListener("beforeunload", warn);
      win.addEventListener("click", onLink, true);
    } else {
      win.removeEventListener("beforeunload", warn);
      win.removeEventListener("click", onLink, true);
    }
  };
  const onPop = () => {
    if (returning) {
      returning = false;
      held = here();
      return;
    }
    const from = held;
    held = marked() ? here() : null;
    if (from === null || held !== null || here() !== from) return;
    // Back took off the extra entry, so this page is still showing.
    if (isDirty() && !win.confirm(LEAVE_PROMPT)) {
      // Go forward to it again instead of adding a new one: Back skips
      // entries a page adds without a tap or click.
      returning = true;
      history.forward();
      return;
    }
    listen(false); // they said yes: don't ask again if Back leaves the site
    history.back();
  };
  win.addEventListener("popstate", onPop);

  const sync = () => {
    const dirty = isDirty();
    if (dirty && held === null && !returning) {
      history.pushState({ [MARK]: true }, "");
      held = here();
    }
    listen(dirty);
  };
  sync();
  return {
    sync,
    stop() {
      win.removeEventListener("popstate", onPop);
      listen(false);
    },
  };
}

/** Keeps a tab close, an in-app link or Back from losing unsaved edits. */
export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  const guard = useRef<UnsavedGuard | null>(null);
  useEffect(() => {
    const g = (guard.current = guardUnsaved(window, () => dirtyRef.current));
    return () => {
      g.stop();
      guard.current = null;
    };
  }, []);
  useEffect(() => {
    dirtyRef.current = dirty;
    guard.current?.sync();
  }, [dirty]);
}

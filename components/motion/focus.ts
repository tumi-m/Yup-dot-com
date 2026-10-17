"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Moves focus to the next state's element once it has rendered, without
 * letting the browser scroll to it mid-animation. The ring shows only for
 * keyboard users, as it would after a click.
 */
export function useFocusNext<K extends string>() {
  const next = useRef<K | null>(null);
  const keyboard = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.key === "Enter" || e.key === " ") keyboard.current = true;
    };
    const onPointer = () => (keyboard.current = false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);

  const focusRef = (key: K) => (el: HTMLElement | null) => {
    if (el && next.current === key) {
      next.current = null;
      el.focus({ preventScroll: true, focusVisible: keyboard.current } as FocusOptions);
    }
  };

  return { next, focusRef };
}

/**
 * True when a block that just appeared starts out of comfortable view: under
 * the sticky header (or above the screen), or low enough that its top half is
 * hidden.
 */
export function needsScrollIntoView(top: number, viewportHeight: number, header = 80): boolean {
  return top < header || top > viewportHeight * 0.4;
}

/** Smooth scrolling, unless the visitor asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** Brings a newly shown block into view, deliberately and once. */
export function scrollIntoViewIfNeeded(el: HTMLElement | null) {
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  if (!needsScrollIntoView(top, window.innerHeight)) return;
  el.scrollIntoView({ block: "start", behavior: scrollBehavior() });
}

/** The most a reserved block may take: most of a screen, never more. */
export const RESERVE_MAX = 0.85;

/**
 * The min-height that holds a block across a state swap: its current height,
 * at least `floor` of the screen, at most RESERVE_MAX of it.
 */
export function reservedHeight(current: number, viewportHeight: number, floor = 0): number {
  return Math.round(Math.min(Math.max(current, viewportHeight * floor), viewportHeight * RESERVE_MAX));
}

/**
 * How much of the screen to reserve for a success card: it stacks its buttons
 * on phones, so it needs more of a small screen than of a large one.
 */
export function resultFloor(): number {
  return window.innerWidth < 640 ? RESERVE_MAX : 0.7;
}

/**
 * Holds a container's height across a state swap, so the page below never
 * collapses for a frame and jumps back while one view leaves and the next
 * arrives. Reserve the space when the visitor acts (a click or key), because
 * a shift right after input isn't a layout shift; the result then fills the
 * space it was given when it arrives on its own later.
 */
export function useHeightLock<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
  /** `floor`: reserve at least this fraction of the screen. */
  const lock = useCallback((floor = 0) => {
    const el = ref.current;
    if (el) setMinHeight(reservedHeight(el.offsetHeight, window.innerHeight, floor));
  }, []);
  const release = useCallback(() => setMinHeight(undefined), []);
  return { ref, minHeight, lock, release };
}

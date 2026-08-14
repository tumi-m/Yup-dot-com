"use client";

import { useCallback, useRef, useState } from "react";

const LIMIT = 60;

/**
 * Undo/redo stack.
 *
 * Discrete actions (create, delete, property change) go through `commit`.
 * Continuous gestures (dragging, resizing, freehand) call `begin` once, then
 * `live` on every pointer move, then `end` — producing exactly one undo entry
 * for the whole gesture instead of one per frame.
 */
export function useHistory<T>(initial: T) {
  const [past, setPast] = useState<T[]>([]);
  const [present, setPresent] = useState<T>(initial);
  const [future, setFuture] = useState<T[]>([]);
  const pending = useRef<T | null>(null);

  const commit = useCallback((next: T | ((current: T) => T)) => {
    setPresent((current) => {
      const value =
        typeof next === "function" ? (next as (c: T) => T)(current) : next;
      if (Object.is(value, current)) return current;
      setPast((p) => [...p, current].slice(-LIMIT));
      setFuture([]);
      return value;
    });
  }, []);

  /** Update without recording history — use inside a begin/end gesture. */
  const live = useCallback((next: T | ((current: T) => T)) => {
    setPresent((current) =>
      typeof next === "function" ? (next as (c: T) => T)(current) : next
    );
  }, []);

  const begin = useCallback(() => {
    setPresent((current) => {
      pending.current = current;
      return current;
    });
  }, []);

  const end = useCallback(() => {
    const snapshot = pending.current;
    pending.current = null;
    if (snapshot === null) return;
    setPresent((current) => {
      if (!Object.is(snapshot, current)) {
        setPast((p) => [...p, snapshot].slice(-LIMIT));
        setFuture([]);
      }
      return current;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      const previous = p[p.length - 1];
      setPresent((current) => {
        setFuture((f) => [current, ...f].slice(0, LIMIT));
        return previous;
      });
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setPresent((current) => {
        setPast((p) => [...p, current].slice(-LIMIT));
        return next;
      });
      return f.slice(1);
    });
  }, []);

  /** Replace the value and clear history — used after a structural page op. */
  const reset = useCallback((value: T) => {
    setPast([]);
    setFuture([]);
    setPresent(value);
    pending.current = null;
  }, []);

  return {
    state: present,
    commit,
    live,
    begin,
    end,
    undo,
    redo,
    reset,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  };
}

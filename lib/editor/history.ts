"use client";

import { useCallback, useMemo, useReducer } from "react";

const LIMIT = 60;

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  /** Snapshot taken by `begin`, recorded as one entry by `end`. */
  pending: T | null;
}

export type HistoryAction<T> =
  | { type: "commit"; next: T | ((current: T) => T) }
  | { type: "live"; next: T | ((current: T) => T) }
  | { type: "begin" }
  | { type: "end" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; value: T };

const apply = <T,>(next: T | ((current: T) => T), current: T): T =>
  typeof next === "function" ? (next as (c: T) => T)(current) : next;

/**
 * Pure transition function. Every change goes through one state object, so
 * undo/redo can't drift out of step (nested setState calls inside updaters
 * did, e.g. when React replays updaters in development).
 */
export function historyReducer<T>(state: HistoryState<T>, action: HistoryAction<T>): HistoryState<T> {
  switch (action.type) {
    case "commit": {
      const value = apply(action.next, state.present);
      if (Object.is(value, state.present)) return state;
      return { past: [...state.past, state.present].slice(-LIMIT), present: value, future: [], pending: null };
    }
    case "live": {
      const value = apply(action.next, state.present);
      return Object.is(value, state.present) ? state : { ...state, present: value };
    }
    case "begin":
      return { ...state, pending: state.present };
    case "end": {
      if (state.pending === null) return state;
      if (Object.is(state.pending, state.present)) return { ...state, pending: null };
      return { past: [...state.past, state.pending].slice(-LIMIT), present: state.present, future: [], pending: null };
    }
    case "undo": {
      if (!state.past.length) return state;
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future].slice(0, LIMIT),
        pending: null,
      };
    }
    case "redo": {
      if (!state.future.length) return state;
      return {
        past: [...state.past, state.present].slice(-LIMIT),
        present: state.future[0],
        future: state.future.slice(1),
        pending: null,
      };
    }
    case "reset":
      return { past: [], present: action.value, future: [], pending: null };
  }
}

/**
 * Undo/redo stack.
 *
 * Discrete actions (create, delete, property change) go through `commit`.
 * Continuous gestures (dragging, resizing, freehand) call `begin` once, then
 * `live` on every pointer move, then `end` — producing exactly one undo entry
 * for the whole gesture instead of one per frame.
 */
export function useHistory<T>(initial: T) {
  const [state, dispatch] = useReducer(
    historyReducer as (s: HistoryState<T>, a: HistoryAction<T>) => HistoryState<T>,
    { past: [], present: initial, future: [], pending: null }
  );

  const commit = useCallback((next: T | ((current: T) => T)) => dispatch({ type: "commit", next }), []);
  /** Update without recording history — use inside a begin/end gesture. */
  const live = useCallback((next: T | ((current: T) => T)) => dispatch({ type: "live", next }), []);
  const begin = useCallback(() => dispatch({ type: "begin" }), []);
  const end = useCallback(() => dispatch({ type: "end" }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  /** Replace the value and clear history — used after a structural page op. */
  const reset = useCallback((value: T) => dispatch({ type: "reset", value }), []);

  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;
  return useMemo(
    () => ({ state: state.present, commit, live, begin, end, undo, redo, reset, canUndo, canRedo }),
    [state.present, commit, live, begin, end, undo, redo, reset, canUndo, canRedo]
  );
}

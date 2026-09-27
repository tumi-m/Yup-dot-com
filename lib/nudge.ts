"use client";

/**
 * Soft-nudge bookkeeping, stored per browser. Guests see one friendly
 * "create a free account" prompt after their third successful task of the
 * day — never before value, never more than once a day.
 */
const KEY = "pw-usage";
const NUDGE_AFTER = 3;

interface Usage {
  day: string;
  tasks: number;
  nudged: boolean;
  cardDismissed: boolean;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function read(): Usage {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) ?? "null") as Usage | null;
    if (u && u.day === today()) return u;
  } catch {
    /* storage unavailable or corrupt */
  }
  return { day: today(), tasks: 0, nudged: false, cardDismissed: false };
}

function write(u: Usage) {
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    /* private mode — nudges just won't persist */
  }
}

/** Records a completed task; returns true when the nudge should show now. */
export function recordTask(isGuest: boolean): boolean {
  const u = read();
  u.tasks += 1;
  const show = isGuest && !u.nudged && u.tasks >= NUDGE_AFTER;
  if (show) u.nudged = true;
  write(u);
  return show;
}

export function upsellCardDismissed(): boolean {
  return read().cardDismissed;
}

export function dismissUpsellCard() {
  const u = read();
  u.cardDismissed = true;
  write(u);
}

import "server-only";
import * as React from "react";
import secretScan from "./secret-scan.cjs";

type Taint = (message: string, lifetime: object, value: string) => void;

/**
 * Tells React never to send a server secret to the browser. With
 * experimental.taint on (next.config.ts), a page that passes one to a client
 * component, as a prop or inside one, fails to render instead of shipping it
 * in the HTML or RSC payload. That is the "data shipped with the page"
 * mistake, which the build checks can't see because pages render at request
 * time.
 *
 * Imported by app/layout.tsx, so it runs before any page renders. Only
 * whole values are matched: a secret pasted into a longer string isn't, so
 * code still never passes secrets to client components.
 */
export function taintServerSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const taint = (React as unknown as { experimental_taintUniqueValue?: Taint }).experimental_taintUniqueValue;
  if (typeof taint !== "function") return [];
  const tainted: string[] = [];
  for (const name of secretScan.SECRET_VARS) {
    const raw = env[name];
    if (!raw) continue;
    for (const value of new Set([raw, raw.trim()])) {
      if (value.length >= 8) taint(`${name} is a server secret and can't be sent to the browser.`, globalThis, value);
    }
    tainted.push(name);
  }
  return tainted;
}

taintServerSecrets();

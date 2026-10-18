/**
 * Loads .env files the way `next build` does (.env.production.local,
 * .env.local, .env.production, .env), so the build checks see the same
 * variables as the build. Variables already set (Vercel, CI) win.
 */
export function loadBuildEnv(dir = process.cwd()) {
  return import("@next/env")
    .then((m) => (m.loadEnvConfig ?? m.default?.loadEnvConfig)(dir, false, { info() {}, error() {} }))
    .catch(() => null);
}

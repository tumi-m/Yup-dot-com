/**
 * Preload for the browser check: NODE_OPTIONS="--require ./tests/fakes/samples-net.cjs"
 * before `next dev`. Patches globalThis.fetch so YouTube oEmbed, MusicBrainz
 * and TikTok get the canned answers in samples-routes.cjs; everything else
 * (the app's own localhost requests) goes through untouched. Nothing in the
 * app's code knows about it.
 */
(function () {
  if (typeof globalThis.fetch !== "function") return;
  const real = globalThis.fetch;
  const { route } = require("./samples-routes.cjs");
  globalThis.fetch = async function patched(input, init) {
    const canned = route(input instanceof URL ? input.href : input);
    return canned ?? real(input, init);
  };
})();

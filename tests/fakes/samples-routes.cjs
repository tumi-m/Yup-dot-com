/**
 * Canned answers for the hosts the Sample Finder calls (YouTube oEmbed,
 * MusicBrainz, TikTok), read from tests/fixtures. The MusicBrainz fixtures
 * are written to the shape of real ws/2 JSON with made-up ids; replace them
 * with captured answers when a machine that can reach musicbrainz.org is at
 * hand. No side effects: samples-net.cjs installs them as a fetch patch.
 */
const fs = require("node:fs");
const path = require("node:path");

const FIX = path.join(__dirname, "..", "fixtures");
const read = (p) => {
  const full = path.join(FIX, p);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
};
const json = (text, status = 200) => new Response(text, { status, headers: { "content-type": "application/json" } });

/** Every request the fakes answered, for tests that count them. */
const calls = [];

/** The answer for a URL, or null when it isn't one of ours. */
function route(input) {
  let url;
  try {
    url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  } catch {
    return null;
  }
  if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
    calls.push(url.href);
    let id = "";
    try {
      id = new URL(url.searchParams.get("url") ?? "").searchParams.get("v") ?? "";
    } catch {}
    if (id === "noEmbedVid1") return json('{"error":"Unauthorized"}', 401);
    const body = /^[\w-]{11}$/.test(id) ? read(`youtube/${id}.json`) : null;
    return body ? json(body) : new Response("Not Found", { status: 404 });
  }
  if (url.hostname === "musicbrainz.org" && url.pathname.startsWith("/ws/2/")) {
    calls.push(url.href);
    const lookup = /^\/ws\/2\/recording\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (lookup) {
      // Ids ending in ff…: any recording, with nothing connected (to use up a day's lookups).
      if (/^00000000-0000-4000-8000-00000000ff/.test(lookup[1])) {
        return json(JSON.stringify({ id: lookup[1], title: "A song", "artist-credit": [{ name: "Someone", joinphrase: "" }], relations: [] }));
      }
      const body = read(`musicbrainz/recording-${lookup[1]}.json`);
      return body ? json(body) : json('{"error":"Not Found"}', 404);
    }
    if (url.pathname === "/ws/2/recording") {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      // "Levels" stands in for MusicBrainz being overloaded: 503 every time.
      if (q.includes("levels")) return new Response("Service Unavailable", { status: 503 });
      const name = q.includes("etta")
        ? "search-etta"
        : q.includes("harder")
        ? "search-hbfs"
        : q.includes("hurt")
          ? "search-hurt"
          : q.includes("stronger") && q.includes("kanye")
            ? "search-stronger"
            : q.includes("stronger")
              ? "search-stronger-bare"
              : "search-empty";
      return json(read(`musicbrainz/${name}.json`));
    }
    return json('{"error":"Not Found"}', 404);
  }
  if (url.hostname === "www.tiktok.com") {
    calls.push(url.href);
    const id = /^\/@[\w.-]+\/video\/(\d+)$/.exec(url.pathname)?.[1];
    const body = id ? read(`tiktok/${id}.html`) : null;
    return body ? new Response(body, { status: 200, headers: { "content-type": "text/html" } }) : new Response("", { status: 404 });
  }
  return null;
}

module.exports = { route, calls };

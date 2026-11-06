/**
 * The Sample Finder's routes (lib/samples/handlers.ts) with fake YouTube,
 * TikTok and MusicBrainz (tests/fakes/samples-routes.cjs), counters in
 * memory and the cache in memory: input checks, playlist and private-video
 * messages, confidence bands, the daily allowance per plan, free re-picks,
 * refunds, cache-only share links, the kill switch and MusicBrainz busy.
 */
import { createRequire } from "node:module";
import { handleIdentify, handleLookup, ORIGINAL_SOUND_MESSAGE, PLAYLIST_MESSAGE, type SampleDeps } from "../lib/samples/handlers.ts";
import { Throttle, createMusicBrainz } from "../lib/samples/musicbrainz.ts";
import { memoryCache } from "../lib/samples/cache.ts";
import { memoryUsageStore, setUsageStore, type UsageStore } from "../lib/usage.ts";
import type { Tier } from "../lib/limits.ts";
import type { Identified, LookupResult } from "../lib/samples/types.ts";

process.env.MEDIA_SIGNING_SECRET ||= "test-signing-secret-for-sample-tickets";
const require = createRequire(import.meta.url);
const { route } = require("./fakes/samples-routes.cjs");

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const S = id("a001");

interface Rig {
  deps: SampleDeps;
  calls: string[];
  store: UsageStore;
  setTier: (t: Tier) => void;
}
/** A fresh world: its own counters, cache, network log and visitor. */
function rig(opts: { env?: NodeJS.ProcessEnv; answer?: (url: string) => Response | null; who?: string } = {}): Rig {
  let tier: Tier = "guest";
  const calls: string[] = [];
  const store = memoryUsageStore();
  setUsageStore(store);
  const fetcher = async (input: string) => {
    calls.push(input);
    const custom = opts.answer?.(input);
    if (custom) return custom;
    return (route(input) as Response | null) ?? new Response("", { status: 404 });
  };
  const mb = createMusicBrainz({ fetcher, sleep: async () => {}, throttle: new Throttle(Date.now, async () => {}, 0) });
  return {
    calls,
    store,
    setTier: (t) => (tier = t),
    deps: {
      resolveTier: async () => ({ user: tier === "guest" ? null : { id: "user-1" }, tier }),
      usageSubject: (_req, user) => (user ? `u:${user.id}` : (opts.who ?? "ip:test")),
      store,
      cache: memoryCache(),
      fetcher,
      mb,
      env: opts.env ?? {},
    },
  };
}
const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function identify(r: Rig, input: unknown) {
  const res = await handleIdentify(post("/api/samples/identify", { input }), r.deps);
  return { status: res.status, body: (await res.json()) as Identified & { error?: string; typeIt?: boolean } };
}
async function lookup(r: Rig, body: Record<string, unknown>) {
  const res = await handleLookup(post("/api/samples/lookup", body), r.deps);
  return { status: res.status, body: (await res.json()) as LookupResult & { error?: string; upgrade?: boolean; reason?: string } };
}
const mbCalls = (r: Rig) => r.calls.filter((u) => u.startsWith("https://musicbrainz.org/")).length;

// ---------- The routes refuse other sites ----------
{
  const evil = { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" };
  for (const path of ["identify", "lookup"]) {
    const mod = await import(`../app/api/samples/${path}/route.ts`);
    const res = await mod.POST(new Request(`http://localhost/api/samples/${path}`, { method: "POST", headers: evil, body: "{}" }));
    check(`/api/samples/${path}: cross-site refused`, res.status === 403);
    const text = await mod.POST(new Request(`http://localhost/api/samples/${path}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
    check(`/api/samples/${path}: a body that isn't JSON refused`, text.status === 403);
  }
}

// ---------- Input ----------
{
  const r = rig();
  check("no input → 400", (await identify(r, "")).status === 400 && (await identify(r, 42)).status === 400);
  check("too long → 400", (await identify(r, "x".repeat(600))).status === 400);
  const playlist = await identify(r, "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf");
  check("a playlist-only link → its own message", playlist.status === 400 && playlist.body.error === PLAYLIST_MESSAGE, playlist.body);
  const other = await identify(r, "https://x.com/someone/status/1234567890");
  check("an X link → what to paste instead", other.status === 400 && /YouTube or TikTok/.test(other.body.error ?? ""));
  const evil = await identify(r, "https://evil.example/watch?v=strongerVID");
  check("another host is never fetched", evil.status === 400 && r.calls.length === 0, r.calls);
  const symbols = await identify(r, "!!! ???");
  check("text with no words → 400", symbols.status === 400);
}

// ---------- YouTube ----------
{
  const r = rig();
  const { status, body } = await identify(r, "Check this out! https://youtu.be/strongerVID?si=abc");
  check("a YouTube link in share-sheet text → identified", status === 200 && body.source === "youtube" && body.pick?.title === "Stronger" && body.pick.artist === "Kanye West", body);
  check("…high confidence, picked", body.band === "high" && body.confidence >= 0.8 && body.pick?.mbid === S, body.confidence);
  check("…the video's title, channel and YouTube thumbnail", body.video?.title === "Kanye West - Stronger (Official Music Video)" && body.video.channel === "KanyeWestVEVO" && body.video.thumbnail?.startsWith("https://i.ytimg.com/"));
  check("…its canonical link, not what was pasted", body.video?.url === "https://www.youtube.com/watch?v=strongerVID");
  check("…hand-checked results straight away", body.catalog.some((c) => c.title === "Harder, Better, Faster, Stronger" && c.source === "catalog"));
  check("…a ticket for free re-picks", typeof body.ticket === "string" && body.ticket.length > 20);
  check("…one oEmbed call and one search", r.calls.filter((u) => u.includes("/oembed")).length === 1 && mbCalls(r) === 1, r.calls);
  check("oEmbed is asked for the canonical watch URL only", r.calls[0].startsWith("https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DstrongerVID&format=json"), r.calls[0]);
  const again = await identify(r, "https://www.youtube.com/watch?v=strongerVID");
  check("the same video again comes from the cache", again.status === 200 && r.calls.length === 2, r.calls.length);
}
{
  const r = rig();
  const priv = await identify(r, "https://youtu.be/privateVid1");
  check("a private or removed video (404) → message and Type it", priv.status === 422 && /private or was removed/.test(priv.body.error ?? "") && priv.body.typeIt === true, priv.body);
  const blocked = await identify(r, "https://youtu.be/noEmbedVid1");
  check("embedding off (401) → message and Type it", blocked.status === 422 && /won't share/.test(blocked.body.error ?? "") && blocked.body.typeIt === true, blocked.body);
  await identify(r, "https://youtu.be/privateVid1");
  check("a missing video is remembered (no second oEmbed call)", r.calls.filter((u) => u.includes("privateVid1")).length === 1);
}
{
  const r = rig({ answer: (u) => (u.includes("/oembed") ? new Response("", { status: 500 }) : null) });
  const down = await identify(r, "https://youtu.be/strongerVID");
  check("YouTube down → 502, try again or type it", down.status === 502 && down.body.typeIt === true);
}
{
  const r = rig();
  const { body } = await identify(r, "https://www.youtube.com/watch?v=lowConfVid1");
  check("a bare title from a random channel → low confidence, asks", body.band === "low" && body.candidates.length >= 2, { band: body.band, c: body.candidates.length });
}

// ---------- Typed ----------
{
  const r = rig();
  const { body } = await identify(r, "Kanye West – Stronger");
  check("typed Artist – Title → high", body.source === "text" && body.band === "high" && body.pick?.mbid === S, body.confidence);
  const bare = await identify(r, "Stronger");
  check("typed bare title matching two songs → low", bare.body.band === "low", bare.body.confidence);
  const free = await identify(r, "kanye west stronger");
  check("kanye west stronger → found by free text", free.body.candidates.some((c) => c.mbid === S), free.body.candidates);
}

// ---------- TikTok ----------
{
  const r = rig();
  const song = await identify(r, "https://www.tiktok.com/@liftsalot/video/7300000000000000001");
  check("a TikTok with a song → that song", song.status === 200 && song.body.source === "tiktok" && song.body.pick?.title === "Stronger" && song.body.video?.channel === "@liftsalot", song.body);
  check("…never more than medium on a sound's credit alone", song.body.parsed.confidence <= 0.6);
  const original = await identify(r, "https://www.tiktok.com/@catperson/video/7300000000000000002");
  check("a TikTok original sound → message", original.status === 422 && original.body.error === ORIGINAL_SOUND_MESSAGE && original.body.typeIt === true, original.body);
  const music = await identify(r, "https://www.tiktok.com/music/Stronger-Kanye-West-6814435937396410373");
  check("a tiktok.com/music/ link → searched from its words, no TikTok request", music.status === 200 && music.body.candidates.some((c) => c.mbid === S) && !r.calls.some((u) => u.includes("/music/")), music.body);
  check("…as a guess", music.body.parsed.confidence <= 0.2);
}

// ---------- Lookups and the daily allowance ----------
{
  const r = rig();
  const ident = (await identify(r, "Kanye West – Stronger")).body;
  const pick = ident.candidates[0];
  const before = mbCalls(r);
  const first = await lookup(r, { rec: pick.mbid, alt: pick.alt, artist: pick.artist, title: pick.title, ticket: ident.ticket });
  check("lookup: merged connections", first.status === 200 && first.body.mb === "ok" && first.body.counts.samples === 1, first.body);
  const row = first.body.relations.find((x) => x.title === "Harder, Better, Faster, Stronger");
  check("…the catalog row with MusicBrainz's id", row?.source === "catalog" && row.mbid === id("d001"), row);
  check("…listen link from MusicBrainz", first.body.listen === "https://www.youtube.com/watch?v=strongerVID");
  check("…one recording call (it has samples)", mbCalls(r) - before === 1, mbCalls(r) - before);
  check("…9 lookups left for a guest", first.body.remaining === 9, first.body.remaining);
  const other = ident.candidates[1];
  const repick = await lookup(r, { rec: other.mbid, artist: other.artist, title: other.title, ticket: ident.ticket });
  check("another pick for the same search is free", repick.status === 200 && repick.body.remaining === 9, repick.body.remaining);
  const again = await lookup(r, { rec: pick.mbid, artist: pick.artist, title: pick.title });
  check("the same song again comes from the cache, free", again.body.remaining === null && again.body.counts.samples === 1);
  const forged = await lookup(r, { rec: id("d001"), artist: "Daft Punk", title: "Harder, Better, Faster, Stronger", ticket: ident.ticket });
  check("a ticket doesn't make an unrelated song free", forged.body.remaining === 8, forged.body.remaining);
  const tampered = await lookup(r, { rec: id("c001"), artist: "Nine Inch Nails", title: "Hurt", ticket: ident.ticket!.replace(/.$/, (c) => (c === "A" ? "B" : "A")) });
  check("a tampered ticket counts as none", tampered.body.remaining === 7, tampered.body.remaining);
}
{
  const r = rig();
  // A recording with no samples or remixes: its alternative is tried once.
  const ident = (await identify(r, "Kanye West – Stronger")).body;
  const before = mbCalls(r);
  const res = await lookup(r, { rec: id("a003"), alt: [S], artist: "Kanye West", title: "Stronger", ticket: ident.ticket });
  check("no samples on the first recording → the second is tried", mbCalls(r) - before === 2 && res.body.counts.samples === 1, { calls: mbCalls(r) - before, counts: res.body.counts });
  const r2 = rig();
  const res2 = await lookup(r2, { rec: id("a003"), alt: [S], artist: "Kanye West", title: "Stronger" });
  check("…but only an alternative the search offered", mbCalls(r2) === 1 && res2.status === 200);
}
{
  // Any id is a recording here (with nothing connected), so every lookup counts.
  const r = rig({
    answer: (u) => {
      const m = /\/ws\/2\/recording\/([0-9a-f-]{36})\?/.exec(u);
      return m && m[1] !== S ? Response.json({ id: m[1], title: "A song", "artist-credit": [{ name: "Someone", joinphrase: "" }], relations: [] }) : null;
    },
  });
  const results: number[] = [];
  for (let i = 0; i < 11; i++) {
    const res = await lookup(r, { rec: id(`a1${String(i).padStart(2, "0")}`), artist: "Someone", title: `Song ${i}` });
    results.push(res.status);
  }
  const last = await lookup(r, { rec: id("a120"), artist: "Kanye West", title: "Stronger" });
  check("guest: 10 lookups, the 11th → 429", results.slice(0, 10).every((s) => s === 200) && results[10] === 429, results);
  check("…with the upgrade offer", last.status === 429 && last.body.upgrade === true && last.body.reason === "samples", last.body);
  check("…and the hand-checked results still there", last.body.relations.some((x) => x.source === "catalog" && x.title === "Harder, Better, Faster, Stronger"));
  r.setTier("pro");
  const pro = await lookup(r, { rec: id("a121"), artist: "x", title: "y" });
  check("Pro: 300 a day", pro.status === 200 && pro.body.remaining === 299, pro.body.remaining);
}
{
  const r = rig({ answer: (u) => (u.includes("/ws/2/recording/") ? new Response("", { status: 503 }) : null) });
  const res = await lookup(r, { rec: S, artist: "Kanye West", title: "Stronger" });
  check("MusicBrainz busy → hand-checked results, mb: busy", res.status === 200 && res.body.mb === "busy" && res.body.relations.length > 0, res.body);
  check("…and the lookup is given back", (await r.store.count("ip:test", "samples", "day")) === 0);
  check("…after one retry", mbCalls(r) === 2);
}
{
  const r = rig({ answer: (u) => (u.includes("/ws/2/") ? new Response("", { status: 503 }) : null) });
  const res = await identify(r, "Avicii – Levels");
  check("identify while MusicBrainz is busy → the reading and the hand-checked list", res.status === 200 && res.body.mb === "busy" && res.body.pick?.title === "Levels" && res.body.catalog.length > 0, res.body);
}
{
  const r = rig({ env: { SAMPLES_MB_DISABLED: "1" } });
  const ident = await identify(r, "Kanye West – Stronger");
  const res = await lookup(r, { rec: S, artist: "Kanye West", title: "Stronger" });
  check("kill switch → catalog only, nothing sent to MusicBrainz", ident.body.mb === "off" && res.body.mb === "off" && mbCalls(r) === 0 && res.body.relations.length > 0);
  check("…and nothing spent", (await r.store.count("ip:test", "samples", "day")) === 0);
}
{
  const r = rig();
  const miss = await lookup(r, { rec: S, artist: "Kanye West", title: "Stronger", cacheOnly: true });
  check("shared link, not cached → cached: false, catalog shown, nothing sent", miss.status === 200 && miss.body.cached === false && miss.body.relations.length > 0 && mbCalls(r) === 0);
  await lookup(r, { rec: S, artist: "Kanye West", title: "Stronger" });
  const spent = await r.store.count("ip:test", "samples", "day");
  const hit = await lookup(r, { rec: S, artist: "Kanye West", title: "Stronger", cacheOnly: true });
  check("shared link, cached → full answer", hit.body.cached === true && hit.body.listen !== null && hit.body.counts.samples === 1);
  check("…and nothing spent", (await r.store.count("ip:test", "samples", "day")) === spent);
}
{
  const r = rig();
  const res = await lookup(r, { artist: "Avicii", title: "Levels" });
  check("no MusicBrainz id → the hand-checked list, free", res.status === 200 && res.body.relations.length > 0 && res.body.remaining === null && mbCalls(r) === 0);
  const bad = await lookup(r, { rec: "../../etc", artist: "x", title: "y" });
  check("a malformed id → 400", bad.status === 400);
  const none = await lookup(r, { rec: id("beef"), artist: "x", title: "y" });
  check("an id MusicBrainz doesn't know → refunded", none.status === 200 && (await r.store.count("ip:test", "samples", "day")) === 0);
}
{
  const r = rig();
  let last = 200;
  for (let i = 0; i < 11; i++) last = (await identify(r, `Song number ${i}`)).status;
  check("searches: 10 a minute", last === 429);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);

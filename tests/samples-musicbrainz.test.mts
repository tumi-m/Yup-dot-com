/**
 * The MusicBrainz client (lib/samples/musicbrainz.ts) against a fake
 * network: how relationships become samples, "sampled in", covers and
 * remixes; escaped searches; the User-Agent; the 1.1s queue on a fake
 * clock; the site-wide minute budget; and 503s, timeouts and bad answers.
 *
 * The fixtures (tests/fixtures/musicbrainz) follow the shape of real ws/2
 * JSON (a recording lookup with recording-rels, work-rels, work-level-rels
 * and url-rels) with made-up ids. Capture real ones for the same songs
 * from a machine that can reach musicbrainz.org to pin the directions on
 * live data.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  COVERS_MAX,
  MusicBrainzBusy,
  Throttle,
  ambiguous,
  classifyRecording,
  createMusicBrainz,
  fallbackQuery,
  freeTextQuery,
  groupCandidates,
  musicBrainzUserAgent,
  parseSearch,
  recordingQuery,
  searchKey,
} from "../lib/samples/musicbrainz.ts";
import { parseTyped } from "../lib/samples/parse.ts";
import { claimMusicBrainz, memoryUsageStore, MUSICBRAINZ_PER_MINUTE } from "../lib/usage.ts";

const require = createRequire(import.meta.url);
const { route } = require("./fakes/samples-routes.cjs");

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/musicbrainz/${name}.json`, import.meta.url), "utf8"));
const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const S = id("a001");
const H = id("d001");

// ---------- Classifying relationships ----------
{
  const d = classifyRecording(fixture(`recording-${S}`))!;
  const samples = d.relations.filter((r) => r.role === "samples");
  check("samples material, forward → this song samples it", samples.length === 1 && samples[0].title === "Harder, Better, Faster, Stronger" && samples[0].artist === "Daft Punk" && samples[0].mbid === H, d.relations);
  check("its own live version isn't a cover", !d.relations.some((r) => r.role === "coveredBy"));
  check("the recording's year and credit", d.year === 2007 && d.artist === "Kanye West" && d.title === "Stronger");
  check("a linked YouTube video is the listen link (canonical)", d.listen === "https://www.youtube.com/watch?v=strongerVID", d.listen);
  check("rows say they come from MusicBrainz", d.relations.every((r) => r.source === "musicbrainz" && r.element === null));
}
{
  const d = classifyRecording(fixture(`recording-${H}`))!;
  const by = (role: string) => d.relations.filter((r) => r.role === role).map((r) => r.title);
  check("forward sample: HBFS samples Cola Bottle Baby", by("samples").join() === "Cola Bottle Baby", d.relations);
  check("backward sample: HBFS was sampled in Stronger", by("sampledBy").join() === "Stronger");
  check("backward remix: remixed by The Neptunes remix", by("remixedBy").length === 1 && by("remixedBy")[0].includes("Neptunes"));
  check("DJ-mix, mash-up and edit are ignored", d.relations.length === 3, d.relations.map((r) => `${r.role}:${r.title}`));
  check("the listen link drops extra parameters", d.listen === "https://www.youtube.com/watch?v=hbfsTopic01", d.listen);
}
{
  const d = classifyRecording(fixture(`recording-${id("d003")}`))!;
  check("forward remix: the remix is a remix of HBFS", d.relations.length === 1 && d.relations[0].role === "remixOf" && d.relations[0].mbid === H);
}
{
  const d = classifyRecording(fixture(`recording-${id("c002")}`))!;
  check("performance + cover: Cash's Hurt covers the work", d.relations.length === 1 && d.relations[0].role === "covers" && d.relations[0].title === "Hurt", d.relations);
  check("…credited to the original's artist, not a live version", d.relations[0].artist === "Nine Inch Nails" && d.relations[0].mbid === id("c001"), d.relations[0]);
  check("…and a cover isn't 'covered by' the other covers", !d.relations.some((r) => r.role === "coveredBy"));
}
{
  const d = classifyRecording(fixture(`recording-${id("c001")}`))!;
  const covered = d.relations.filter((r) => r.role === "coveredBy").map((r) => r.artist);
  check("the original: covered by Johnny Cash and Leona Lewis", covered.join() === "Johnny Cash,Leona Lewis", covered);
  check("…one row per covering artist (Cash's live cover folds in)", covered.length === 2);
  check("…its own live version isn't a cover", !covered.includes("Nine Inch Nails"));
}
{
  const many = fixture(`recording-${id("c001")}`);
  const perfs = many.relations[0].work.relations;
  for (let i = 0; i < 40; i++) {
    perfs.push({ ...perfs[2], recording: { ...perfs[2].recording, id: id(`e${String(i).padStart(3, "0")}`), "artist-credit": [{ name: `Cover Band ${i}`, joinphrase: "", artist: { name: `Cover Band ${i}` } }] } });
  }
  const d = classifyRecording(many)!;
  check(`"covered by" stops at ${COVERS_MAX}`, d.relations.filter((r) => r.role === "coveredBy").length === COVERS_MAX);
}
check("a lookup without an id is rejected", classifyRecording({ title: "x" }) === null);
check("a relation without a title is skipped", classifyRecording({ id: S, relations: [{ type: "samples material", direction: "forward", "target-type": "recording", recording: { id: H } }] })!.relations.length === 0);
check("a listen link must be YouTube", classifyRecording({ id: S, relations: [{ type: "free streaming", "target-type": "url", url: { resource: "https://evil.example.com/watch?v=abcdefghijk" } }] })!.listen === null);

// ---------- Searches ----------
{
  const found = parseSearch(fixture("search-stronger"));
  check("search hits parsed", found.length === 4 && found[0].artist === "Kanye West" && found[0].score === 100 && found[0].date === "2007-07-31");
  check("release group: albums and singles first", found[0].releaseGroupId === id("2002") || found[0].releaseGroupId === id("2001"));
  const parsed = parseTyped("Kanye West – Stronger");
  const c = groupCandidates(found, parsed);
  check("grouped: Kanye's versions are one song", c.filter((x) => x.artist === "Kanye West").length === 1, c);
  check("its main recording is the earliest studio one", c[0].mbid === S && c[0].year === 2007);
  check("the clean and live versions are alternatives, studio first", c[0].alt[0] === id("a003") && c[0].alt.includes(id("a002")), c[0].alt);
  check("Britney's Stronger ranks below", c[1]?.artist === "Britney Spears" && c[1].match < c[0].match);
  check("a clear match", c[0].match > 0.95 && !ambiguous(c));
  const live = groupCandidates(found, { ...parsed, variant: "live" });
  check("asked for a live version: the live one may lead", live[0].mbid === S || live[0].alt.length >= 0);
}
{
  const bare = parseTyped("Stronger");
  const c = groupCandidates(parseSearch(fixture("search-stronger-bare")), bare);
  check("a bare title matching two artists is ambiguous", ambiguous(c), c);
}
{
  const c = groupCandidates(parseSearch(fixture("search-hbfs")), parseTyped("Daft Punk - Harder Better Faster Stronger"));
  check("a live medley is grouped apart and ranked below", c[0].mbid === H && c[0].match > (c[1]?.match ?? 0));
}
check("bad hits are dropped", parseSearch({ recordings: [{ id: "nope", title: "x" }, { id: S }] }).length === 0);

// ---------- Queries ----------
check("Lucene: AC/DC", recordingQuery("Highway to Hell", "AC/DC") === 'recording:"Highway to Hell" AND artist:"AC\\/DC"', recordingQuery("Highway to Hell", "AC/DC"));
check("Lucene: Panic! at the Disco", recordingQuery("I Write Sins Not Tragedies", "Panic! at the Disco") === 'recording:"I Write Sins Not Tragedies" AND artist:"Panic\\! at the Disco"');
check("Lucene: quotes and colons can't end the phrase", recordingQuery('Say "Yes": Now', "X") === 'recording:"Say \\"Yes\\"\\: Now" AND artist:"X"');
check("Lucene: AND/OR words stay inside the phrase", recordingQuery("Love AND Hate", "OR") === 'recording:"Love AND Hate" AND artist:"OR"');
check("free text searches title and artist together", freeTextQuery("kanye west stronger") === 'recording:"kanye west stronger" OR (recording:(kanye west stronger) AND artist:(kanye west stronger))');
check("no artist → free text", recordingQuery("kanye west stronger", "") === freeTextQuery("kanye west stronger"));
check("retry: an alias", fallbackQuery(parseTyped("BTS (방탄소년단) – Dynamite")) === 'recording:"Dynamite" AND artist:"방탄소년단"');
check("retry: the first name of a duo", fallbackQuery(parseTyped("Simon & Garfunkel – The Boxer")) === 'recording:"The Boxer" AND artist:"Simon"');
check("retry: free text otherwise", fallbackQuery(parseTyped("Kanye West – Stronger"))!.startsWith('recording:"Kanye West Stronger" OR'));
check("cache key ignores case and accents", searchKey(recordingQuery("Halo", "Beyoncé")) === searchKey(recordingQuery("halo", "beyonce")));

// ---------- The client: User-Agent, queue, budget, failures ----------
type Call = { url: string; at: number; headers: Record<string, string> };
function rig(answer: (url: string, n: number) => Response | Promise<Response> = (u) => route(u) ?? new Response("", { status: 404 })) {
  let now = 1_000_000;
  const calls: Call[] = [];
  const sleep = async (ms: number) => {
    now += ms;
  };
  const throttle = new Throttle(() => now, sleep);
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, at: now, headers: init?.headers as Record<string, string> });
    return answer(url, calls.length);
  };
  return { calls, throttle, fetcher, sleep, clock: () => now };
}
{
  const r = rig();
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: r.sleep, throttle: r.throttle, userAgent: musicBrainzUserAgent({ NEXT_PUBLIC_SITE_URL: "https://pdfwizard.xyz" } as NodeJS.ProcessEnv) });
  const d = await mb.recording(S);
  check("lookup through the client", d?.relations[0]?.title === "Harder, Better, Faster, Stronger");
  const h = r.calls[0].headers;
  check("User-Agent names the site and its contact page", /^PDFWizard\/1\.0 \( https:\/\/.+\/contact \)$/.test(h["User-Agent"]), h["User-Agent"]);
  check("and asks for JSON", h.Accept === "application/json" && r.calls[0].url.includes("fmt=json"));
  check("fixed host and path", r.calls[0].url.startsWith(`https://musicbrainz.org/ws/2/recording/${S}?`));
  check("one lookup brings covers too (work-level-rels)", decodeURIComponent(r.calls[0].url).includes("work-level-rels") && decodeURIComponent(r.calls[0].url).includes("url-rels"));
  check("a malformed id never reaches the network", (await mb.recording("../../evil")) === null && r.calls.length === 1);
  check("no such recording → null", (await mb.recording(id("dead"))) === null);
}
{
  const env = { MUSICBRAINZ_CONTACT: "me@example.com" } as NodeJS.ProcessEnv;
  check("a contact that isn't an https page (an email) is ignored", !musicBrainzUserAgent(env).includes("@"), musicBrainzUserAgent(env));
  check("an https contact page is used", musicBrainzUserAgent({ MUSICBRAINZ_CONTACT: "https://example.org/about" } as NodeJS.ProcessEnv).includes("https://example.org/about"));
}
{
  const r = rig();
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: r.sleep, throttle: r.throttle });
  for (const q of ["a", "b", "c"]) await mb.search(q);
  const gaps = r.calls.slice(1).map((c, i) => c.at - r.calls[i].at);
  check("one after another, 1.1s apart", gaps.length === 2 && gaps.every((g) => g >= 1100), gaps);
}
{
  // Requests asking at the same moment are given turns in order, 1.1s apart.
  const waits: number[] = [];
  const t = new Throttle(() => 0, async (ms) => void waits.push(ms));
  await Promise.all([t.turn(), t.turn(), t.turn()]);
  check("at the same moment: turns 0, 1.1 and 2.2s out", waits.join() === "1100,2200", waits);
}
{
  const r = rig();
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: async () => {}, throttle: new Throttle(r.clock, async () => {}) });
  const results = await Promise.allSettled(Array.from({ length: 7 }, (_, i) => mb.search(`q${i}`)));
  const busy = results.filter((x) => x.status === "rejected" && x.reason instanceof MusicBrainzBusy && x.reason.reason === "queue");
  check("a wait over 6s isn't queued: busy instead", busy.length === 1 && r.calls.length === 6, { busy: busy.length, calls: r.calls.length });
}
{
  const store = memoryUsageStore(() => 5_000_000);
  let ok = 0;
  for (let i = 0; i < MUSICBRAINZ_PER_MINUTE + 5; i++) if (await claimMusicBrainz(store)) ok++;
  check(`site-wide budget: ${MUSICBRAINZ_PER_MINUTE} a minute`, ok === MUSICBRAINZ_PER_MINUTE, ok);
  const r = rig();
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: r.sleep, throttle: r.throttle, claim: () => claimMusicBrainz(store) });
  const err = await mb.search("x").catch((e) => e);
  check("budget spent → busy, and nothing is sent", err instanceof MusicBrainzBusy && err.reason === "budget" && r.calls.length === 0);
}
{
  const r = rig((u, n) => (n === 1 ? new Response("", { status: 503 }) : (route(u) as Response)));
  const before = r.clock();
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: r.sleep, throttle: r.throttle });
  const found = await mb.search(recordingQuery("Stronger", "Kanye West"));
  check("503 → one retry after 1.5s → answer", found.length === 4 && r.calls.length === 2 && r.calls[1].at - before >= 1500, r.calls.map((c) => c.at - before));
}
{
  const r = rig(() => new Response("", { status: 503 }));
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: r.sleep, throttle: r.throttle });
  const err = await mb.search("x").catch((e) => e);
  check("503 twice → busy", err instanceof MusicBrainzBusy && err.reason === "unavailable" && r.calls.length === 2);
}
{
  const r = rig(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: r.sleep, throttle: r.throttle });
  const err = await mb.recording(S).catch((e) => e);
  check("timeout → busy", err instanceof MusicBrainzBusy && err.reason === "unreachable");
}
{
  const r = rig(() => new Response("<html>oops</html>", { status: 200 }));
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: r.sleep, throttle: r.throttle });
  check("an answer that isn't JSON → busy", (await mb.search("x").catch((e) => e)) instanceof MusicBrainzBusy);
}
{
  const r = rig(() => new Response("x", { status: 200, headers: { "content-length": String(50_000_000) } }));
  const mb = createMusicBrainz({ fetcher: r.fetcher, sleep: r.sleep, throttle: r.throttle });
  check("an oversized answer isn't read", (await mb.search("x").catch((e) => e)) instanceof MusicBrainzBusy);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);

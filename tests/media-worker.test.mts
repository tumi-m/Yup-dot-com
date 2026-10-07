/**
 * End-to-end test of media-worker/worker.py with tokens signed by the web
 * app's own signer (lib/media.ts), so the TS <-> Python contract is checked.
 *
 * Instead of YouTube, it serves a local DASH stream with the same shape as
 * YouTube HD: separate 1080p/720p/360p video tracks plus a separate audio
 * track, so choosing a height and merging audio+video with ffmpeg are both
 * exercised.
 *
 * Playlists: yt-dlp's generic extractor reads an RSS feed as a playlist whose
 * items are unresolved links, the same shape YouTube playlists take with
 * extract_flat. Serving feeds locally proves /playlist lists titles,
 * durations and thumbnails, caps long lists and flags the cut, rejects
 * non-playlists, maps errors, and never fetches a single media file.
 * Needs python3 with yt-dlp, and ffmpeg (FFMPEG env or on PATH):
 *   npm run test:media
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { signToken } from "../lib/media-server.ts";
const signMediaToken = async (p: Record<string, unknown>, secret: string, ttl?: number) => signToken(p, secret, ttl);

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const SECRET = "test-secret-" + Math.random().toString(36).slice(2);
const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

// 1. Fixture: multi-quality DASH stream.
const dir = mkdtempSync(join(tmpdir(), "pw-dash-"));
execFileSync(FFMPEG, [
  "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3",
  "-map", "0:v", "-map", "0:v", "-map", "0:v", "-map", "1:a",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
  "-s:v:0", "1920x1080", "-s:v:1", "1280x720", "-s:v:2", "640x360",
  "-adaptation_sets", "id=0,streams=v id=1,streams=a",
  "-f", "dash", join(dir, "manifest.mpd"),
]);

// Portrait (YouTube Shorts): 1080x1920, 720x1280 and 360x640. "720p" is the short side.
const vdir = mkdtempSync(join(tmpdir(), "pw-dash-v-"));
execFileSync(FFMPEG, [
  "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=25",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2",
  "-map", "0:v", "-map", "0:v", "-map", "0:v", "-map", "1:a",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
  "-s:v:0", "1080x1920", "-s:v:1", "720x1280", "-s:v:2", "360x640",
  "-adaptation_sets", "id=0,streams=v id=1,streams=a",
  "-f", "dash", join(vdir, "manifest.mpd"),
]);
const CJK_TITLE = "星の魔法 — ночь";

// 2. Serve it, plus RSS "playlists" whose items point at /media/ files that
// must never be requested.
function feed(title: string, n: number) {
  const items = Array.from({ length: n }, (_, i) =>
    `<item><title>Spell ${i + 1} &amp; more</title><enclosure url="/media/${i + 1}.mp4" type="video/mp4"/>` +
    `<itunes:duration>${i + 1}:0${i % 10}</itunes:duration><itunes:image href="https://img.test/${i + 1}.jpg"/></item>`
  ).join("");
  return `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">` +
    `<channel><title>${title}</title><link>https://example.test</link>${items}</channel></rss>`;
}
let mediaHits = 0;
const fixture = createServer(async (req, res) => {
  let reqPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  // The generic extractor titles a manifest after its file name.
  if (reqPath === `/${CJK_TITLE}.mpd`) reqPath = "/manifest.mpd";
  let base = dir;
  if (reqPath.startsWith("/vert/")) {
    base = vdir;
    reqPath = reqPath.slice(5);
  } else if (reqPath.startsWith("/slow/")) {
    // Slow segments, so a job can be cancelled while it runs.
    reqPath = reqPath.slice(5);
    if (reqPath.endsWith(".m4s")) await new Promise((r) => setTimeout(r, 1500));
  }
  if (reqPath.startsWith("/media/")) {
    mediaHits++;
    return res.writeHead(404).end();
  }
  const feeds: Record<string, string> = { "/short.xml": feed("Short list", 3), "/long.xml": feed("Long list", 205) };
  if (feeds[reqPath]) return res.writeHead(200, { "Content-Type": "application/rss+xml" }).end(feeds[reqPath]);
  const path = join(base, reqPath);
  if (!path.startsWith(base) || !existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": extname(path) === ".mpd" ? "application/dash+xml" : "video/iso.segment" });
  createReadStream(path).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => fixture.once("listening", r));
const fixturePort = (fixture.address() as { port: number }).port;
const MPD = `http://127.0.0.1:${fixturePort}/manifest.mpd`;

// 3. Start the worker.
const workerPort = 18000 + Math.floor(Math.random() * 1000);
const worker: ChildProcess = spawn("python3", ["media-worker/worker.py"], {
  env: {
    ...process.env,
    PORT: String(workerPort),
    MEDIA_WORKER_SECRET: SECRET,
    MEDIA_TEST_HOSTS: "127.0.0.1",
    ...(process.env.FFMPEG ? { FFMPEG_LOCATION: process.env.FFMPEG } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
worker.stderr?.on("data", (d) => process.stderr.write(`[worker] ${d}`));
const W = `http://127.0.0.1:${workerPort}`;
for (let i = 0; i < 50; i++) {
  if (await fetch(`${W}/health`).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}

function probeSize(file: string) {
  let out = "";
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    out = String((e as { stderr?: Buffer }).stderr ?? "");
  }
  return out.match(/Video: .*?, (\d{3,4}x\d{3,4})/)?.[1] ?? null;
}

function probe(file: string) {
  // ffmpeg exits non-zero without an output; its stderr still describes the streams.
  let out = "";
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    out = String((e as { stderr?: Buffer }).stderr ?? "");
  }
  const video = out.match(/Video: (\w+).*?, (\d{3,4})x(\d{3,4})/);
  return {
    videoCodec: video?.[1] ?? null,
    height: video ? Number(video[3]) : null,
    audio: out.match(/Audio: (\w+)/)?.[1] ?? null,
    container: out.match(/Input #0, ([\w,]+)/)?.[1] ?? null,
  };
}

async function runJob(token: string) {
  const created = await fetch(`${W}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.test" },
    body: JSON.stringify({ token }),
  });
  if (created.status !== 202) return { status: created.status, body: await created.json() };
  const { id } = await created.json();
  let s: Record<string, unknown> = {};
  const progress: number[] = [];
  const stages: string[] = [];
  for (let i = 0; i < 400; i++) {
    s = await (await fetch(`${W}/jobs/${id}`)).json();
    progress.push(Number(s.progress ?? 0));
    if (stages.at(-1) !== s.stage) stages.push(String(s.stage));
    if (s.status !== "working") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (s.status !== "ready") return { status: 500, body: s };
  const res = await fetch(`${W}/jobs/${id}/file`);
  const out = join(dir, `out-${id}${String(s.filename).endsWith(".mp3") ? ".mp3" : ".mp4"}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return { id, status: 200, body: s, file: out, disposition: res.headers.get("content-disposition"), progress, stages };
}

try {
  // Downloads at each quality: correct height, H.264 video, merged audio, MP4.
  for (const h of [1080, 720, 360]) {
    const r = await runJob(await signMediaToken({ u: MPD, k: "mp4", h }, SECRET));
    const p = r.file ? probe(r.file) : null;
    check(
      `${h}p MP4: right height, H.264 + audio merged`,
      !!p && p.height === h && p.videoCodec === "h264" && p.audio === "aac" && !!p.container?.includes("mp4"),
      p ? `${p.height}p ${p.videoCodec}+${p.audio} ${p.container}` : JSON.stringify(r.body)
    );
  }

  // Asking for 480p when the source has 360/720/1080 must not exceed 480.
  const r480 = await runJob(await signMediaToken({ u: MPD, k: "mp4", h: 480 }, SECRET));
  check("480p request never exceeds 480 (gets 360)", r480.file ? probe(r480.file).height === 360 : false);

  // Portrait: quality is the short side, so 720p of a Short is 720x1280, not 360x640.
  const VMPD = `http://127.0.0.1:${fixturePort}/vert/manifest.mpd`;
  for (const [h, want] of [[720, "720x1280"], [1080, "1080x1920"], [480, "360x640"]] as const) {
    const r = await runJob(await signMediaToken({ u: VMPD, k: "mp4", h }, SECRET));
    const size = r.file ? probeSize(r.file) : null;
    check(`portrait ${h}p → ${want}`, size === want, size ?? JSON.stringify(r.body));
  }
  const vinfo = await fetch(`${W}/info`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: VMPD }),
  }).then((r) => r.json());
  check("/info reports portrait heights by the short side", JSON.stringify(vinfo.heights) === "[360,720,1080]", JSON.stringify(vinfo.heights));

  // Non-Latin titles keep their name (yt-dlp's restrictfilenames made them "_.mp4").
  const cjk = await runJob(await signMediaToken({ u: `http://127.0.0.1:${fixturePort}/${encodeURIComponent(CJK_TITLE)}.mpd`, k: "mp4", h: 360 }, SECRET));
  check("CJK/Cyrillic title kept as the file name", cjk.body.filename === `${CJK_TITLE}.mp4`, String(cjk.body.filename));
  check(
    "Content-Disposition carries the UTF-8 name and an ASCII fallback",
    !!cjk.disposition?.includes(`filename*=UTF-8''${encodeURIComponent(CJK_TITLE).replace(/%20/g, "%20")}.mp4`) &&
      /filename="download\.mp4"/.test(cjk.disposition ?? ""),
    cjk.disposition ?? ""
  );

  // Progress never runs backwards, and "processing" only starts after the downloads.
  const merged = await runJob(await signMediaToken({ u: MPD, k: "mp4", h: 720 }, SECRET));
  const monotonic = (merged.progress ?? []).every((p, i, a) => i === 0 || p >= a[i - 1]);
  check("progress is monotonic across video + audio streams", monotonic, (merged.progress ?? []).map((p) => p.toFixed(2)).join(" "));
  // Merging can be too quick to see, but the order must hold.
  const order = ["queued", "downloading", "processing", "ready"];
  const seen = (merged.stages ?? []).map((s) => order.indexOf(s));
  check("stages only move forward (downloading → processing → ready)", seen.every((x, i) => x >= 0 && (i === 0 || x > seen[i - 1])) && seen.at(-1) === 3, JSON.stringify(merged.stages));

  // MP3 extraction.
  const mp3 = await runJob(await signMediaToken({ u: MPD, k: "mp3", h: 0 }, SECRET));
  const pm = mp3.file ? probe(mp3.file) : null;
  check("MP3: audio only, mp3 codec", !!pm && pm.audio === "mp3" && pm.height === null, pm ? `${pm.audio}` : JSON.stringify(mp3.body));
  check("attachment filename header", !!mp3.disposition?.startsWith("attachment;"), mp3.disposition ?? "");

  // Security.
  const good = await signMediaToken({ u: MPD, k: "mp4", h: 720 }, SECRET);
  const [body, sig] = good.split(".");
  const tampered = Buffer.from(JSON.stringify({ u: MPD, k: "mp4", h: 1080, e: 9e9 })).toString("base64url") + "." + sig;
  check("tampered token (720p → 1080p) rejected", (await runJob(tampered)).status === 401);
  const wrong = await runJob(await signMediaToken({ u: MPD, k: "mp4", h: 720 }, "wrong"));
  check("token signed with wrong secret rejected as bad-signature", wrong.status === 401 && wrong.body.code === "bad-signature", JSON.stringify(wrong.body));
  const expired = await runJob(await signMediaToken({ u: MPD, k: "mp4", h: 720 }, SECRET, -5));
  check("expired token rejected as expired", expired.status === 401 && expired.body.code === "expired", JSON.stringify(expired.body));

  // One grant, one job; /refs tells the web app whether a grant was used (for refunds).
  const refs = (c: string, auth = `Bearer ${SECRET}`) =>
    fetch(`${W}/refs/${c}`, { headers: { Authorization: auth } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const once = await signMediaToken({ u: MPD, k: "mp3", h: 0, c: "grant-once-0001" }, SECRET);
  const first = await runJob(once);
  const again = await runJob(once);
  check("a grant runs one job only", first.status === 200 && again.status === 409 && again.body.code === "used", JSON.stringify(again.body));
  const used = await refs("grant-once-0001");
  check("/refs: used grant reports its job's status", used.status === 200 && used.body.used === true && used.body.status === "ready", JSON.stringify(used.body));
  const unused = await refs("grant-never-001");
  check("/refs: unknown grant is unused", unused.status === 404 && unused.body.used === false, JSON.stringify(unused.body));
  check("/refs requires the shared secret", (await refs("grant-once-0001", "Bearer wrong")).status === 401);

  // A ready file answers HEAD (the app checks before saving it again); a gone one 404s.
  const head = await fetch(`${W}/jobs/${first.id}/file`, { method: "HEAD" });
  check("HEAD on a ready file → 200 with its size", head.status === 200 && Number(head.headers.get("content-length")) > 0, String(head.status));
  check("HEAD on an unknown file → 404", (await fetch(`${W}/jobs/aaaaaaaaaaaaaaaaaaaaaaaa/file`, { method: "HEAD" })).status === 404);

  // Cancel: DELETE stops a running job, its grant reads as failed, and the file never appears.
  const slow = await fetch(`${W}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: await signMediaToken({ u: `http://127.0.0.1:${fixturePort}/slow/manifest.mpd`, k: "mp4", h: 720, c: "grant-cancel-01" }, SECRET) }),
  }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 700));
  const del = await fetch(`${W}/jobs/${slow.id}`, { method: "DELETE" });
  const right = await (await fetch(`${W}/jobs/${slow.id}`)).json();
  await new Promise((r) => setTimeout(r, 4500));
  const later = await (await fetch(`${W}/jobs/${slow.id}`)).json();
  check("DELETE cancels a running job", del.status === 200 && right.status === "error" && right.error === "Cancelled." && later.status === "error", `${JSON.stringify(right)} → ${JSON.stringify(later)}`);
  check("cancelled grant reads as failed on /refs", (await refs("grant-cancel-01")).body.status === "error");
  check(
    "non-allowlisted host rejected (no SSRF)",
    (await runJob(await signMediaToken({ u: "http://169.254.169.254/latest/meta-data", k: "mp4", h: 720 }, SECRET))).status === 400
  );
  const noAuth = await fetch(`${W}/info`, { method: "POST", body: JSON.stringify({ url: MPD }) });
  check("/info requires the shared secret", noAuth.status === 401);
  const info = await fetch(`${W}/info`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: MPD }),
  }).then((r) => r.json());
  check("/info lists available heights", JSON.stringify(info.heights) === "[360,720,1080]", JSON.stringify(info.heights));
  check("unknown job id → 404", (await fetch(`${W}/jobs/aaaaaaaaaaaaaaaaaaaaaaaa`)).status === 404);
  // Playlists.
  const listing = (url: string, auth = `Bearer ${SECRET}`) =>
    fetch(`${W}/playlist`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const F = `http://127.0.0.1:${fixturePort}`;
  check("/playlist requires the shared secret", (await listing(`${F}/short.xml`, "Bearer wrong")).status === 401);
  check("/playlist rejects non-allowlisted hosts", (await listing("http://169.254.169.254/feed.xml")).status === 400);
  const short = await listing(`${F}/short.xml`);
  const e0 = short.body.entries?.[0];
  check(
    "/playlist lists title, count and entries",
    short.status === 200 && short.body.title === "Short list" && short.body.count === 3 &&
      short.body.truncated === false && short.body.entries.length === 3,
    JSON.stringify(short.body).slice(0, 300)
  );
  check(
    "/playlist entries carry title, duration, thumbnail, url",
    e0?.title === "Spell 1 & more" && e0?.duration === 60 && e0?.thumbnail === "https://img.test/1.jpg" &&
      String(e0?.url).endsWith("/media/1.mp4"),
    JSON.stringify(e0)
  );
  const long = await listing(`${F}/long.xml`);
  check(
    "/playlist caps at 200 and flags the cut",
    long.status === 200 && long.body.entries.length === 200 && long.body.truncated === true && long.body.count >= 201,
    `${long.body.entries?.length} entries, count ${long.body.count}, truncated ${long.body.truncated}`
  );
  const single = await listing(MPD);
  check("/playlist rejects a single video", single.status === 422 && /isn't a playlist/.test(single.body.error), JSON.stringify(single.body));
  const missing = await listing(`${F}/gone.xml`);
  check("/playlist maps a missing list to a friendly error", missing.status === 422 && missing.body.error === "This playlist is unavailable.", JSON.stringify(missing.body));
  check("/playlist never downloads media", mediaHits === 0, `${mediaHits} media requests`);

  const health = await fetch(`${W}/health`).then((r) => r.json());
  check("/health reports yt-dlp, JS runtime and EJS", typeof health.ytdlp === "string" && "jsRuntime" in health && "ejs" in health, JSON.stringify(health));
  check("HEAD /health answers (uptime monitors)", (await fetch(`${W}/health`, { method: "HEAD" })).status === 200);
  void body;
} finally {
  worker.kill();
  fixture.close();
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);

/**
 * End-to-end test of media-worker/worker.py with tokens signed by the web
 * app's own signer (lib/media.ts), so the TS <-> Python contract is checked.
 *
 * Instead of YouTube, it serves a local DASH stream with the same shape as
 * YouTube HD: separate 1080p/720p/360p video tracks plus a separate audio
 * track, so choosing a height and merging audio+video with ffmpeg are both
 * exercised. Needs python3 with yt-dlp, and ffmpeg (FFMPEG env or on PATH):
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

// 2. Serve it.
const fixture = createServer((req, res) => {
  const path = join(dir, (req.url ?? "/").split("?")[0]);
  if (!path.startsWith(dir) || !existsSync(path)) return res.writeHead(404).end();
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
  for (let i = 0; i < 120; i++) {
    s = await (await fetch(`${W}/jobs/${id}`)).json();
    progress.push(Number(s.progress ?? 0));
    if (s.status !== "working") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (s.status !== "ready") return { status: 500, body: s };
  const res = await fetch(`${W}/jobs/${id}/file`);
  const out = join(dir, `out-${id}${String(s.filename).endsWith(".mp3") ? ".mp3" : ".mp4"}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return { status: 200, body: s, file: out, disposition: res.headers.get("content-disposition"), progress };
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
  check("token signed with wrong secret rejected", (await runJob(await signMediaToken({ u: MPD, k: "mp4", h: 720 }, "wrong"))).status === 401);
  check("expired token rejected", (await runJob(await signMediaToken({ u: MPD, k: "mp4", h: 720 }, SECRET, -5))).status === 401);
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

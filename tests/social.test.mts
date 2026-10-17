/**
 * TikTok and Instagram downloads: link parsing, the page/API shapes the
 * resolvers read (modelled on yt-dlp's extractors), TikTok's proof-of-work
 * page, Instagram's three fallbacks, host allowlists and grant headers.
 * Uses fake networks; no real requests.
 */
import { createHash } from "node:crypto";
import { parseMediaUrl } from "../lib/media.ts";
import { resolveTikTok, solveChallenge, isAllowedTikTokUrl, universalData } from "../lib/social/tiktok.ts";
import { resolveInstagram, shortcodeToPk, isAllowedInstagramUrl, lsdToken } from "../lib/social/instagram.ts";
import { DirectResolveError, directFilename, failureMessage, grantHeaders, isAllowedMediaUrl } from "../lib/social/direct.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};
async function kind(p: Promise<unknown>) {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DirectResolveError ? e.kind : `other:${(e as Error).message}`;
  }
}

type Reply = { status?: number; body?: string; headers?: [string, string][] } | "throw";
function fakeFetch(route: (url: string, init?: RequestInit) => Reply) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = route(url, init);
    if (r === "throw") throw new Error("network down");
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers ?? [] });
  };
  return { f: f as never, calls };
}

// ---------- link parsing ----------
const p = (u: string) => parseMediaUrl(u);
check("tiktok full link", JSON.stringify(p("https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1")) ===
  JSON.stringify({ platform: "tiktok", id: "6718335390845095173", user: "scout2015", canonical: "https://www.tiktok.com/@scout2015/video/6718335390845095173" }));
check("tiktok mobile + no scheme", p("m.tiktok.com/@a.b_c/video/7106798200794926362")?.id === "7106798200794926362");
check("tiktok short vm", p("https://vm.tiktok.com/ZTR45GpSF/")?.short === true && p("https://vm.tiktok.com/ZTR45GpSF/")?.canonical === "https://vm.tiktok.com/ZTR45GpSF/");
check("tiktok short vt and /t/", p("https://vt.tiktok.com/ZSe4FqkKd")?.platform === "tiktok" && p("https://www.tiktok.com/t/ZTRC5xgJp/")?.canonical === "https://www.tiktok.com/t/ZTRC5xgJp/");
check("tiktok embed link", p("https://www.tiktok.com/embed/v2/6718335390845095173")?.id === "6718335390845095173");
check("tiktok profile/music rejected", p("https://www.tiktok.com/@scout2015") === null && p("https://www.tiktok.com/music/x-123") === null);
check("instagram reel", JSON.stringify(p("https://www.instagram.com/reel/C4Hm4z2oEVp/?igsh=MWQ")) ===
  JSON.stringify({ platform: "instagram", id: "C4Hm4z2oEVp", canonical: "https://www.instagram.com/p/C4Hm4z2oEVp/" }));
check("instagram post with img_index + username path", p("instagram.com/natgeo/p/CnLyXxRuCiK/?img_index=3")?.index === 3 && p("instagram.com/natgeo/p/CnLyXxRuCiK/?img_index=3")?.id === "CnLyXxRuCiK");
check("instagram tv and reels", p("https://www.instagram.com/tv/BlOFzmNAk6E/")?.id === "BlOFzmNAk6E" && p("https://instagram.com/reels/C4Hm4z2oEVp")?.id === "C4Hm4z2oEVp");
check("instagram profile/stories rejected", p("https://www.instagram.com/natgeo/") === null && p("https://www.instagram.com/stories/natgeo/123/") === null);
check("look-alike hosts rejected", p("https://tiktok.com.evil.com/@a/video/12345678901") === null && p("https://notinstagram.com/p/C4Hm4z2oEVp/") === null);

// ---------- TikTok ----------
const ID = "7106798200794926362";
const item = {
  id: ID,
  desc: "Sunset over Cape Town ‮ #fyp",
  author: { uniqueId: "akihitoko1" },
  video: {
    width: 576, height: 1024, duration: 29,
    cover: "https://p16-sign-va.tiktokcdn.com/obj/cover.jpeg",
    playAddr: "https://v16-webapp-prime.tiktok.com/video/tos/play.mp4?a=1",
    downloadAddr: "https://v16-webapp-prime.tiktok.com/video/tos/download-watermark.mp4",
    bitrateInfo: [
      { Bitrate: 1100000, PlayAddr: { UrlKey: "v12044gd0000cfoo_h264_720p_1100000", UrlList: ["https://v16-webapp-prime.tiktok.com/video/h264-720.mp4", "https://www.tiktok.com/aweme/v1/play/?broken=1"] } },
      { Bitrate: 900000, PlayAddr: { UrlKey: "v12044gd0000cfoo_bytevc1_720p_900000", UrlList: ["https://v19-webapp.tiktokcdn.com/video/hevc-720.mp4"] } },
      { Bitrate: 600000, PlayAddr: { UrlKey: "v12044gd0000cfoo_h264_540p_600000", UrlList: ["https://v16-webapp.tiktokcdn-us.com/video/h264-540.mp4"] } },
      { Bitrate: 2000000, PlayAddr: { UrlKey: "v12044gd0000cfoo_bytevc2_1080p_2000000", UrlList: ["https://v16-webapp.tiktokcdn.com/video/vvc.mp4"] } },
      { Bitrate: 500000, PlayAddr: { UrlKey: "x", UrlList: ["https://evil.example.com/video.mp4"] } },
    ],
  },
};
const page = (data: unknown) =>
  `<html><head><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: data })}</script></head></html>`;
const okPage = page({ "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: item } } });
check("universal data read", universalData(okPage)?.["webapp.video-detail"]?.statusCode === 0);

{
  const { f, calls } = fakeFetch((u) =>
    u.startsWith("https://www.tiktok.com/@akihitoko1/video/")
      ? { body: okPage, headers: [["set-cookie", "tt_chain_token=abc123; Path=/; Secure"], ["set-cookie", "ttwid=1%7Cxyz; Path=/"]] }
      : "throw"
  );
  const v = await resolveTikTok({ id: ID, user: "akihitoko1" }, f);
  const hosts = v.variants.map((x) => new URL(x.url).hostname);
  check("tiktok: variants from bitrateInfo + playAddr, best first", v.variants[0].url.endsWith("h264-720.mp4") && v.variants.length === 4, v.variants.map((x) => `${x.height}:${x.url.split("/").pop()}`).join(", "));
  check("tiktok: H.264 preferred over HEVC at the same size", v.variants[0].url.includes("h264-720") && v.variants[1].url.includes("hevc-720"));
  check("tiktok: www.tiktok.com play links, VVC and foreign hosts dropped", !hosts.includes("www.tiktok.com") && !hosts.includes("evil.example.com") && !v.variants.some((x) => x.url.includes("vvc")));
  check("tiktok: watermarked download link not used when others exist", !v.variants.some((x) => x.url.includes("watermark")));
  check("tiktok: portrait sizes from the quality key (540p → 576 wide)", v.variants.some((x) => x.width === 576 && x.height === 1024));
  check("tiktok: metadata + bidi override stripped", v.author === "akihitoko1" && v.duration === 29 && !v.title.includes("‮") && v.title.startsWith("Sunset"));
  check("tiktok: CDN gets the page's cookies and Referer", v.fetchHeaders?.Cookie === "tt_chain_token=abc123; ttwid=1%7Cxyz" && v.fetchHeaders?.Referer?.startsWith("https://www.tiktok.com/@akihitoko1/video/"));
  check("tiktok: browser-like page request", ((calls[0].init?.headers as Record<string, string>) ?? {})["User-Agent"]?.includes("Chrome"));
}

// Proof-of-work page: find i with sha256(a + i) == c.
{
  const a = Buffer.from("salt-for-test");
  const answer = 4242;
  const c = createHash("sha256").update(a).update(String(answer)).digest();
  const cs = Buffer.from(JSON.stringify({ v: { a: a.toString("base64"), c: c.toString("base64") }, s: "x" })).toString("base64").replace(/=+$/, "");
  const challenge = `<html><body><p id="cs" class="${cs}"></p><p id="wci" class="_wafchallengeid"></p><p id="rci" class="waforiginalreid"></p><p id="rs" class="rs-value"></p>Please wait...</body></html>`;
  const solved = solveChallenge(challenge);
  const sent = solved ? JSON.parse(Buffer.from(solved.value, "base64").toString()) : null;
  check("challenge solved (answer 4242) with the cookie name the page asks for", solved?.name === "_wafchallengeid" && Buffer.from(sent?.d ?? "", "base64").toString() === "4242" && solved?.extra?.[0] === "waforiginalreid");

  let n = 0;
  const { f, calls } = fakeFetch((u) => (u.includes("/video/") ? { body: n++ === 0 ? challenge : okPage } : "throw"));
  const v = await resolveTikTok({ id: ID, user: null }, f);
  const second = (calls[1].init?.headers as Record<string, string>)?.Cookie ?? "";
  check("challenge page → solved → second request carries the cookie", v.variants.length > 0 && second.includes("_wafchallengeid=") && calls[0].url.includes("/@_/video/"));
  check("single-use challenge cookies not sent to the CDN", !(v.fetchHeaders?.Cookie ?? "").includes("_wafchallengeid"));
  check("unsolvable challenge → blocked", (await kind(resolveTikTok({ id: ID }, fakeFetch(() => ({ body: "<html>Access denied</html>" })).f))) === "blocked");
}
check("private post (10216) → login-required", (await kind(resolveTikTok({ id: ID }, fakeFetch(() => ({ body: page({ "webapp.video-detail": { statusCode: 10216 } }) })).f))) === "login-required");
check("IP blocked (10204) → blocked", (await kind(resolveTikTok({ id: ID }, fakeFetch(() => ({ body: page({ "webapp.video-detail": { statusCode: 10204 } }) })).f))) === "blocked");
check("missing post → not-found", (await kind(resolveTikTok({ id: ID }, fakeFetch(() => ({ body: page({ "webapp.video-detail": { statusCode: 10204 + 0 * 1, itemInfo: {} } }).replace("10204", "100004") })).f))) === "not-found");
check("photo slideshow → no-video", (await kind(resolveTikTok({ id: ID }, fakeFetch(() => ({ body: page({ "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: { id: ID, imagePost: { images: [] }, video: {} } } } }) })).f))) === "no-video");
check("login redirect → login-required", (await kind(resolveTikTok({ id: ID }, fakeFetch(() => ({ status: 302, headers: [["location", "https://www.tiktok.com/login?redirect=x"]] })).f))) === "login-required");
check("network down → unreachable", (await kind(resolveTikTok({ id: ID }, fakeFetch(() => "throw").f))) === "unreachable");
check("non-numeric id → not-found without a request", (await kind(resolveTikTok({ id: "abc" }, fakeFetch(() => "throw").f))) === "not-found");
{
  const { f, calls } = fakeFetch((u) =>
    u.startsWith("https://vm.tiktok.com/")
      ? { status: 301, headers: [["location", `https://www.tiktok.com/@akihitoko1/video/${ID}?_r=1`]] }
      : u.includes("/video/") ? { body: okPage } : "throw"
  );
  const v = await resolveTikTok({ id: "ZTR45GpSF", short: "https://vm.tiktok.com/ZTR45GpSF/" }, f);
  check("short link expanded (HEAD, crawler UA) then resolved", v.id === ID && calls[0].init?.method === "HEAD" && calls[1].url.includes(`/@akihitoko1/video/${ID}`));
  const evil = fakeFetch((u) => (u.startsWith("https://vm.tiktok.com/") ? { status: 302, headers: [["location", "http://169.254.169.254/latest"]] } : "throw"));
  check("short link redirecting off TikTok → refused", (await kind(resolveTikTok({ id: "X1234", short: "https://vm.tiktok.com/X1234/" }, evil.f))) === "not-found" && evil.calls.length === 1);
}
check("tiktok allowlist", isAllowedTikTokUrl("https://v16-webapp-prime.tiktok.com/v.mp4") && isAllowedTikTokUrl("https://v19.tiktokcdn-us.com/v.mp4") &&
  !isAllowedTikTokUrl("https://www.tiktok.com/v.mp4") && !isAllowedTikTokUrl("http://v16.tiktokcdn.com/v.mp4") && !isAllowedTikTokUrl("https://tiktokcdn.com.evil.com/v.mp4") && !isAllowedTikTokUrl("https://vm.tiktok.com/x"));

// ---------- Instagram ----------
check("shortcode → media id (same as yt-dlp)", shortcodeToPk("CnLyXxRuCiK") === "3011722311611459722" && shortcodeToPk("C4Hm4z2oEVp") === "3316790680317085033" && shortcodeToPk("BlOFzmNAk6E") === "1823420435077942916");
check("lsd token from __eqmc or LSD config", lsdToken('<script type="application/json" id="__eqmc">{"l":"AVq1"}</script>') === "AVq1" && lsdToken('x["LSD",[],{"token":"AVz9"},1]') === "AVz9");
const CDN = "https://scontent-jnb2-1.cdninstagram.com/o1/v/t16/f2/m86/video.mp4?efg=1";
const product = {
  pk: "3316790680317085033",
  user: { username: "natgeo" },
  caption: { text: "Ocean at dawn" },
  video_duration: 12.5,
  has_audio: true,
  image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/thumb.jpg" }] },
  video_versions: [
    { url: CDN, width: 720, height: 1280, type: 101 },
    { url: "https://instagram.fjnb1-1.fna.fbcdn.net/v/t50/low.mp4", width: 480, height: 854, type: 102 },
    { url: "https://evil.example.com/x.mp4", width: 1080, height: 1920 },
  ],
};
const home = '<html><script type="application/json" id="__eqmc">{"l":"LSD123"}</script></html>';
{
  const { f, calls } = fakeFetch((u, init) => {
    if (u === "https://www.instagram.com/") return { body: home, headers: [["set-cookie", "csrftoken=tok42; Path=/"]] };
    if (u === "https://www.instagram.com/api/graphql" && init?.method === "POST") return { body: JSON.stringify({ data: { xig_polaris_media: { if_not_gated_logged_out: product } } }) };
    return "throw";
  });
  const v = await resolveInstagram("C4Hm4z2oEVp", f);
  const post = calls.find((c) => c.init?.method === "POST");
  const form = new URLSearchParams(String(post?.init?.body));
  const h = (post?.init?.headers ?? {}) as Record<string, string>;
  check("instagram: GraphQL path → variants, foreign host dropped", v.variants.length === 2 && v.variants[0].url === CDN && v.variants[0].height === 1280);
  check("instagram: query sends media id, lsd, doc_id, app id, csrf", JSON.parse(form.get("variables") ?? "{}").media_id === "3316790680317085033" && form.get("lsd") === "LSD123" && form.get("doc_id") === "27130156389949648" && h["X-IG-App-ID"] === "936619743392459" && h["X-CSRFToken"] === "tok42");
  check("instagram: metadata", v.author === "natgeo" && v.title === "Ocean at dawn" && v.duration === 12.5 && v.thumbnail?.endsWith("thumb.jpg") === true);
  check("instagram: CDN gets the Instagram Referer", v.fetchHeaders?.Referer === "https://www.instagram.com/");
}
{
  const sjs = `<script type="application/json" data-content-len="1" data-sjs>${JSON.stringify({ require: [["X", "y", null, [{ __bbox: { require: [["RelayPrefetchedStreamCache", "next", [], ["k", { __bbox: { result: { data: { xig_polaris_media: { if_not_gated_logged_out: product } } } } }]]] } }]]] })}</script>`;
  const { f } = fakeFetch((u) => (u === "https://www.instagram.com/" ? { body: "<html>no token</html>" } : u === "https://www.instagram.com/p/C4Hm4z2oEVp/" ? { body: `<html>${sjs}</html>` } : "throw"));
  const v = await resolveInstagram("C4Hm4z2oEVp", f);
  check("instagram: no token → post page JSON fallback", v.variants[0].url === CDN);
}
{
  const embed = `<html><script>window.__additionalDataLoaded('extra',{"shortcode_media":{"owner":{"username":"natgeo"},"video_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/embed.mp4?x=1"}});</script></html>`;
  const { f } = fakeFetch((u) => (u.endsWith("/embed/captioned/") ? { body: embed } : u === "https://www.instagram.com/" ? { status: 429 } : u.includes("/p/") ? { status: 302, headers: [["location", "https://www.instagram.com/accounts/login/"]] } : "throw"));
  const v = await resolveInstagram("C4Hm4z2oEVp", f);
  check("instagram: login wall → embed page fallback", v.variants[0].url === "https://scontent.cdninstagram.com/v/embed.mp4?x=1" && v.author === "natgeo");
}
{
  const carousel = { user: { username: "a" }, carousel_media: [{ image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/1.jpg" }] } }, { video_versions: [{ url: "https://scontent.cdninstagram.com/2.mp4", width: 720, height: 720 }] }, { video_versions: [{ url: "https://scontent.cdninstagram.com/3.mp4", width: 720, height: 720 }] }] };
  const gql = (prod: unknown) => fakeFetch((u, init) => (u === "https://www.instagram.com/" ? { body: home } : init?.method === "POST" ? { body: JSON.stringify({ data: { xig_polaris_media: { if_not_gated_logged_out: prod } } }) } : "throw")).f;
  const v3 = await resolveInstagram("C4Hm4z2oEVp", gql(carousel), 3);
  const vDefault = await resolveInstagram("C4Hm4z2oEVp", gql(carousel));
  check("instagram: carousel picks ?img_index slide, else first video", v3.variants[0].url.endsWith("3.mp4") && vDefault.variants[0].url.endsWith("2.mp4") && v3.index === 2);
  check("instagram: photo-only post → no-video", (await kind(resolveInstagram("C4Hm4z2oEVp", gql({ image_versions2: { candidates: [] } })))) === "no-video");
}
{
  const wall = fakeFetch((u) => (u.endsWith("/embed/captioned/") ? { status: 404 } : u === "https://www.instagram.com/" ? { body: home } : { status: 302, headers: [["location", "https://www.instagram.com/accounts/login/?next=x"]] }));
  check("instagram: every path walled → blocked", (await kind(resolveInstagram("C4Hm4z2oEVp", wall.f))) === "blocked");
  check("instagram: network down → unreachable", (await kind(resolveInstagram("C4Hm4z2oEVp", fakeFetch(() => "throw").f))) === "unreachable");
  check("instagram: bad shortcode → not-found, no request", (await kind(resolveInstagram("bad/../code", fakeFetch(() => "throw").f))) === "not-found");
}
check("instagram allowlist", isAllowedInstagramUrl(CDN) && isAllowedInstagramUrl("https://instagram.fjnb1-1.fna.fbcdn.net/v.mp4") && !isAllowedInstagramUrl("https://cdninstagram.com.evil.com/v.mp4") && !isAllowedInstagramUrl("http://scontent.cdninstagram.com/v.mp4") && !isAllowedInstagramUrl("https://www.instagram.com/v.mp4"));

// ---------- shared ----------
check("per-platform allowlist is not shared", !isAllowedMediaUrl(CDN, "tiktok") && !isAllowedMediaUrl("https://v16-webapp-prime.tiktok.com/v.mp4", "instagram") && isAllowedMediaUrl("https://video.twimg.com/a/b.mp4", "x"));
check("grant headers: only Cookie/Referer/User-Agent, no line breaks", JSON.stringify(grantHeaders({ Cookie: "a=1", Referer: "https://x\r\nInjected: 1", Host: "evil", "User-Agent": "UA" })) === JSON.stringify({ Cookie: "a=1", "User-Agent": "UA" }));
check("filenames", directFilename({ platform: "tiktok", id: ID, author: "akihitoko1", index: null } as never, "mp4", 720) === `tiktok-akihitoko1-${ID}-720p.mp4` &&
  directFilename({ platform: "instagram", id: "C4Hm4z2oEVp", author: null, index: 2 } as never, "mp3") === "instagram-C4Hm4z2oEVp-2.mp3");
check("messages name the platform", failureMessage("tiktok", "blocked").startsWith("TikTok") && failureMessage("instagram", "login-required").includes("Instagram"));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);

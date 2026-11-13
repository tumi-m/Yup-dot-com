/**
 * TikTok and Instagram downloads: link parsing, the page/API shapes the
 * resolvers read (modelled on yt-dlp's extractors), TikTok's proof-of-work
 * page, Instagram's post page / embed / GraphQL steps and how each failure
 * is named, host allowlists and grant headers.
 * Uses fake networks; no real requests.
 */
import { createHash } from "node:crypto";
import { parseMediaUrl } from "../lib/media.ts";
import { resolveTikTok, resolveTikTokMusic, solveChallenge, isAllowedTikTokUrl, tiktokMusic, universalData } from "../lib/social/tiktok.ts";
import { tiktokMusicSlug } from "../lib/samples/parse.ts";
import { resolveInstagram, shortcodeToPk, isAllowedInstagramUrl, lsdToken, embedMedia, pageMedia } from "../lib/social/instagram.ts";
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
// ---------- TikTok sounds (the Sample Finder) ----------
{
  const withSong = { ...item, music: { id: "1", title: "Stronger", authorName: "Kanye West", original: false, album: "Graduation" } };
  check("music read from the itemStruct", JSON.stringify(tiktokMusic(withSong)) === JSON.stringify({ title: "Stronger", author: "Kanye West", original: false, album: "Graduation" }), tiktokMusic(withSong));
  check("original sound flagged by TikTok", tiktokMusic({ music: { title: "my sound", authorName: "me", original: true } })?.original === true);
  check("…or by its title", tiktokMusic({ music: { title: "original sound - catperson", authorName: "catperson" } })?.original === true);
  check("no music → null", tiktokMusic({}) === null && tiktokMusic({ music: { title: "" } }) === null);
  check("music text is cleaned", tiktokMusic({ music: { title: "Strong\u202Eer", authorName: " A  B " } })?.title === "Stronger");
  const songPage = page({ "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: withSong } } });
  const v = await resolveTikTok({ id: ID, user: "akihitoko1" }, fakeFetch(() => ({ body: songPage })).f);
  check("a download preview carries the sound (no extra request)", v.music?.title === "Stronger" && v.music.original === false);
  const photo = page({ "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: { id: ID, imagePost: { images: [] }, video: {}, desc: "pics", author: { uniqueId: "x" }, music: withSong.music } } } });
  const m = await resolveTikTokMusic({ id: ID, user: "x" }, fakeFetch(() => ({ body: photo })).f);
  check("a photo post's sound can still be read", m.music?.title === "Stronger" && m.id === ID);
  const evilCover = page({ "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: { ...withSong, video: { cover: "https://evil.example/c.jpg" } } } } });
  check("covers only from TikTok's image hosts", (await resolveTikTokMusic({ id: ID }, fakeFetch(() => ({ body: evilCover })).f)).cover === null);
  check("tiktok.com/music/<Song>-<id> → its words (the download tools still refuse it)", tiktokMusicSlug("/music/Harder-Better-Faster-Stronger-6922437245843145729") === "Harder Better Faster Stronger" && p("https://www.tiktok.com/music/x-123") === null);
}
check("tiktok allowlist", isAllowedTikTokUrl("https://v16-webapp-prime.tiktok.com/v.mp4") && isAllowedTikTokUrl("https://v19.tiktokcdn-us.com/v.mp4") &&
  !isAllowedTikTokUrl("https://www.tiktok.com/v.mp4") && !isAllowedTikTokUrl("http://v16.tiktokcdn.com/v.mp4") && !isAllowedTikTokUrl("https://tiktokcdn.com.evil.com/v.mp4") && !isAllowedTikTokUrl("https://vm.tiktok.com/x"));

// ---------- Instagram ----------
// Fixtures are cut down from what instagram.com sent a cloud server in
// November 2026 (same nesting and encoding, few fields, placeholder URLs).
check("shortcode → media id (same as yt-dlp)", shortcodeToPk("CnLyXxRuCiK") === "3011722311611459722" && shortcodeToPk("C4Hm4z2oEVp") === "3316790680317085033" && shortcodeToPk("BlOFzmNAk6E") === "1823420435077942916");
check("lsd token from __eqmc or LSD config", lsdToken('<script type="application/json" id="__eqmc">{"l":"AVq1"}</script>') === "AVq1" && lsdToken('x["LSD",[],{"token":"AVz9"},1]') === "AVz9");
const CODE = "C4Hm4z2oEVp";
const PK = "3316790680317085033";
const CDN = "https://scontent-jnb2-1.cdninstagram.com/o1/v/t2/f2/m86/video.mp4?efg=1";
const eqmc = '<script type="application/json" id="__eqmc">{"u":"\\/ajax\\/qm\\/","s":"XPolarisPostController","l":"LSD123"}</script>';
const sjs = (data: unknown) =>
  `<script type="application/json" data-content-len="1" data-sjs>${JSON.stringify({ require: [["ScheduledServerJS", "handle", null, [{ __bbox: { require: [["RelayPrefetchedStreamCache", "next", [], ["adp_PolarisLoggedOutDesktopWWWPostRootQueryRelayPreloader", { __bbox: { complete: true, result: { data } } }]]] } }]]] })}</script>`;
// The post page: video_versions without sizes, the size on the media, the length in the DASH manifest.
const product = {
  __typename: "XIGPolarisVideoMedia",
  pk: PK,
  code: CODE,
  media_type: 2,
  product_type: "clips",
  user: { username: "natgeo" },
  caption: { text: "Ocean at dawn" },
  original_width: 720,
  original_height: 1280,
  has_audio: true,
  image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/thumb.jpg", width: 1080, height: 1920 }] },
  video_dash_manifest: '<MPD mediaPresentationDuration="PT0H0M12.5S"><Representation width="720" height="1280"/></MPD>',
  video_versions: [
    { type: 101, url: CDN },
    { type: 102, url: CDN },
    { type: 103, url: "https://evil.example.com/x.mp4" },
  ],
};
const postPage = (prod: unknown = product) => `<html>${eqmc}${sjs({ xig_polaris_media: { __typename: "XIGPolarisVideoMedia", pk: PK, code: CODE, if_not_gated_logged_out: prod, gating_ruling: null } })}</html>`;
// What Instagram renders, with HTTP 200, for a client it refuses (and for a gone post).
const errorPage = `<html><title>Instagram</title>${eqmc}${sjs(null).replace('"data":null', '"data":null,"route":{"canonicalRouteName":"comet.igweb.PolarisErrorRoute","hostableView":{"props":{"page_logging":{"name":"httpErrorPage","params":{}},"failure_reason":null,"restricted_age":null,"page_type":"MEDIA"}}}')}</html>`;
// The embed page: the media as escaped JSON inside the contextJSON string, slashes escaped too.
const embedPage = (media: unknown, ctx: Record<string, unknown> = {}) => {
  const inner = JSON.stringify({ context: { type: "GraphVideo", shortcode: CODE, copyright_blocked: false, ...ctx }, gql_data: { shortcode_media: media } }).replace(/\//g, "\\/");
  return `<html><script>requireLazy(["PolarisEmbedSimple"],function(){});</script><script>{"require":[["PolarisEmbedSimple","init",[],[{"isRichEmbed":true,"isSidecar":false,"contextJSON":${JSON.stringify(inner)}}]]]}</script><div class="EmbeddedMediaImage"></div></html>`;
};
const embedVideo = { __typename: "GraphVideo", shortcode: CODE, is_video: true, owner: { username: "natgeo" }, dimensions: { height: 1920, width: 1080 }, video_duration: 4.9, display_url: "https://scontent.cdninstagram.com/d.jpg", video_url: "https://scontent.cdninstagram.com/o1/v/embed.mp4?x=1" };
const brokenEmbed = '<html><script>{"require":[["PolarisEmbedSimple","init",[],[{"isSidecar":false,"contextJSON":null}]]]}</script><div class="_aa4c"><div class="EmbedBrokenMedia"></div></div></html>';
const rulingOk = { body: '{"title":"","description":"","session_id":"","blocks_logging_data":"","status":"ok"}', headers: [["content-type", "application/json"], ["set-cookie", "csrftoken=tok42; Path=/; Secure"]] as [string, string][] };
const gqlBody = (prod: unknown) => ({ body: JSON.stringify({ data: { xig_polaris_media: { if_not_gated_logged_out: prod } } }) });
const igPath = (u: string) => new URL(u).pathname;
/** Answers by path; `page`, `embed`, `ruling`, `graphql` default to a refusal-free "nothing here". */
function ig(r: { page?: Reply; embed?: Reply; ruling?: Reply; graphql?: Reply }) {
  return fakeFetch((u) => {
    const p = igPath(u);
    if (p === `/p/${CODE}/`) return r.page ?? { body: errorPage };
    if (p === `/p/${CODE}/embed/captioned/`) return r.embed ?? { body: embedPage({ ...embedVideo, video_url: undefined }, { copyright_blocked: true }) };
    if (p === "/api/v1/web/get_ruling_for_content/") return r.ruling ?? rulingOk;
    if (p === "/api/graphql") return r.graphql ?? { status: 429 };
    return "throw";
  });
}
// Captures the one log line a failed resolve writes.
async function logged(p: Promise<unknown>) {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  const k = await kind(p);
  console.warn = warn;
  return { k, lines };
}

{
  const { f, calls } = ig({ page: { body: postPage() } });
  const v = await resolveInstagram(CODE, f);
  const h = (calls[0].init?.headers ?? {}) as Record<string, string>;
  check("instagram: post page JSON → video, in one request", calls.length === 1 && igPath(calls[0].url) === `/p/${CODE}/` && v.variants.length === 1 && v.variants[0].url === CDN);
  check("instagram: page request looks like a browser opening it (Sec-Fetch)", h["Sec-Fetch-Mode"] === "navigate" && h["Sec-Fetch-Dest"] === "document" && h["Sec-Fetch-Site"] === "none" && h["User-Agent"].includes("Chrome"));
  check("instagram: size from the media, length from the DASH manifest", v.variants[0].width === 720 && v.variants[0].height === 1280 && v.duration === 12.5);
  check("instagram: foreign-host video URL dropped", !v.variants.some((x) => x.url.includes("evil")));
  check("instagram: metadata", v.author === "natgeo" && v.title === "Ocean at dawn" && v.hasAudio && v.thumbnail?.endsWith("thumb.jpg") === true);
  check("instagram: CDN gets the Instagram Referer", v.fetchHeaders?.Referer === "https://www.instagram.com/");
  check("instagram: redirects never followed", calls.every((c) => c.init?.redirect === "manual"));
}
{
  const { f, calls } = ig({ embed: { body: embedPage(embedVideo) } });
  const v = await resolveInstagram(CODE, f);
  check("instagram: refused page → embed's escaped contextJSON", v.variants[0].url === "https://scontent.cdninstagram.com/o1/v/embed.mp4?x=1" && v.variants[0].height === 1920 && v.author === "natgeo" && v.duration === 4.9);
  check("instagram: embed found it, so no API calls", calls.length === 2);
}
{
  const embed = `<html><script>window.__additionalDataLoaded('extra',{"shortcode_media":{"owner":{"username":"natgeo"},"is_video":true,"video_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/old.mp4?x=1"}});</script></html>`;
  const v = await resolveInstagram(CODE, ig({ page: { status: 302, headers: [["location", "https://www.instagram.com/accounts/login/"]] }, embed: { body: embed } }).f);
  check("instagram: older embed shape (__additionalDataLoaded)", v.variants[0].url === "https://scontent.cdninstagram.com/v/old.mp4?x=1");
}
{
  const node = (n: number, video: boolean) => ({ __typename: video ? "GraphVideo" : "GraphImage", is_video: video, display_url: `https://scontent.cdninstagram.com/${n}.jpg`, dimensions: { width: 720, height: 720 }, ...(video ? { video_url: `https://scontent.cdninstagram.com/${n}.mp4` } : {}) });
  const sidecar = { __typename: "GraphSidecar", is_video: false, owner: { username: "a" }, edge_sidecar_to_children: { edges: [{ node: node(1, false) }, { node: node(2, true) }, { node: node(3, true) }] } };
  const route = ig({ embed: { body: embedPage(sidecar, { type: "GraphSidecar" }) } }).f;
  const v3 = await resolveInstagram(CODE, route, 3);
  const vDefault = await resolveInstagram(CODE, route);
  check("instagram: embed carousel picks ?img_index slide, else first video", v3.variants[0].url.endsWith("3.mp4") && vDefault.variants[0].url.endsWith("2.mp4") && v3.index === 2);
  const evil = await kind(resolveInstagram(CODE, ig({ embed: { body: embedPage({ ...embedVideo, video_url: "https://evil.example.com/v.mp4" }) } }).f));
  check("instagram: embed video on a foreign host → refused (unavailable)", evil === "unavailable");
}
{
  const carousel = { user: { username: "a" }, carousel_media: [{ image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/1.jpg" }] } }, { original_width: 640, original_height: 640, video_versions: [{ url: "https://scontent.cdninstagram.com/2.mp4" }] }, { video_versions: [{ url: "https://scontent.cdninstagram.com/3.mp4", width: 720, height: 720 }] }] };
  const v = await resolveInstagram(CODE, ig({ page: { body: postPage(carousel) } }).f, 2);
  check("instagram: page carousel slide sizes from each slide", v.variants[0].url.endsWith("2.mp4") && v.variants[0].height === 640 && v.index === 1);
}
{
  // Page refused, embed leaves the file out (music): ruling, then GraphQL.
  const { f, calls } = ig({ graphql: gqlBody({ ...product, video_versions: [{ url: CDN, width: 720, height: 1280 }] }) });
  const v = await resolveInstagram(CODE, f);
  const ruling = calls.find((c) => igPath(c.url) === "/api/v1/web/get_ruling_for_content/");
  const post = calls.find((c) => c.init?.method === "POST");
  const rh = (ruling?.init?.headers ?? {}) as Record<string, string>;
  const h = (post?.init?.headers ?? {}) as Record<string, string>;
  const form = new URLSearchParams(String(post?.init?.body));
  check("instagram: ruling asked first, for this media id", !!ruling && calls.indexOf(ruling) < calls.indexOf(post!) && new URL(ruling.url).searchParams.get("target_id") === PK && new URL(ruling.url).searchParams.get("content_type") === "MEDIA");
  check("instagram: API calls carry same-origin Sec-Fetch headers", rh["Sec-Fetch-Site"] === "same-origin" && rh["Sec-Fetch-Mode"] === "cors" && h["Sec-Fetch-Site"] === "same-origin" && rh["X-IG-App-ID"] === "936619743392459");
  check("instagram: GraphQL sends the ruling's csrf token, page's lsd, doc_id", h["X-CSRFToken"] === "tok42" && form.get("lsd") === "LSD123" && h["X-FB-LSD"] === "LSD123" && form.get("doc_id") === "27130156389949648" && JSON.parse(form.get("variables") ?? "{}").media_id === PK);
  check("instagram: GraphQL answer → video", v.variants[0].url === CDN);
  check("instagram: only www.instagram.com asked while resolving", calls.every((c) => new URL(c.url).hostname === "www.instagram.com"));
}
{
  const { f, calls } = ig({ ruling: { body: '{"title":"","description":"","status":"fail"}', headers: [["set-cookie", "csrftoken=tok42; Path=/"]] }, graphql: gqlBody(product) });
  await resolveInstagram(CODE, f);
  const h = (calls.find((c) => c.init?.method === "POST")?.init?.headers ?? {}) as Record<string, string>;
  check("instagram: ruling not ok → no csrf token sent (as yt-dlp)", !("X-CSRFToken" in h));
}
{
  // Failures say what really happened.
  const all = await logged(resolveInstagram(CODE, ig({}).f));
  check("instagram: error page everywhere + GraphQL 429 → blocked (not unreachable)", all.k === "blocked", all.k);
  const line = all.lines.join("\n");
  check("instagram: one log line with each step, status and reason", all.lines.length === 1 && line.includes("page 200 error page") && line.includes("embed 200 no video in embed") && line.includes("ruling 200 ok") && line.includes("graphql 429 rate limited"), line);
  check("instagram: log line has no tokens, cookies or URLs", !/LSD123|tok42|https?:|\?|=/.test(line), line);
  const ok = await logged(resolveInstagram(CODE, ig({ page: { body: postPage() } }).f));
  check("instagram: nothing logged when it resolves", ok.k === "ok" && ok.lines.length === 0);

  const login = { status: 302, headers: [["location", "https://www.instagram.com/accounts/login/?next=x"]] as [string, string][] };
  const walled = ig({ page: login, embed: login });
  check("instagram: login wall, no lsd → blocked, GraphQL not asked", (await kind(resolveInstagram(CODE, walled.f))) === "blocked" && !walled.calls.some((c) => igPath(c.url).startsWith("/api/")));
  const limited = ig({ ruling: { status: 429 } });
  check("instagram: ruling 429 → blocked, GraphQL skipped", (await kind(resolveInstagram(CODE, limited.f))) === "blocked" && !limited.calls.some((c) => igPath(c.url) === "/api/graphql"));
  check("instagram: 403 → blocked", (await kind(resolveInstagram(CODE, ig({ page: { status: 403 }, embed: { status: 403 } }).f))) === "blocked");
  check("instagram: \"please wait a few minutes\" JSON → blocked", (await kind(resolveInstagram(CODE, ig({ graphql: { body: '{"message":"Please wait a few minutes before you try again.","require_login":true,"status":"fail"}' } }).f))) === "blocked");

  const gone = ig({ embed: { body: brokenEmbed } });
  check("instagram: deleted post (error page + broken embed) → not-found, no API calls", (await kind(resolveInstagram(CODE, gone.f))) === "not-found" && gone.calls.length === 2);
  check("instagram: page 404 → not-found", (await kind(resolveInstagram(CODE, ig({ page: { status: 404 } }).f))) === "not-found");
  check("instagram: photo-only post (page) → no-video", (await kind(resolveInstagram(CODE, ig({ page: { body: postPage({ media_type: 1, image_versions2: { candidates: [] } }) } }).f))) === "no-video");
  check("instagram: photo-only post (embed) → no-video", (await kind(resolveInstagram(CODE, ig({ embed: { body: embedPage({ __typename: "GraphImage", is_video: false, display_url: "https://scontent.cdninstagram.com/p.jpg" }, { type: "GraphImage" }) } }).f))) === "no-video");
  check("instagram: ruling \"Restricted Video\" → login-required", (await kind(resolveInstagram(CODE, ig({ ruling: { body: '{"title":"Restricted Video","description":"You must be 18 years old or over to see this video.","status":"ok"}' } }).f))) === "login-required");
  check("instagram: withheld logged out (empty product) → login-required", (await kind(resolveInstagram(CODE, ig({ page: { body: postPage(null) }, embed: { status: 500 }, graphql: gqlBody(null) }).f))) === "login-required");

  check("instagram: network down → unreachable", (await kind(resolveInstagram(CODE, fakeFetch(() => "throw").f))) === "unreachable");
  check("instagram: 5xx everywhere → unreachable", (await kind(resolveInstagram(CODE, fakeFetch(() => ({ status: 503 })).f))) === "unreachable");
  const timeout = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as never;
  const slow = await logged(resolveInstagram(CODE, timeout));
  check("instagram: timeouts → unreachable, logged as timeout", slow.k === "unreachable" && slow.lines[0]?.includes("page timeout"), slow.lines[0]);
  check("instagram: bad shortcode → not-found, no request", (await kind(resolveInstagram("bad/../code", fakeFetch(() => "throw").f))) === "not-found");
}
check("instagram: embed shapes read directly", embedMedia(embedPage(embedVideo))?.video_url === embedVideo.video_url && embedMedia(brokenEmbed) === null && pageMedia(postPage())?.code === CODE && pageMedia(errorPage) === null);
check("instagram allowlist", isAllowedInstagramUrl(CDN) && isAllowedInstagramUrl("https://instagram.fjnb1-1.fna.fbcdn.net/v.mp4") && !isAllowedInstagramUrl("https://cdninstagram.com.evil.com/v.mp4") && !isAllowedInstagramUrl("http://scontent.cdninstagram.com/v.mp4") && !isAllowedInstagramUrl("https://www.instagram.com/v.mp4"));

// ---------- shared ----------
check("per-platform allowlist is not shared", !isAllowedMediaUrl(CDN, "tiktok") && !isAllowedMediaUrl("https://v16-webapp-prime.tiktok.com/v.mp4", "instagram") && isAllowedMediaUrl("https://video.twimg.com/a/b.mp4", "x"));
check("grant headers: only Cookie/Referer/User-Agent, no line breaks", JSON.stringify(grantHeaders({ Cookie: "a=1", Referer: "https://x\r\nInjected: 1", Host: "evil", "User-Agent": "UA" })) === JSON.stringify({ Cookie: "a=1", "User-Agent": "UA" }));
check("filenames", directFilename({ platform: "tiktok", id: ID, author: "akihitoko1", index: null } as never, "mp4", 720) === `tiktok-akihitoko1-${ID}-720p.mp4` &&
  directFilename({ platform: "instagram", id: "C4Hm4z2oEVp", author: null, index: 2 } as never, "mp3") === "instagram-C4Hm4z2oEVp-2.mp3");
check("messages name the platform", failureMessage("tiktok", "blocked").startsWith("TikTok") && failureMessage("instagram", "login-required").includes("Instagram"));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);

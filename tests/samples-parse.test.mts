/**
 * Reading the song from YouTube titles and typed text (lib/samples/parse.ts):
 * decorations dropped, versions kept as a variant, guests taken out, the
 * artist found from the channel, quotes or a separator, in any script, and
 * an honest confidence for each.
 */
import { parseTyped, parseVideoTitle, readChannel, tiktokMusicSlug, isDecoration } from "../lib/samples/parse.ts";
import { dice, norm, escapeLucene, decamel } from "../lib/samples/normalize.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const v = (title: string, channel: string | null = null, shorts = false) => parseVideoTitle(title, channel, { shorts });
const is = (p: { artist: string; title: string }, artist: string, title: string) => p.artist === artist && p.title === title;

// ---------- YouTube titles ----------
{
  const p = v("Kanye West - Stronger (Official Music Video)", "KanyeWestVEVO");
  check("artist - title (official video) on a VEVO channel", is(p, "Kanye West", "Stronger"), p);
  check("  … is high confidence", p.confidence >= 0.8, p.confidence);
  check("  … with no variant", p.variant === null);
}
{
  const p = v("Harder, Better, Faster, Stronger", "Daft Punk - Topic");
  check("Topic channel: the title is the track, the channel the artist", is(p, "Daft Punk", "Harder, Better, Faster, Stronger"), p);
  check("  … and the title isn't split on its commas", p.title.includes(","));
  check("  … Topic is high confidence", p.confidence >= 0.8, p.confidence);
}
check("VEVO channel names are split", readChannel("KanyeWestVEVO").name === "Kanye West" && readChannel("TheWeekndVEVO").name === "The Weeknd");
check("channel suffixes are dropped", readChannel("Mark Ronson Official").name === "Mark Ronson" && readChannel("TaylorSwiftOfficial").name === "Taylor Swift");
check("Topic channel read", readChannel("The Beatles - Topic").topic && readChannel("The Beatles - Topic").name === "The Beatles");
check("[4K Remaster] dropped", is(v("Queen - Bohemian Rhapsody [4K Remaster]"), "Queen", "Bohemian Rhapsody"));
{
  const p = v("Here Comes The Sun - Remastered 2009", "The Beatles - Topic");
  check("Topic: \" - Remastered 2009\" suffix dropped", is(p, "The Beatles", "Here Comes The Sun"), p);
}
check("Topic: \" - Radio Edit\" dropped", v("Levels - Radio Edit", "Avicii - Topic").title === "Levels");
check("Topic: \" - From \\\"…\\\" Soundtrack\" dropped", v('Shallow - From "A Star Is Born" Soundtrack', "Lady Gaga - Topic").title === "Shallow");
check("Topic: a colon stays in the title", v("Star Wars: Main Title", "John Williams - Topic").title === "Star Wars: Main Title");
{
  const p = v("Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars", "Mark Ronson");
  check("trailing ft. after the tag", is(p, "Mark Ronson", "Uptown Funk") && p.featured.join() === "Bruno Mars", p);
}
{
  const p = v("Calvin Harris ft. Rihanna - This Is What You Came For");
  check("ft. in the artist", is(p, "Calvin Harris", "This Is What You Came For") && p.featured.join() === "Rihanna", p);
}
{
  const p = v("Kanye West - Gold Digger (feat. Jamie Foxx)");
  check("(feat. X) in brackets", is(p, "Kanye West", "Gold Digger") && p.featured.join() === "Jamie Foxx", p);
}
check("(prod. by X) dropped", v("Drake - Nice For What (prod. by Murda Beatz)").title === "Nice For What");
{
  const p = v("Lil Nas X x Billy Ray Cyrus - Old Town Road");
  check("A x B keeps the whole credit first", p.artist === "Lil Nas X x Billy Ray Cyrus" && p.title === "Old Town Road", p);
  check("  … and each name as a fallback (Lil Nas X keeps its X)", p.artistParts.join("|") === "Lil Nas X|Billy Ray Cyrus", p.artistParts);
}
{
  const p = v("Simon & Garfunkel - The Boxer (Audio)");
  check("Simon & Garfunkel survives as one credit", p.artist === "Simon & Garfunkel" && p.title === "The Boxer", p);
  check("  … with the names apart as fallbacks", p.artistParts.join("|") === "Simon|Garfunkel");
}
check("(Lyrics) dropped", is(v("Dido - Thank You (Lyrics)"), "Dido", "Thank You"));
check("(Official Lyric Video) dropped", is(v("Avicii - Levels (Official Lyric Video)"), "Avicii", "Levels"));
check("(Visualizer) dropped", is(v("Beyoncé - BREAK MY SOUL (Official Visualizer)"), "Beyoncé", "BREAK MY SOUL"));
check("| Official Video segment dropped", is(v("Kanye West - Stronger | Official Video"), "Kanye West", "Stronger"));
check("Spanish and Portuguese tags dropped", is(v("Shakira - Hips Don't Lie (Video Oficial)"), "Shakira", "Hips Don't Lie") && is(v("Anitta - Envolver (Legendado)"), "Anitta", "Envolver"));
{
  const p = v("Queen - Bohemian Rhapsody (Live at Wembley)");
  check("(Live at Wembley) → variant live, not in the title", is(p, "Queen", "Bohemian Rhapsody") && p.variant === "live", p);
}
{
  const p = v("Dua Lipa - Levitating (DaBaby Remix)");
  check("(X Remix) → variant remix with the remixer", is(p, "Dua Lipa", "Levitating") && p.variant === "remix" && p.remixer === "DaBaby", p);
}
check("(sped up) → variant", v("SZA - Kill Bill (sped up)").variant === "sped-up" && v("SZA - Kill Bill (sped up)").title === "Kill Bill");
check("(slowed + reverb) → variant", v("Kanye West - Stronger (slowed + reverb)").variant === "slowed");
check("(Acoustic Cover) → a cover", v("Hurt (Acoustic Cover)").variant === "cover");
check("a title that is a version word stays: Oasis - Live Forever", is(v("Oasis - Live Forever"), "Oasis", "Live Forever") && v("Oasis - Live Forever").variant === null);
{
  const p = v("Blinding Lights | The Weeknd", "The Weeknd");
  check("Title | Artist, swapped by the channel", is(p, "The Weeknd", "Blinding Lights") && p.signals.includes("swapped"), p);
}
{
  const p = v("BTS (방탄소년단) 'Dynamite' Official MV", "HYBE LABELS");
  check("BTS (방탄소년단) 'Dynamite'", is(p, "BTS", "Dynamite") && p.artistAliases.join() === "방탄소년단", p);
}
{
  const p = v("【MV】YOASOBI「アイドル」", "Ayase / YOASOBI");
  check("【MV】YOASOBI「アイドル」", is(p, "YOASOBI", "アイドル"), p);
}
{
  const p = v("米津玄師 MV「Lemon」", "米津玄師");
  check("米津玄師 MV「Lemon」", is(p, "米津玄師", "Lemon"), p);
  check("  … the channel matches the artist", p.signals.includes("channel-match"));
}
{
  const p = v("周杰倫 Jay Chou【告白氣球】", "周杰倫 Jay Chou");
  check("周杰倫 Jay Chou【告白氣球】", is(p, "周杰倫", "告白氣球") && p.artistAliases.join() === "Jay Chou", p);
}
check("Beyoncé keeps her accent", v("Beyoncé - Halo").artist === "Beyoncé");
{
  const reaction = v("Kanye West - Stronger REACTION!!", "Reacts Daily");
  check("reaction → low confidence, word out of the title", reaction.confidence < 0.3 && reaction.title === "Stronger" && reaction.signals.includes("reaction"), reaction);
  const beat = v('[FREE] Kanye West Type Beat - "Stronger"');
  check("type beat → low confidence", beat.confidence < 0.3 && beat.signals.includes("type-beat"), beat);
  const loop = v("Kanye West - Stronger (1 Hour Loop)");
  check("1 hour loop → low confidence", loop.confidence < 0.3 && loop.title === "Stronger", loop);
  const album = v("Daft Punk - Discovery (Full Album)");
  check("full album → low confidence", album.confidence < 0.3, album);
}
{
  const plain = v("Kanye West - Stronger");
  const short = v("Kanye West - Stronger", null, true);
  check("Shorts cost 0.15", Math.abs(plain.confidence - short.confidence - 0.15) < 0.001 && short.signals.includes("shorts"), [plain.confidence, short.confidence]);
  check("#shorts in the title counts too, and leaves", v("Kanye West - Stronger #shorts #fyp").title === "Stronger" && v("Kanye West - Stronger #shorts").signals.includes("shorts"));
}
check("no split: the channel is a guess, low confidence", v("Stronger", "music fan 2007").confidence < 0.55 && v("Stronger", "music fan 2007").signals.includes("channel-guess"));
check("emoji around the title go", is(v("🔥 Kanye West - Stronger 🔥"), "Kanye West", "Stronger"));
check("decoration words: tags vs titles", isDecoration("Official Music Video") && isDecoration("Remastered 2009") && isDecoration("4K") && !isDecoration("Music") && !isDecoration("Don't Don't Do It"));
check("(Don't Don't Do It) stays in the title", v("Grandmaster & Melle Mel - White Lines (Don't Don't Do It)").title === "White Lines (Don't Don't Do It)");

// ---------- Typed ----------
check("Stronger by Kanye West", is(parseTyped("Stronger by Kanye West"), "Kanye West", "Stronger"));
check("Artist – Title (en dash)", is(parseTyped("Kanye West – Stronger"), "Kanye West", "Stronger") && parseTyped("Kanye West – Stronger").confidence >= 0.75);
check("Artist - Title", is(parseTyped("daft punk - one more time"), "daft punk", "one more time"));
check('Artist "Title"', is(parseTyped('Kanye West "Stronger"'), "Kanye West", "Stronger"));
{
  const p = parseTyped("kanye west stronger");
  check("kanye west stronger → bare, low, free text", p.artist === "" && p.title === "kanye west stronger" && p.confidence <= 0.2 && p.signals.includes("bare"), p);
}
check("Stand by Me stays a title", parseTyped("Stand by Me").artist === "" && parseTyped("Stand by Me").title === "Stand by Me");
check("Stand by Me by Ben E. King", is(parseTyped("Stand by Me by Ben E. King"), "Ben E. King", "Stand by Me"));

// ---------- TikTok sound links ----------
check("tiktok /music/ slug → words", tiktokMusicSlug("/music/Stronger-Kanye-West-6814435937396410373") === "Stronger Kanye West");
check("tiktok /music/ without an id → nothing", tiktokMusicSlug("/music/Stronger") === null && tiktokMusicSlug("/@user/video/123") === null);

// ---------- Normalising ----------
check("Beyoncé = Beyonce", norm("Beyoncé") === norm("Beyonce"));
check("Sigur Rós = Sigur Ros", norm("Sigur Rós") === norm("sigur ros"));
check("Gyöngyhajú lány keeps its letters", norm("Gyöngyhajú lány") === "gyongyhaju lany", norm("Gyöngyhajú lány"));
check("Japanese and Korean aren't emptied", norm("アイドル").length > 0 && norm("방탄소년단").length > 0);
check("dice works on CJK", dice("告白氣球", "告白氣球") === 1 && dice("告白氣球", "告白") > 0.4 && dice("告白氣球", "Lemon") === 0);
check("decamel", decamel("KanyeWest") === "Kanye West" && decamel("LMFAO") === "LMFAO");
check("Lucene escaping (AC/DC, Panic!, quotes, colons)", escapeLucene("AC/DC") === "AC\\/DC" && escapeLucene("Panic! at the Disco") === "Panic\\! at the Disco" && escapeLucene('Say "Hi": now') === 'Say \\"Hi\\"\\: now');

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);

/**
 * The hand-checked sample list (lib/samples/catalog.ts): no duplicates, real
 * years, every sample says what it takes, interpolations marked, no
 * placeholder sources, and matching that finds a song both ways without
 * catching unrelated titles ("i" isn't every Kendrick Lamar song).
 */
import { CATALOG, artistMatches, catalogYear, lookupCatalog, titleMatches } from "../lib/samples/catalog.ts";
import { artistKey, compact } from "../lib/samples/normalize.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const roles = (artist: string, title: string) => lookupCatalog({ artist, title });

// ---------- The data ----------
check(`the list has entries (${CATALOG.length})`, CATALOG.length >= 100, CATALOG.length);
{
  const keys = CATALOG.map((e) => `${artistKey(e.artist)}|${compact(e.title)}|${artistKey(e.sourceArtist)}|${compact(e.sourceTitle)}`);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  check("no duplicate connections", dupes.length === 0, dupes);
  // The same connection written with another credit ("2Pac" / "Dr. Dre & 2Pac").
  const loose = CATALOG.flatMap((a, i) =>
    CATALOG.slice(i + 1)
      .filter((b) => titleMatches(a.title, b.title) && artistMatches(a.artist, b.artist) && titleMatches(a.sourceTitle, b.sourceTitle) && artistMatches(a.sourceArtist, b.sourceArtist))
      .map((b) => `${a.artist} ${a.title} / ${b.artist} ${b.title}`)
  );
  check("no duplicates under another credit or spelling", loose.length === 0, loose);
}
check("every sample says what it takes", CATALOG.every((e) => (e.relation ?? "sample") !== "sample" || !!e.element), CATALOG.filter((e) => (e.relation ?? "sample") === "sample" && !e.element).map((e) => e.title));
check("covers and remixes don't claim an element", CATALOG.every((e) => (e.relation ?? "sample") === "sample" || !e.element));
check("4-digit years on both songs", CATALOG.every((e) => [e.year, e.sourceYear].every((y) => Number.isInteger(y) && y >= 1900 && y <= 2026)), CATALOG.filter((e) => ![e.year, e.sourceYear].every((y) => Number.isInteger(y) && y >= 1900 && y <= 2026)).map((e) => e.title));
check("the source is never newer than the song", CATALOG.every((e) => e.sourceYear <= e.year), CATALOG.filter((e) => e.sourceYear > e.year).map((e) => e.title));
check("no placeholder sources", CATALOG.every((e) => !/original composition|backing style|unknown|various|video|n\/a|placeholder/i.test(`${e.sourceArtist} ${e.sourceTitle} ${e.note ?? ""}`)), CATALOG.filter((e) => /original composition|backing style|unknown|various|video|placeholder/i.test(`${e.sourceArtist} ${e.sourceTitle}`)).map((e) => e.title));
check("nothing samples itself", CATALOG.every((e) => !(compact(e.title) === compact(e.sourceTitle) && artistKey(e.artist) === artistKey(e.sourceArtist))));
check("notes are short", CATALOG.every((e) => !e.note || e.note.length <= 90), CATALOG.filter((e) => e.note && e.note.length > 90).map((e) => e.note));
check("the WhoSampled name is nowhere in the list", !JSON.stringify(CATALOG).toLowerCase().includes("whosampled"));
{
  const interp = (artist: string, title: string, source: string) =>
    CATALOG.find((e) => e.artist === artist && e.title === title && e.sourceTitle === source)?.element === "interpolation";
  check("interpolations are marked as such", [
    interp("Coolio", "Gangsta's Paradise", "Pastime Paradise"),
    interp("Snoop Dogg", "Gin and Juice", "Watching You"),
    interp("Sugarhill Gang", "Rapper's Delight", "Good Times"),
    interp("Cardi B", "Bodak Yellow", "No Flockin"),
    interp("Dua Lipa", "Break My Heart", "Need You Tonight"),
    interp("Ariana Grande", "7 rings", "My Favorite Things"),
    interp("Beyoncé", "BREAK MY SOUL", "Show Me Love"),
    interp("Grandmaster & Melle Mel", "White Lines (Don't Don't Do It)", "Cavern"),
  ].every(Boolean));
}
{
  const find = (title: string) => CATALOG.filter((e) => e.title === title || e.sourceTitle === title);
  check("corrections: Jessica is 1969, Numbers 1981, Fate 1981, T.L. Barrett 1971",
    find("Jessica")[0]?.sourceYear === 1969 && find("Numbers")[0]?.sourceYear === 1981 && find("Fate")[0]?.sourceYear === 1981 && find("Father I Stretch My Hands")[0]?.sourceYear === 1971);
  check("corrections: Apache is a cover, Tom's Diner a remix",
    CATALOG.find((e) => e.artist === "Sugarhill Gang" && e.title === "Apache")?.relation === "cover" && CATALOG.find((e) => e.artist === "DNA")?.relation === "remix");
  check("corrections: New Slaves is a direct vocal sample", CATALOG.find((e) => e.title === "New Slaves")?.element === "vocals-lyrics");
  check("corrections: Cavern belongs to White Lines, not The Message", !CATALOG.some((e) => e.title === "The Message" && e.sourceTitle === "Cavern"));
  check("corrections: Ice Ice Baby is 1989, its first release on Hooked", CATALOG.find((e) => e.title === "Ice Ice Baby")?.year === 1989);
  check("corrections: Boadicea gives its wordless vocal, not a riff", CATALOG.filter((e) => e.sourceTitle === "Boadicea").every((e) => e.element === "vocals-lyrics" && /vocal/.test(e.note ?? "")) && CATALOG.filter((e) => e.sourceTitle === "Boadicea").length === 2);
  check("corrections: Peter Piper takes the bells and percussion", CATALOG.find((e) => e.title === "Peter Piper")?.element === "multiple");
  check("corrections: Come with Me says Jimmy Page replayed his part", /Jimmy Page/.test(CATALOG.find((e) => e.title === "Come with Me")?.note ?? ""));
  {
    const rings = CATALOG.find((e) => e.title === "7 rings");
    check("corrections: 7 rings names the 1959 cast recording, with the writers as another name", rings?.sourceArtist === "The Sound of Music (Original Broadway Cast)" && !!rings.sourceAliases?.artist?.includes("Rodgers & Hammerstein") && roles("Rodgers & Hammerstein", "My Favorite Things").some((x) => x.title === "7 rings"));
  }
  const removed = [["Alright", "Get Lucky"], ["Savage", "Diva"], ["Day 'n' Nite", "Nightmare"], ["Good Days", "In My Bones"], ["Say So", "Good Times"], ["Rapture", "Good Times"], ["Feel Good Inc.", "Feel Good Inc."], ["Rehab", ""], ["Man Down", "Bam Bam"], ["Lean On", ""], ["Lost Ones", ""], ["Sabotage", ""], ["Check the Rhime", ""], ["Fallin'", ""], ["King Kunta", ""]];
  check("removed entries stay out", removed.every(([t, s]) => !CATALOG.some((e) => e.title === t && (!s || e.sourceTitle === s))));
}

// ---------- Matching ----------
{
  const r = roles("Kanye West", "Stronger");
  check("Stronger samples Harder, Better, Faster, Stronger", r.some((x) => x.role === "samples" && x.title === "Harder, Better, Faster, Stronger" && x.year === 2001));
}
{
  const r = roles("Daft Punk", "Harder, Better, Faster, Stronger");
  check("…and the other way: HBFS was sampled in Stronger", r.some((x) => x.role === "sampledBy" && x.title === "Stronger" && x.artist === "Kanye West" && x.year === 2007), r);
  check("HBFS itself samples Cola Bottle Baby", r.some((x) => x.role === "samples" && x.title === "Cola Bottle Baby"));
}
check("Etta James sampled in Levels and Good Feeling", roles("Etta James", "Something's Got a Hold on Me").filter((x) => x.role === "sampledBy").length === 2);
check("a cover both ways", roles("Johnny Cash", "Hurt").some((x) => x.role === "covers" && x.artist === "Nine Inch Nails") && roles("Nine Inch Nails", "Hurt").some((x) => x.role === "coveredBy" && x.artist === "Johnny Cash"));
check("a remix both ways", roles("DNA", "Tom's Diner").some((x) => x.role === "remixOf") && roles("Suzanne Vega", "Tom's Diner").some((x) => x.role === "remixedBy"));
check("Kendrick Lamar's \"i\" finds That Lady", roles("Kendrick Lamar", "i").some((x) => x.title.startsWith("That Lady")));
check("…but \"i\" doesn't match his other songs", roles("Kendrick Lamar", "Alright").length === 0 && roles("Kendrick Lamar", "King Kunta").length === 0);
check("Apache doesn't catch Made You Look's other rows", roles("Nas", "Made You Look").length === 1);
check("Good Times (Chic) isn't Good Times (The Persuasions)", roles("Chic", "Good Times").every((x) => x.artist !== "Jamie xx") && roles("The Persuasions", "Good Times").every((x) => x.artist === "Jamie xx"));
check("Beyoncé = Beyonce", roles("Beyonce", "Crazy in Love").length === 1);
check("Sinéad = Sinead", roles("Sinead O'Connor", "Nothing Compares 2 U").length === 1);
check("Biggie alias", roles("Biggie", "Juicy").length === 1);
check("feat. credits still match", roles("Kanye West feat. T-Pain", "Good Life").length === 1 && roles("Jay-Z feat. Alicia Keys", "Empire State of Mind").length === 1);
check("a duo credit matches either name", roles("Kanye West", "Otis").length === 1 && roles("JAY-Z", "Otis").length === 1);
check("Queen & David Bowie: Queen alone matches", roles("Queen", "Under Pressure").some((x) => x.title === "Ice Ice Baby"));
check("a bracketed subtitle is optional when asked without it", roles("Jay-Z", "Hard Knock Life").length === 1);
check("…but SWV's plain \"Right Here\" isn't the Human Nature remix", roles("SWV", "Right Here").length === 0 && roles("SWV", "Right Here (Human Nature Remix)").length === 1);
{
  // A remix or live version is its own record: it doesn't take the original's connections.
  const remix = roles("Daft Punk", "Harder, Better, Faster, Stronger (The Neptunes remix)");
  check("a \"(X remix)\" doesn't inherit the original's rows", remix.length === 0, remix);
  check("…nor \"(Live)\", \"- Acoustic\" or \"[Extended Mix]\"", roles("Kanye West", "Stronger (Live)").length === 0 && roles("Kanye West", "Stronger - Acoustic").length === 0 && roles("Stardust", "Music Sounds Better with You [Extended Mix]").length === 0);
  check("…nor gets the original's year", catalogYear({ artist: "Daft Punk", title: "Harder, Better, Faster, Stronger (The Neptunes remix)" }) === null);
  check("…but decoration still comes off: \"(Remastered 2009)\", \"(Radio Edit)\", \"(feat. T-Pain)\"", roles("Kanye West", "Stronger (Remastered 2009)").length === 1 && roles("Kanye West", "Stronger (Radio Edit)").length === 1 && roles("Kanye West", "Good Life (feat. T-Pain)").length === 1);
}
check("guarded containment: 6+ chars and 60% of the longer", titleMatches("Got You All in Check", "Woo Hah!! Got You All in Check") && !titleMatches("Stronger", "Harder, Better, Faster, Stronger") && !titleMatches("Good", "Good Times"));
check("unknown song → nothing", roles("Nobody Real", "A Song That Does Not Exist").length === 0);
check("no artist → nothing (titles alone are too loose)", roles("", "Stronger").length === 0);
check("catalog year", catalogYear({ artist: "Kanye West", title: "Stronger" }) === 2007 && catalogYear({ artist: "Daft Punk", title: "Harder, Better, Faster, Stronger" }) === 2001);
check("hand-checked rows say so and carry the note", roles("Kanye West", "Stronger").every((x) => x.source === "catalog") && !!roles("Kanye West", "Stronger")[0].note);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);

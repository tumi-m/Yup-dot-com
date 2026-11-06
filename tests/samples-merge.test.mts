/**
 * Merging the hand-checked list with MusicBrainz (lib/samples/merge.ts):
 * the catalog row wins and MusicBrainz fills in its id and year, one row per
 * connection, rows ordered by year, the tab counts and the "years apart"
 * facts.
 */
import { firstTab, mergeRelations, oldestSample, sampledSpan, tabCounts, yearsApart } from "../lib/samples/merge.ts";
import type { Relation } from "../lib/samples/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const cat = (r: Partial<Relation> & Pick<Relation, "role" | "title" | "artist">): Relation => ({ year: null, source: "catalog", element: "multiple", note: "hand", ...r });
const mb = (r: Partial<Relation> & Pick<Relation, "role" | "title" | "artist">): Relation => ({ year: null, source: "musicbrainz", element: null, ...r });

{
  const merged = mergeRelations(
    [cat({ role: "samples", title: "Harder, Better, Faster, Stronger", artist: "Daft Punk", year: 2001, element: "vocals-lyrics" })],
    [mb({ role: "samples", title: "Harder Better Faster Stronger", artist: "Daft Punk", year: 2001, mbid: "m-1" })]
  );
  check("the catalog row wins over the same connection", merged.length === 1 && merged[0].source === "catalog" && merged[0].element === "vocals-lyrics", merged);
  check("MusicBrainz adds its id", merged[0].mbid === "m-1");
}
{
  const merged = mergeRelations(
    [cat({ role: "samples", title: "Under Pressure", artist: "Queen & David Bowie", year: null })],
    [mb({ role: "samples", title: "Under Pressure", artist: "Queen", year: 1981, mbid: "m-2" })]
  );
  check("…and a missing year, matching by any credited name", merged.length === 1 && merged[0].year === 1981 && merged[0].mbid === "m-2", merged);
}
{
  const merged = mergeRelations(
    [cat({ role: "sampledBy", title: "Stronger", artist: "Kanye West", year: 2007 })],
    [mb({ role: "samples", title: "Stronger", artist: "Kanye West", year: 2007, mbid: "m-3" })]
  );
  check("a different role is a different row", merged.length === 2);
}
{
  const merged = mergeRelations([], [
    mb({ role: "coveredBy", title: "Hurt", artist: "Johnny Cash", mbid: "a" }),
    mb({ role: "coveredBy", title: "Hurt", artist: "Johnny Cash feat. Someone", mbid: "b" }),
  ]);
  check("duplicates by role, title and first credited artist collapse", merged.length === 1, merged);
}
{
  const merged = mergeRelations(
    [cat({ role: "samples", title: "Z catalog", artist: "A", year: 1999 })],
    [
      mb({ role: "samples", title: "Late", artist: "B", year: 1990 }),
      mb({ role: "samples", title: "Early", artist: "C", year: 1970 }),
      mb({ role: "samples", title: "Unknown", artist: "D", year: null }),
      mb({ role: "sampledBy", title: "Old taker", artist: "E", year: 1995 }),
      mb({ role: "sampledBy", title: "New taker", artist: "F", year: 2020 }),
      mb({ role: "remixedBy", title: "Remix", artist: "G", year: 2003 }),
    ]
  );
  const titles = merged.map((r) => r.title);
  check("catalog rows first, then MusicBrainz's", titles[0] === "Z catalog");
  check("samples: oldest first, unknown years last", titles.slice(1, 4).join() === "Early,Late,Unknown", titles);
  check("sampled in: newest first", titles.slice(4, 6).join() === "New taker,Old taker", titles);
  check("roles in order: samples, sampled in, …, remixes", titles[6] === "Remix");
  const counts = tabCounts(merged);
  check("counts per tab", counts.samples === 4 && counts.sampled === 2 && counts.covers === 0 && counts.remixes === 1, counts);
  check("first tab with something", firstTab(counts) === "samples" && firstTab({ samples: 0, sampled: 0, covers: 3, remixes: 0 }) === "covers" && firstTab({ samples: 0, sampled: 0, covers: 0, remixes: 0 }) === "samples");
}
check("covers and covered-by share a tab", tabCounts([mb({ role: "covers", title: "a", artist: "b" }), mb({ role: "coveredBy", title: "c", artist: "d" })]).covers === 2);
check("years apart only when both are known", yearsApart(2007, 2001) === 6 && yearsApart(2001, 2007) === 6 && yearsApart(2007, null) === null && yearsApart(undefined, 2001) === null);
{
  const rels = [cat({ role: "samples", title: "a", artist: "x", year: 1937 }), cat({ role: "samples", title: "b", artist: "y", year: 1980 }), cat({ role: "samples", title: "c", artist: "z" })];
  const o = oldestSample(rels, 2003);
  check("oldest sample: 1937, 66 years earlier", o?.year === 1937 && o.apart === 66, o);
  check("no dated samples → nothing", oldestSample([cat({ role: "samples", title: "a", artist: "b" })], 2000) === null);
  check("song year unknown → no gap claimed", oldestSample(rels, null)?.apart === null);
}
{
  const s = sampledSpan([
    cat({ role: "sampledBy", title: "a", artist: "x", year: 1988 }),
    cat({ role: "sampledBy", title: "b", artist: "y", year: 2023 }),
    cat({ role: "sampledBy", title: "c", artist: "z" }),
  ]);
  check("sampled 3 times, 1988–2023", s.count === 3 && s.from === 1988 && s.to === 2023, s);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);

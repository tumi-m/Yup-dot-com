/**
 * Which page of the original goes with which page of the changed version,
 * for showing them side by side and comparing how they look. Pages are
 * paired in order by the words they share, so a page added or taken out in
 * the middle leaves the pages after it paired with their own. Pages with no
 * words in common are paired by their place between two that do.
 */

/** A page of each file shown together; null where one file has no page for it. */
export interface PagePair {
  a: number | null;
  b: number | null;
}

/** The highest total of shared words for pairs in order (a Fenwick tree of best totals so far). */
function bestChain(edges: { a: number; b: number; w: number }[], pagesB: number): { a: number; b: number }[] {
  // By page of the original, and within one page from the last page of the
  // changed version back, so one original page pairs with one page at most.
  edges.sort((x, y) => x.a - y.a || y.b - x.b);
  const tree = new Float64Array(pagesB + 1);
  const at = new Int32Array(pagesB + 1).fill(-1);
  const total = new Float64Array(edges.length);
  const prev = new Int32Array(edges.length).fill(-1);
  const query = (b: number) => {
    // The best chain ending before page b of the changed version.
    let best = 0;
    let from = -1;
    for (let i = b; i > 0; i -= i & -i) {
      if (tree[i] > best) {
        best = tree[i];
        from = at[i];
      }
    }
    return { best, from };
  };
  const update = (b: number, value: number, edge: number) => {
    for (let i = b + 1; i <= pagesB; i += i & -i) {
      if (value > tree[i]) {
        tree[i] = value;
        at[i] = edge;
      }
    }
  };
  let end = -1;
  edges.forEach((e, n) => {
    const { best, from } = query(e.b);
    total[n] = best + e.w;
    prev[n] = from;
    update(e.b, total[n], n);
    if (end < 0 || total[n] > total[end]) end = n;
  });
  const chain: { a: number; b: number }[] = [];
  for (let n = end; n >= 0; n = prev[n]) chain.push({ a: edges[n].a, b: edges[n].b });
  return chain.reverse();
}

/**
 * The pages of both files in reading order, side by side. `shared` counts
 * the words left as they were for each "pageA:pageB".
 */
export function pairPages(shared: Map<string, number>, pagesA: number, pagesB: number): PagePair[] {
  const edges = [...shared].map(([key, w]) => {
    const [a, b] = key.split(":").map(Number);
    return { a, b, w };
  });
  const chain = bestChain(edges, pagesB);
  const out: PagePair[] = [];
  let i = 0;
  let j = 0;
  // Between two paired pages, the pages left over are paired in turn; any extra on one side stand alone.
  const gap = (toA: number, toB: number) => {
    const n = Math.min(toA - i, toB - j);
    for (let k = 0; k < n; k++) out.push({ a: i++, b: j++ });
    while (i < toA) out.push({ a: i++, b: null });
    while (j < toB) out.push({ a: null, b: j++ });
  };
  for (const link of chain) {
    gap(link.a, link.b);
    out.push({ a: i++, b: j++ });
  }
  gap(pagesA, pagesB);
  return out;
}

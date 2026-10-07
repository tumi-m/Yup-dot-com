import type { Chart } from "pptxtojson";
import type { ChartInfo } from "@/lib/pptx/ooxml";

/**
 * A plain SVG rendering of the chart data pptxtojson extracts: bars/columns
 * (clustered, stacked, 100% stacked), lines/areas and pies/doughnuts, with
 * the title and legend read from the chart part (lib/pptx/ooxml.ts
 * chartInfo). Other chart types (and any chart without usable data) get a
 * neutral placeholder. Best effort: the numbers, colours and labels are
 * right, PowerPoint's finer styling is not reproduced.
 */

/** Office's default accents, for decks without theme colours. */
const FALLBACK = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47"];

interface Series {
  name: string;
  values: number[];
}

function seriesOf(chart: Chart): { series: Series[]; labels: string[] } | null {
  if (!Array.isArray(chart.data) || !chart.data.length) return null;
  const first = chart.data[0] as unknown;
  if (!first || typeof first !== "object" || !("values" in (first as object))) return null;
  const items = chart.data as { key: string; values: { x: string; y: number }[]; xlabels: Record<string, string> }[];
  const labels = Object.keys(items[0].xlabels ?? {})
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => String(items[0].xlabels[k]));
  const series = items.map((s) => ({
    name: String(s.key),
    values: (s.values ?? []).map((v) => (Number.isFinite(v.y) ? v.y : 0)),
  }));
  if (!series.some((s) => s.values.length)) return null;
  return { series, labels };
}

/** Axis bounds and ticks on a 1-2-5 step, like an automatic value axis. */
export function niceAxis(min: number, max: number, target = 6): { lo: number; hi: number; ticks: number[] } {
  if (!(max > min)) max = min + 1;
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(+t.toFixed(10));
  return { lo, hi, ticks };
}

function formatTick(v: number, percent: boolean) {
  const n = +v.toPrecision(6);
  return percent ? `${Math.round(n * 100)}%` : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function ChartPlaceholder({ width, height }: { width: number; height: number }) {
  const s = Math.min(width, height) * 0.3;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <rect x={0.5} y={0.5} width={width - 1} height={height - 1} fill="#F4F4F5" stroke="#D4D4D8" />
      <g transform={`translate(${width / 2 - s / 2} ${height / 2 - s / 2})`} fill="#A1A1AA">
        <rect x={0} y={s * 0.5} width={s * 0.22} height={s * 0.5} />
        <rect x={s * 0.39} y={s * 0.2} width={s * 0.22} height={s * 0.8} />
        <rect x={s * 0.78} y={s * 0.35} width={s * 0.22} height={s * 0.65} />
      </g>
    </svg>
  );
}

const clip = (l: string, n: number) => (l.length > n ? `${l.slice(0, n - 1)}…` : l);

export function ChartView({ chart, info, accents }: { chart: Chart; info?: ChartInfo; accents?: string[] }) {
  const { width, height } = chart;
  const data = seriesOf(chart);
  if (!data) return <ChartPlaceholder width={width} height={height} />;
  const palette = accents && accents.length >= 6 ? accents.slice(0, 6) : FALLBACK;
  // Past the six accents, Office cycles them darker.
  const auto = (i: number) => palette[i % palette.length];
  const colors = (i: number) => chart.colors?.[i] || auto(i);
  const font = info?.fontSize ?? Math.max(7, Math.min(12, height / 22));
  const { series, labels } = data;
  const type = chart.chartType;
  const isPie = type === "pieChart" || type === "pie3DChart" || type === "doughnutChart";

  // Title and legend take their space first; the plot gets the rest.
  const title = info?.title;
  const titleH = title ? font * 1.6 : 0;
  const legendItems = info?.legendPos
    ? isPie || (info.varyColors && series.length === 1)
      ? labels.map((l, i) => ({ name: l, color: colors(i) }))
      : series.map((s, i) => ({ name: s.name, color: colors(i) }))
    : [];
  const pos = info?.legendPos ?? "r";
  const side = legendItems.length > 0 && (pos === "r" || pos === "l" || pos === "tr");
  const legendW = side ? Math.min(width * 0.3, font * (2 + Math.max(...legendItems.map((it) => Math.min(it.name.length, 18))) * 0.6)) : 0;
  const legendH = legendItems.length > 0 && !side ? font * 1.8 : 0;
  const box = {
    x: pos === "l" ? legendW : 0,
    y: titleH + (pos === "t" ? legendH : 0),
    w: width - legendW,
    h: height - titleH - legendH,
  };

  const legend = legendItems.length > 0 && (
    <g>
      {side
        ? legendItems.map((it, i) => {
            const y0 = box.y + box.h / 2 - (legendItems.length * font * 1.5) / 2 + i * font * 1.5;
            const x0 = pos === "l" ? font * 0.5 : width - legendW + font * 0.5;
            return (
              <g key={i}>
                <rect x={x0} y={y0 + font * 0.2} width={font * 0.7} height={font * 0.7} fill={it.color} />
                <text x={x0 + font} y={y0 + font * 0.85} fill="#595959">
                  {clip(it.name, 18)}
                </text>
              </g>
            );
          })
        : (() => {
            const widths = legendItems.map((it) => font * (1.6 + Math.min(it.name.length, 18) * 0.55));
            const total = widths.reduce((a, b) => a + b, 0);
            let x0 = Math.max(0, (width - total) / 2);
            const y0 = pos === "t" ? titleH + font * 0.4 : height - legendH + font * 0.4;
            return legendItems.map((it, i) => {
              const x = x0;
              x0 += widths[i];
              return (
                <g key={i}>
                  <rect x={x} y={y0 + font * 0.2} width={font * 0.7} height={font * 0.7} fill={it.color} />
                  <text x={x + font} y={y0 + font * 0.85} fill="#595959">
                    {clip(it.name, 18)}
                  </text>
                </g>
              );
            });
          })()}
    </g>
  );
  const titleNode = title && (
    <text x={width / 2} y={font * 1.2} textAnchor="middle" fontSize={font * 1.2} fill="#404040">
      {clip(title.replace(/\s+/g, " "), 60)}
    </text>
  );

  if (isPie) {
    const values = series[0].values.map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const r = Math.max(1, Math.min(box.w, box.h) * 0.42);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const inner = type === "doughnutChart" ? r * 0.5 : 0;
    let angle = -Math.PI / 2;
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden fontFamily="Arial, sans-serif" fontSize={font}>
        {titleNode}
        {values.map((v, i) => {
          const a0 = angle;
          const a1 = (angle += (v / total) * Math.PI * 2);
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const p = (a: number, rr: number) => `${cx + rr * Math.cos(a)} ${cy + rr * Math.sin(a)}`;
          const d =
            values.length === 1 || v === total
              ? `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`
              : `M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${inner ? p(a1, inner) : `${cx} ${cy}`}` +
                (inner ? ` A ${inner} ${inner} 0 ${large} 0 ${p(a0, inner)}` : "") +
                " Z";
          return <path key={i} d={d} fill={colors(i)} stroke="#fff" strokeWidth={1} />;
        })}
        {inner > 0 && <circle cx={cx} cy={cy} r={inner} fill="#fff" />}
        {legend}
      </svg>
    );
  }

  const n = Math.max(...series.map((s) => s.values.length));
  const grouping = "grouping" in chart ? chart.grouping : undefined;
  const stacked = grouping === "stacked" || grouping === "percentStacked";
  const percent = grouping === "percentStacked";
  // Stacked charts draw each series from the running total of those before it.
  const totals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + Math.abs(s.values[i] ?? 0), 0) || 1);
  const scaled = series.map((s) => s.values.map((v, i) => (percent ? v / totals[i] : v)));
  const base: number[][] = [];
  const top: number[][] = [];
  {
    const pos0 = new Array(n).fill(0);
    const neg0 = new Array(n).fill(0);
    scaled.forEach((vals, si) => {
      base[si] = [];
      top[si] = [];
      for (let i = 0; i < n; i++) {
        const v = vals[i] ?? 0;
        if (!stacked) {
          base[si][i] = 0;
          top[si][i] = v;
        } else if (v >= 0) {
          base[si][i] = pos0[i];
          top[si][i] = pos0[i] += v;
        } else {
          base[si][i] = neg0[i];
          top[si][i] = neg0[i] += v;
        }
      }
    });
  }
  const all = top.flat().concat(base.flat());
  const axis = percent
    ? niceAxis(Math.min(0, ...all), Math.max(0, ...all) || 1)
    : niceAxis(Math.min(0, ...all), Math.max(0, ...all));
  const { lo, hi } = axis;
  const span = hi - lo || 1;
  const tickW = font * 0.6 * Math.max(...axis.ticks.map((t) => formatTick(t, percent).length));
  const horizontal = (type === "barChart" || type === "bar3DChart") && "barDir" in chart && chart.barDir === "bar";
  const isBar = type === "barChart" || type === "bar3DChart";
  const catW = horizontal ? font * 0.68 * Math.min(14, Math.max(...labels.map((l) => l.length), 1)) : 0;
  const pad = {
    l: box.x + font * 0.6 + (horizontal ? catW : tickW),
    r: width - box.x - box.w + font,
    t: box.y + font * 0.6,
    b: height - box.y - box.h + font * (horizontal ? 2 : 1.8),
  };
  const w = Math.max(1, width - pad.l - pad.r);
  const h = Math.max(1, height - pad.t - pad.b);
  const y = (v: number) => pad.t + h - ((v - lo) / span) * h;
  const x = (v: number) => pad.l + ((v - lo) / span) * w;
  const band = (horizontal ? h : w) / Math.max(1, n);
  const groups = stacked ? 1 : series.length;
  const bw = (band * (stacked ? 0.55 : 0.7)) / groups;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden fontFamily="Arial, sans-serif" fontSize={font}>
      {titleNode}
      {axis.ticks.map((t, i) =>
        horizontal ? (
          <g key={i}>
            <line x1={x(t)} x2={x(t)} y1={pad.t} y2={pad.t + h} stroke="#D9D9D9" strokeWidth={0.75} />
            <text x={x(t)} y={pad.t + h + font * 1.3} textAnchor="middle" fill="#595959">
              {formatTick(t, percent)}
            </text>
          </g>
        ) : (
          <g key={i}>
            <line x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} stroke="#D9D9D9" strokeWidth={0.75} />
            <text x={pad.l - font * 0.4} y={y(t) + font / 3} textAnchor="end" fill="#595959">
              {formatTick(t, percent)}
            </text>
          </g>
        )
      )}
      {isBar &&
        series.map((_, si) =>
          top[si].map((t, i) => {
            const b = base[si][i];
            const off = (band - bw * groups) / 2 + (stacked ? 0 : si * bw) + i * band;
            // Bars run top-down in a horizontal chart: the first category is at the bottom.
            if (horizontal) {
              const yy = pad.t + h - off - bw;
              return <rect key={`${si}-${i}`} x={x(Math.min(b, t))} y={yy} width={Math.abs(x(t) - x(b))} height={bw} fill={colors(si)} />;
            }
            return <rect key={`${si}-${i}`} x={pad.l + off} y={y(Math.max(b, t))} width={bw} height={Math.abs(y(t) - y(b))} fill={colors(si)} />;
          })
        )}
      {!isBar &&
        series
          .map((_, si) => {
            const px = (i: number) => pad.l + band * (i + 0.5);
            const pts = top[si].map((v, i) => `${px(i)},${y(v)}`);
            const area = type === "areaChart" || type === "area3DChart";
            if (!area) return <polyline key={si} points={pts.join(" ")} fill="none" stroke={colors(si)} strokeWidth={2} strokeLinejoin="round" />;
            const floor = base[si].map((v, i) => `${px(i)},${y(v)}`).reverse();
            return <polygon key={si} points={[...pts, ...floor].join(" ")} fill={colors(si)} opacity={stacked ? 1 : 0.85} />;
          })
          // Unstacked areas: the first series is drawn in front, as in Office.
          .reverse()}
      {labels.slice(0, n).map((l, i) =>
        horizontal ? (
          <text key={i} x={pad.l - font * 0.4} y={pad.t + h - band * (i + 0.5) + font / 3} textAnchor="end" fill="#595959">
            {clip(l, 14)}
          </text>
        ) : (
          <text key={i} x={pad.l + band * (i + 0.5)} y={pad.t + h + font * 1.3} textAnchor="middle" fill="#595959">
            {clip(l, Math.max(4, Math.floor(band / (font * 0.55))))}
          </text>
        )
      )}
      {horizontal ? (
        <line x1={x(Math.max(lo, 0))} x2={x(Math.max(lo, 0))} y1={pad.t} y2={pad.t + h} stroke="#BFBFBF" strokeWidth={0.75} />
      ) : (
        <line x1={pad.l} x2={pad.l + w} y1={y(Math.max(lo, 0))} y2={y(Math.max(lo, 0))} stroke="#BFBFBF" strokeWidth={0.75} />
      )}
      {legend}
    </svg>
  );
}

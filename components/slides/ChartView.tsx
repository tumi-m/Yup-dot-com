import type { Chart } from "pptxtojson";

/**
 * A plain SVG rendering of the chart data pptxtojson extracts: clustered
 * bars/columns, lines/areas and pies/doughnuts. Other chart types (and any
 * chart without usable data) get a neutral placeholder. Best effort only;
 * the numbers are right but PowerPoint's styling is not reproduced.
 */

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

export function ChartView({ chart }: { chart: Chart }) {
  const { width, height } = chart;
  const data = seriesOf(chart);
  if (!data) return <ChartPlaceholder width={width} height={height} />;
  const colors = (i: number) => chart.colors?.[i] || FALLBACK[i % FALLBACK.length];
  const font = Math.max(7, Math.min(12, height / 22));
  const { series, labels } = data;
  const type = chart.chartType;

  if (type === "pieChart" || type === "pie3DChart" || type === "doughnutChart") {
    const values = series[0].values.map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const r = Math.min(width, height) * 0.42;
    const cx = width / 2;
    const cy = height / 2;
    const inner = type === "doughnutChart" ? r * 0.5 : 0;
    let angle = -Math.PI / 2;
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
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
          return <path key={i} d={d} fill={chart.colors?.[i] || FALLBACK[i % FALLBACK.length]} stroke="#fff" strokeWidth={1} />;
        })}
        {inner > 0 && <circle cx={cx} cy={cy} r={inner} fill="#fff" />}
      </svg>
    );
  }

  const n = Math.max(...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const pad = { l: font * 3, r: font, t: font, b: font * 2.2 };
  const w = Math.max(1, width - pad.l - pad.r);
  const h = Math.max(1, height - pad.t - pad.b);
  const horizontal = (type === "barChart" || type === "bar3DChart") && "barDir" in chart && chart.barDir === "bar";
  const isBar = type === "barChart" || type === "bar3DChart";
  const y = (v: number) => pad.t + h - ((v - min) / span) * h;
  const x = (v: number) => pad.l + ((v - min) / span) * w;
  const ticks = [min, min + span / 2, max];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden fontFamily="Arial, sans-serif" fontSize={font}>
      {!horizontal &&
        ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} stroke="#D9D9D9" strokeWidth={0.75} />
            <text x={pad.l - 4} y={y(t) + font / 3} textAnchor="end" fill="#595959">
              {+t.toFixed(2)}
            </text>
          </g>
        ))}
      {isBar &&
        series.map((s, si) =>
          s.values.map((v, i) => {
            const band = (horizontal ? h : w) / n;
            const bw = (band * 0.7) / series.length;
            const off = band * 0.15 + si * bw + i * band;
            if (horizontal) {
              return <rect key={`${si}-${i}`} x={x(Math.min(0, v))} y={pad.t + off} width={Math.abs(x(v) - x(0))} height={bw} fill={colors(si)} />;
            }
            return <rect key={`${si}-${i}`} x={pad.l + off} y={y(Math.max(0, v))} width={bw} height={Math.abs(y(v) - y(0))} fill={colors(si)} />;
          })
        )}
      {!isBar &&
        series.map((s, si) => {
          const pts = s.values.map((v, i) => `${pad.l + (w / Math.max(1, n)) * (i + 0.5)},${y(v)}`);
          const area = type === "areaChart" || type === "area3DChart";
          return area ? (
            <polygon
              key={si}
              points={`${pad.l + (w / n) * 0.5},${y(0)} ${pts.join(" ")} ${pad.l + (w / n) * (s.values.length - 0.5)},${y(0)}`}
              fill={colors(si)}
              opacity={0.85}
            />
          ) : (
            <polyline key={si} points={pts.join(" ")} fill="none" stroke={colors(si)} strokeWidth={2} />
          );
        })}
      {!horizontal &&
        labels.slice(0, n).map((l, i) => (
          <text key={i} x={pad.l + (w / n) * (i + 0.5)} y={pad.t + h + font * 1.3} textAnchor="middle" fill="#595959">
            {l.length > 14 ? `${l.slice(0, 13)}…` : l}
          </text>
        ))}
      <line x1={pad.l} x2={pad.l + w} y1={y(0)} y2={y(0)} stroke="#BFBFBF" strokeWidth={0.75} />
    </svg>
  );
}

"use client";
import React, { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  Brush,
  ReferenceArea,
  BarChart,
  Bar,
  ResponsiveContainer,
} from "recharts";

// ==========================
// Telemetry Explorer (Low‑Fi)
// - Top: Run/Session navigator across many test days
// - Center: Zoomable time‑series with Brush + optional thresholds & overlays
// - Right: Distribution (histogram) of the visible window + quick stats
// - Extras: Compare mode between two runs, annotations, basic decimation
// ==========================

// -------- Types --------
interface Session {
  id: string;
  start: number; // epoch ms
  end: number;   // epoch ms
}

interface RunDay {
  id: string;      // e.g., 2025-06-14
  dateLabel: string;
  sessions: Session[];
}

type ChannelKey = "packCurrent" | "inverterTemp" | "wheelFL" | "wheelFR";

interface Sample {
  t: number; // epoch ms
  packCurrent: number | null;
  inverterTemp: number | null;
  wheelFL: number | null;
  wheelFR: number | null;
}

interface RunData {
  run: RunDay;
  samples: Sample[]; // sparsity allowed; nulls mark missing segments
}

// -------- Utilities --------
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

function rand(seed: number) {
  // deterministic PRNG for stable demo
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}

function generateMockRuns(): RunData[] {
  // Create ~6 test days spread across the year, each with 2-3 sessions of ~20–40 minutes
  const base = Date.UTC(2025, 2, 1, 16, 0, 0); // Mar 1, 2025 16:00 UTC
  const days = [0, 15, 37, 78, 123, 181].map((offset) => new Date(base + offset * 24 * 3600 * 1000));

  return days.map((date, i) => {
    const dayId = date.toISOString().slice(0, 10);
    const r = rand(42 + i * 17);

    // sessions at 10:00, 13:00, (optionally) 15:30 local UTC for simplicity
    const sCount = 2 + (i % 2);
    const sessions: Session[] = [];
    const sessionStarts = [10 * 3600 * 1000, 13 * 3600 * 1000, 15.5 * 3600 * 1000];

    for (let s = 0; s < sCount; s++) {
      const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0) + sessionStarts[s];
      const durMin = 20 + Math.floor(r() * 20); // 20–40 minutes
      sessions.push({ id: `${dayId}-S${s + 1}`, start, end: start + durMin * 60_000 });
    }

    // Generate samples at 1 Hz, only during sessions
    const samples: Sample[] = [];
    sessions.forEach((sess) => {
      for (let t = sess.start; t <= sess.end; t += 1000) {
        // synthetic signals
        const tt = (t - sessions[0].start) / 1000; // seconds from first session start
        const noise = () => (r() - 0.5);
        const packCurrent = 120 * Math.sin(0.004 * tt) + 10 * noise(); // A
        const inverterTemp = 40 + 0.015 * tt + 2 * noise(); // °C rising
        const wheelFL = 20 + 5 * Math.sin(0.1 * tt) + 0.5 * noise(); // m/s
        const wheelFR = 20 + 5 * Math.sin(0.1 * tt + 0.02) + 0.5 * noise();
        samples.push({ t, packCurrent, inverterTemp, wheelFL, wheelFR });
      }
      // Insert a small gap (missing data) after each session except last
      samples.push({ t: sess.end + 1, packCurrent: null, inverterTemp: null, wheelFL: null, wheelFR: null });
    });

    return {
      run: {
        id: dayId,
        dateLabel: new Date(date).toDateString(),
        sessions,
      },
      samples,
    } as RunData;
  });
}

// Downsample preserving spikes: split into buckets, keep min & max (envelope)
function envelopeDownsample(data: Sample[], bucketCount: number, keys: ChannelKey[], tMin: number, tMax: number): Sample[] {
  if (!data.length || bucketCount <= 0) return data;
  const domain = tMax - tMin || 1;
  const buckets: Sample[][] = Array.from({ length: bucketCount }, () => []);
  for (const d of data) {
    if (d.t < tMin || d.t > tMax) continue;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(((d.t - tMin) / domain) * bucketCount)));
    buckets[idx].push(d);
  }
  const out: Sample[] = [];
  buckets.forEach((bucket) => {
    if (bucket.length === 0) return;
    // always include first and last to keep edges crisp
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    out.push(first);
    keys.forEach((k) => {
      // compute min & max for non-null values
      let minS: Sample | null = null;
      let maxS: Sample | null = null;
      for (const s of bucket) {
        const v = s[k];
        if (v == null) continue;
        if (!minS || (minS[k]! as number) > v) minS = s;
        if (!maxS || (maxS[k]! as number) < v) maxS = s;
      }
      if (minS && minS !== first && minS !== last) out.push(minS);
      if (maxS && maxS !== first && maxS !== last) out.push(maxS);
    });
    if (last !== first) out.push(last);
  });
  // Sort by time to keep tooltips sane
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Histogram util
function makeHistogram(values: number[], bins = 24) {
  if (!values.length) return [] as { bin: string; count: number }[];
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const width = vMax - vMin || 1;
  const counts = new Array(bins).fill(0);
  const edges: number[] = [];
  for (let i = 0; i <= bins; i++) edges.push(vMin + (i * width) / bins);
  values.forEach((v) => {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(((v - vMin) / width) * bins)));
    counts[idx]++;
  });
  return counts.map((c, i) => ({ bin: `${edges[i].toFixed(1)}–${edges[i + 1].toFixed(1)}`, count: c }));
}

function stats(values: number[]) {
  if (!values.length) return { mean: 0, min: 0, max: 0, std: 0 };
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const v = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(v);
  return { mean, min, max, std };
}

// -------- Main Component --------
export default function TelemetryExplorer() {
  const runs = useMemo(() => generateMockRuns(), []);
  const [primaryRunIdx, setPrimaryRunIdx] = useState(0);
  const [compareRunIdx, setCompareRunIdx] = useState<number | null>(null);

  const [selectedChannels, setSelectedChannels] = useState<ChannelKey[]>([
    "packCurrent",
    "inverterTemp",
  ]);

  const [thresholds, setThresholds] = useState<{ [K in ChannelKey]?: { lo?: number; hi?: number } }>({
    inverterTemp: { hi: 85 },
  });

  // Visible domain (ms). Start with full primary run
  const primary = runs[primaryRunIdx];
  const [domain, setDomain] = useState<[number, number]>([primary.samples[0]?.t ?? 0, primary.samples.slice(-1)[0]?.t ?? 1]);

  useEffect(() => {
    const p = runs[primaryRunIdx];
    if (p.samples.length) setDomain([p.samples[0].t, p.samples.slice(-1)[0].t]);
  }, [primaryRunIdx, runs]);

  // Filter visible samples and downsample for perf
  const visiblePrimary = useMemo(() => {
    const [t0, t1] = domain;
    const windowed = primary.samples.filter((s) => s.t >= t0 && s.t <= t1);
    return envelopeDownsample(windowed, 800, selectedChannels, t0, t1);
  }, [primary, domain, selectedChannels]);

  const visibleCompare = useMemo(() => {
    if (compareRunIdx == null) return null;
    const r = runs[compareRunIdx];
    const [t0, t1] = domain;
    const w = r.samples.filter((s) => s.t >= t0 && s.t <= t1);
    return envelopeDownsample(w, 800, selectedChannels, t0, t1);
  }, [compareRunIdx, runs, domain, selectedChannels]);

  const channelMeta: Record<ChannelKey, { label: string; unit: string; yDomain?: [number, number] }> = {
    packCurrent: { label: "Pack Current", unit: "A", yDomain: [-160, 160] },
    inverterTemp: { label: "Inverter Temp", unit: "°C", yDomain: [20, 120] },
    wheelFL: { label: "Wheel Speed FL", unit: "m/s", yDomain: [0, 40] },
    wheelFR: { label: "Wheel Speed FR", unit: "m/s", yDomain: [0, 40] },
  };

  // Histogram & stats for active channel (first selected)
  const activeChannel: ChannelKey = selectedChannels[0] ?? "packCurrent";
  const valuesPrimary = useMemo(() => visiblePrimary.map((d) => d[activeChannel]).filter((v): v is number => v != null), [visiblePrimary, activeChannel]);
  const histPrimary = useMemo(() => makeHistogram(valuesPrimary, 24), [valuesPrimary]);
  const statsPrimary = useMemo(() => stats(valuesPrimary), [valuesPrimary]);

  const valuesCompare = useMemo(() =>
    visibleCompare ? visibleCompare.map((d) => d[activeChannel]).filter((v): v is number => v != null) : [],
  [visibleCompare, activeChannel]);
  const statsCompare = useMemo(() => stats(valuesCompare), [valuesCompare]);

  return (
    <div className="min-h-screen w-full bg-white text-gray-900">
      {/* Header */}
      <div className="px-6 py-4 border-b sticky top-0 bg-white z-10">
        <h1 className="text-2xl font-semibold">Telemetry Explorer</h1>
        <p className="text-sm text-gray-600">Explore historical signals across test days. Brush to zoom, toggle channels, compare runs, and inspect distributions.</p>
      </div>

      {/* Content grid */}
      <div className="grid grid-cols-12 gap-4 p-6">
        {/* Left: Controls */}
        <aside className="col-span-3 xl:col-span-2 space-y-4">
          <section className="p-4 border rounded-2xl shadow-sm">
            <h2 className="font-medium mb-3">Signals</h2>
            {(['packCurrent','inverterTemp','wheelFL','wheelFR'] as ChannelKey[]).map((key) => (
              <label key={key} className="flex items-center gap-2 py-1">
                <input
                  type="checkbox"
                  checked={selectedChannels.includes(key)}
                  onChange={(e) => {
                    setSelectedChannels((prev) =>
                      e.target.checked ? [...prev, key] : prev.filter((k) => k !== key)
                    );
                  }}
                />
                <span className="text-sm">{channelMeta[key].label} <span className="text-gray-500">({channelMeta[key].unit})</span></span>
              </label>
            ))}
          </section>

          <section className="p-4 border rounded-2xl shadow-sm">
            <h2 className="font-medium mb-3">Thresholds (active chart)</h2>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-14 text-sm">Low</span>
                <input
                  className="flex-1 border rounded px-2 py-1 text-sm"
                  type="number"
                  value={thresholds[activeChannel]?.lo ?? ""}
                  onChange={(e) => setThresholds((prev) => ({ ...prev, [activeChannel]: { ...prev[activeChannel], lo: e.target.value === "" ? undefined : parseFloat(e.target.value) } }))}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-14 text-sm">High</span>
                <input
                  className="flex-1 border rounded px-2 py-1 text-sm"
                  type="number"
                  value={thresholds[activeChannel]?.hi ?? ""}
                  onChange={(e) => setThresholds((prev) => ({ ...prev, [activeChannel]: { ...prev[activeChannel], hi: e.target.value === "" ? undefined : parseFloat(e.target.value) } }))}
                />
              </div>
              <p className="text-xs text-gray-500">Threshold guides render only for the first selected signal.</p>
            </div>
          </section>

          <section className="p-4 border rounded-2xl shadow-sm">
            <h2 className="font-medium mb-3">Compare Runs</h2>
            <div className="space-y-2">
              <select
                className="w-full border rounded px-2 py-1 text-sm"
                value={compareRunIdx ?? ""}
                onChange={(e) => setCompareRunIdx(e.target.value === "" ? null : parseInt(e.target.value))}
              >
                <option value="">None</option>
                {runs.map((r, idx) => idx !== primaryRunIdx && (
                  <option key={r.run.id} value={idx}>{r.run.dateLabel}</option>
                ))}
              </select>
              {compareRunIdx != null && (
                <p className="text-xs text-gray-600">Overlaying <strong>{runs[compareRunIdx].run.dateLabel}</strong> on the primary run.</p>
              )}
            </div>
          </section>

          <section className="p-4 border rounded-2xl shadow-sm">
            <h2 className="font-medium mb-3">Export</h2>
            <button
              className="w-full rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              onClick={() => {
                // Export visible primary window as CSV
                const rows = visiblePrimary.map((d) => (
                  [d.t, d.packCurrent ?? "", d.inverterTemp ?? "", d.wheelFL ?? "", d.wheelFR ?? ""].join(",")
                ));
                const header = "timestamp,packCurrent,inverterTemp,wheelFL,wheelFR\n";
                const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `telemetry_${runs[primaryRunIdx].run.id}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download visible window (CSV)
            </button>
          </section>
        </aside>

        {/* Center: Charts */}
        <main className="col-span-9 xl:col-span-7 space-y-4">
          {/* Run/Session Navigator */}
          <section className="p-4 border rounded-2xl shadow-sm">
            <h2 className="font-medium mb-3">Run Navigator</h2>
            <div className="flex flex-col gap-2">
              {runs.map((r, idx) => (
                <div key={r.run.id} className="flex items-center gap-3">
                  <button
                    className={`text-sm px-2 py-1 rounded border ${idx === primaryRunIdx ? "bg-gray-900 text-white" : "hover:bg-gray-50"}`}
                    onClick={() => setPrimaryRunIdx(idx)}
                    title="Set as primary"
                  >
                    {r.run.dateLabel}
                  </button>
                  <div className="flex-1 h-3 rounded bg-gray-100 overflow-hidden relative">
                    {r.run.sessions.map((s) => {
                      const dayStart = Date.UTC(new Date(r.run.dateLabel).getUTCFullYear(), new Date(r.run.dateLabel).getUTCMonth(), new Date(r.run.dateLabel).getUTCDate(), 0, 0, 0);
                      const dayEnd = dayStart + 24 * 3600 * 1000;
                      const left = ((s.start - dayStart) / (dayEnd - dayStart)) * 100;
                      const width = ((s.end - s.start) / (dayEnd - dayStart)) * 100;
                      return (
                        <div
                          key={s.id}
                          className="absolute top-0 bottom-0 bg-gray-400/70 hover:bg-gray-500 cursor-pointer"
                          style={{ left: `${left}%`, width: `${width}%` }}
                          title={`${fmtTime(s.start)} – ${fmtTime(s.end)}`}
                          onClick={() => setDomain([s.start, s.end])}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Time Series */}
          <section className="p-4 border rounded-2xl shadow-sm">
            <h2 className="font-medium mb-3">Time Series</h2>
            <div className="w-full h-[420px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={visiblePrimary} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={[domain[0], domain[1]]}
                    tickFormatter={(v) => new Date(v).toLocaleTimeString()}
                  />
                  <YAxis yAxisId={1} orientation="left" allowDataOverflow domain={channelMeta[activeChannel].yDomain} />
                  <YAxis yAxisId={2} orientation="right" hide />
                  <Tooltip labelFormatter={(l) => fmtTime(Number(l))} />
                  <Legend />

                  {selectedChannels.map((key) => (
                    <Line
                      key={key}
                      yAxisId={1}
                      type="monotone"
                      dataKey={key}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls={false}
                      name={channelMeta[key].label}
                    />
                  ))}

                  {/* Optional compare overlay */}
                  {visibleCompare && selectedChannels.map((key) => (
                    <Line
                      key={`cmp-${key}`}
                      yAxisId={2}
                      type="monotone"
                      data={visibleCompare}
                      dataKey={key}
                      strokeDasharray="4 4"
                      dot={false}
                      isAnimationActive={false}
                      connectNulls={false}
                      name={`${channelMeta[key].label} (compare)`}
                    />
                  ))}

                  {/* Threshold guides for active channel */}
                  {thresholds[activeChannel]?.lo != null && (
                    <ReferenceArea y1={-1e9} y2={thresholds[activeChannel]!.lo} yAxisId={1} />
                  )}
                  {thresholds[activeChannel]?.hi != null && (
                    <ReferenceArea y1={thresholds[activeChannel]!.hi} y2={1e9} yAxisId={1} />
                  )}

                  <Brush
                    dataKey="t"
                    height={24}
                    travellerWidth={8}
                    tickFormatter={(v) => new Date(v).toLocaleTimeString()}
                    onChange={(range) => {
                      if (!range) return;
                      const { startIndex, endIndex } = range as { startIndex: number; endIndex: number };
                      const arr = primary.samples;
                      if (arr[startIndex] && arr[endIndex]) setDomain([arr[startIndex].t, arr[endIndex].t]);
                    }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Session boundaries overlay info */}
            <div className="mt-2 text-xs text-gray-500">
              Click a session bar in the navigator to zoom that window. Use the brush below the chart to refine.
            </div>
          </section>
        </main>

        {/* Right: Distribution & Stats */}
        <aside className="col-span-12 xl:col-span-3 space-y-4">
          <section className="p-4 border rounded-2xl shadow-sm">
            <h2 className="font-medium mb-3">Distribution (visible window)</h2>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={histPrimary}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="bin" hide />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="p-2 rounded bg-gray-50">
                <div className="text-gray-500">Mean</div>
                <div className="font-mono">{statsPrimary.mean.toFixed(2)} {channelMeta[activeChannel].unit}</div>
              </div>
              <div className="p-2 rounded bg-gray-50">
                <div className="text-gray-500">Std dev</div>
                <div className="font-mono">{statsPrimary.std.toFixed(2)} {channelMeta[activeChannel].unit}</div>
              </div>
              <div className="p-2 rounded bg-gray-50">
                <div className="text-gray-500">Min</div>
                <div className="font-mono">{statsPrimary.min.toFixed(2)} {channelMeta[activeChannel].unit}</div>
              </div>
              <div className="p-2 rounded bg-gray-50">
                <div className="text-gray-500">Max</div>
                <div className="font-mono">{statsPrimary.max.toFixed(2)} {channelMeta[activeChannel].unit}</div>
              </div>
            </div>
          </section>

          <section className="p-4 border rounded-2xl shadow-sm">
            <h2 className="font-medium mb-3">Compare Stats</h2>
            {compareRunIdx == null ? (
              <p className="text-sm text-gray-600">Select a run to compare in the left panel.</p>
            ) : (
              <div className="text-sm space-y-2">
                <div>
                  <div className="text-gray-500">Primary mean</div>
                  <div className="font-mono">{statsPrimary.mean.toFixed(2)} {channelMeta[activeChannel].unit}</div>
                </div>
                <div>
                  <div className="text-gray-500">Compare mean</div>
                  <div className="font-mono">{statsCompare.mean.toFixed(2)} {channelMeta[activeChannel].unit}</div>
                </div>
                <div>
                  <div className="text-gray-500">Δ mean</div>
                  <div className="font-mono">{(statsPrimary.mean - statsCompare.mean).toFixed(2)} {channelMeta[activeChannel].unit}</div>
                </div>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

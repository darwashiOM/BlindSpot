"use client";

import React, { useEffect, useMemo, useState } from "react";
import MapGL, { NavigationControl } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import DeckGL from "@deck.gl/react";
import { GeoJsonLayer } from "@deck.gl/layers";
import { cellToBoundary, cellToLatLng } from "h3-js";

type TrendRow = {
  DAY: string;
  YES_REPORTS: number;
  NO_REPORTS: number;
  SIGNAGE_MENTIONS: number;
  ACTIVE_CELLS: number;
  CONFLICT_RATE_CELLS: number;
  CONFIRMED_CELLS: number;
};

type OverviewRow = {
  FROM_DAY: string;
  TO_DAY: string;
  YES_REPORTS: number;
  NO_REPORTS: number;
  SIGNAGE_MENTIONS: number;
  ACTIVE_CELLS: number;
  CONFLICT_CELLS: number;
  CONFLICT_RATE: number;
  CONFIRMED_CELLS: number;
};

type HeatRow = {
  H3: string;
  D: string;
  YES: number;
  NO: number;
  SIGNAGE: number;
  CONFLICT: boolean;
  CONFIDENCE_TIER: string;
  PLACE_NAME?: string | null;
  PLACE_KIND?: string | null;
  SUMMARY?: string | null;
  SIGNAGE_TEXT?: string | null;
  DETAILS?: any;
};

function fmtPct(x: any) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "0%";
  return `${Math.round(n * 100)}%`;
}

function h3ToFeature(h3: string, props: Record<string, any>) {
  const boundary: any[] = cellToBoundary(h3, true);
  const coords = boundary.map((pt: any) => {
    if (Array.isArray(pt)) return [Number(pt[0]), Number(pt[1])];
    if (pt && typeof pt === "object") return [Number(pt.lng), Number(pt.lat)];
    return pt;
  });
  coords.push(coords[0]);

  return {
    type: "Feature",
    properties: props,
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}

function tierColor(tier: string, conflict: boolean) {
  if (conflict) return [255, 0, 255, 150];

  if (tier === "confirmed") return [140, 0, 255, 170];
  if (tier === "some_confirmation") return [255, 140, 0, 150];
  if (tier === "single_report") return [255, 235, 0, 140];
  if (tier === "reports_no_cameras") return [255, 80, 80, 150];

  return [0, 0, 0, 0];
}

function TrendChart({ rows }: { rows: TrendRow[] }) {
  if (!rows.length) return null;

  const w = 560;
  const h = 180;
  const pad = 28;

  const ys = rows.map((r) => Number(r.YES_REPORTS || 0));
  const ns = rows.map((r) => Number(r.NO_REPORTS || 0));
  const maxY = Math.max(1, ...ys, ...ns);

  const xAt = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, rows.length - 1);
  const yAt = (v: number) => h - pad - (v * (h - pad * 2)) / maxY;

  const yesPts = rows.map((r, i) => `${xAt(i)},${yAt(Number(r.YES_REPORTS || 0))}`).join(" ");
  const noPts = rows.map((r, i) => `${xAt(i)},${yAt(Number(r.NO_REPORTS || 0))}`).join(" ");

  return (
    <svg width={w} height={h} style={{ width: "100%", height: "auto", display: "block" }}>
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="rgba(255,255,255,0.25)" />
      <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="rgba(255,255,255,0.25)" />

      <polyline points={yesPts} fill="none" stroke="rgba(0,255,200,0.95)" strokeWidth={2.5} />
      <polyline points={noPts} fill="none" stroke="rgba(255,120,120,0.95)" strokeWidth={2.5} />

      <text x={pad} y={pad - 8} fontSize={11} fill="rgba(255,255,255,0.75)">
        Reports last 14 days (yes vs no)
      </text>

      <text x={w - pad - 140} y={pad - 8} fontSize={11} fill="rgba(0,255,200,0.95)">
        Yes
      </text>
      <text x={w - pad - 80} y={pad - 8} fontSize={11} fill="rgba(255,120,120,0.95)">
        No
      </text>
    </svg>
  );
}

async function fetchJson(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, cache: "no-store" });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) {
    const msg = data?.detail?.message || data?.error || text.slice(0, 200);
    throw new Error(`${r.status} ${r.statusText}: ${msg}`);
  }
  return data ?? {};
}

export default function DashboardPage() {
  const [overview, setOverview] = useState<OverviewRow | null>(null);
  const [trends, setTrends] = useState<TrendRow[]>([]);
  const [day, setDay] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [heat, setHeat] = useState<HeatRow[]>([]);
  const [loadingHeat, setLoadingHeat] = useState(false);
  const [loadingTop, setLoadingTop] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [viewState, setViewState] = useState({
    longitude: -75.75,
    latitude: 39.68,
    zoom: 12,
    bearing: 0,
    pitch: 0,
  });

  const headers: Record<string, string> = {};
  if (process.env.NEXT_PUBLIC_ANALYTICS_SECRET) {
    headers["x-analytics-secret"] = process.env.NEXT_PUBLIC_ANALYTICS_SECRET;
  }

  useEffect(() => {
    (async () => {
      try {
        setLoadingTop(true);
        setErr(null);

        const [o, t] = await Promise.all([
          fetch("/api/analytics/overview", { headers }).then((r) => r.json()),
          fetch("/api/analytics/trends", { headers }).then((r) => r.json()),
        ]);

        setOverview(o?.row || null);
        setTrends(Array.isArray(t?.rows) ? t.rows : []);
      } catch (e: any) {
        setErr(String(e?.message || e));
      } finally {
        setLoadingTop(false);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoadingHeat(true);
        setErr(null);

        const [o, t] = await Promise.all([
            fetchJson("/api/analytics/overview", { headers }),
            fetchJson("/api/analytics/trends", { headers }),
            ]);

            const r = await fetchJson(`/api/analytics/heatmap?day=${encodeURIComponent(day)}`, { headers });
        setHeat(Array.isArray(r?.rows) ? r.rows : []);
      } catch (e: any) {
        setErr(String(e?.message || e));
        setHeat([]);
      } finally {
        setLoadingHeat(false);
      }
    })();
  }, [day]);

  const heatGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: heat.map((r) =>
        h3ToFeature(r.H3, {
          ...r,
          __tier: String(r.CONFIDENCE_TIER || "low_signal"),
          __conflict: Boolean(r.CONFLICT),
        })
      ),
    };
  }, [heat]);

  const layers = useMemo(() => {
    return [
      new GeoJsonLayer({
        id: "heatmap-res10",
        data: heatGeo as any,
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 1,
        getLineColor: [0, 0, 0, 140],
        getFillColor: (f: any) => tierColor(String(f?.properties?.__tier || ""), Boolean(f?.properties?.__conflict)),
        updateTriggers: {
          getFillColor: [day],
        },
      }),
    ];
  }, [heatGeo, day]);

  const daysForPicker = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, []);

  return (
    <div style={{ position: "relative", height: "100vh", width: "100%" }}>
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 10,
          width: 420,
          maxWidth: "calc(100% - 24px)",
          padding: 14,
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(12,12,18,0.86)",
          color: "white",
          backdropFilter: "blur(10px)",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 15 }}>Blind Spot Dashboard</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 3 }}>
          Snowflake analytics: heatmap, confirmation, conflict, trends
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 130px", padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 11, opacity: 0.7 }}>Confirmed cells</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>
              {overview ? Number(overview.CONFIRMED_CELLS || 0) : loadingTop ? "…" : "0"}
            </div>
          </div>

          <div style={{ flex: "1 1 130px", padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 11, opacity: 0.7 }}>Conflict rate</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>
              {overview ? fmtPct(overview.CONFLICT_RATE) : loadingTop ? "…" : "0%"}
            </div>
          </div>

          <div style={{ flex: "1 1 130px", padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 11, opacity: 0.7 }}>Reports (7d yes/no)</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>
              {overview ? `${Number(overview.YES_REPORTS || 0)}/${Number(overview.NO_REPORTS || 0)}` : loadingTop ? "…" : "0/0"}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <TrendChart rows={trends} />
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ fontSize: 12, opacity: 0.8, fontWeight: 800 }}>Day:</div>
          <select
            value={day}
            onChange={(e) => setDay(e.target.value)}
            style={{
              flex: 1,
              padding: "10px 10px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
              color: "white",
              outline: "none",
              fontSize: 13,
            }}
          >
            {daysForPicker.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{loadingHeat ? "Loading…" : `${heat.length} cells`}</div>
        </div>

        <div style={{ marginTop: 10, fontSize: 11, opacity: 0.75, lineHeight: 1.35 }}>
          Purple means confirmed. Orange and yellow mean some confirmation. Pink means conflict.
        </div>

        {err ? (
          <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,120,120,0.95)" }}>Error: {err}</div>
        ) : null}
      </div>

      <div style={{ position: "absolute", inset: 0 }}>
        <DeckGL
          viewState={viewState}
          controller={true}
          layers={layers}
          onViewStateChange={({ viewState: vs }) => setViewState(vs as any)}
          getTooltip={({ object }: any) => {
            if (!object?.properties) return null;
            const p = object.properties as HeatRow;

            const name = p.PLACE_NAME || "";
            const kind = p.PLACE_KIND ? String(p.PLACE_KIND).replaceAll("_", " ") : "";
            const yes = Number(p.YES || 0);
            const no = Number(p.NO || 0);
            const signage = Number(p.SIGNAGE || 0);

            const head = name ? `${name}${kind ? ` (${kind})` : ""}` : "Cell";
            const line1 = `Yes: ${yes}  No: ${no}  Signage: ${signage}`;
            const line2 = p.CONFLICT ? "Conflict: yes" : "";

            return [head, line1, line2].filter(Boolean).join("\n");
          }}
        >
          <MapGL
            mapLib={maplibregl}
            reuseMaps
            {...viewState}
            pixelRatio={1}
            mapStyle={`https://api.maptiler.com/maps/streets-v2/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`}
          >
            <NavigationControl position="bottom-right" />
          </MapGL>
        </DeckGL>
      </div>
    </div>
  );
}
"use client";

import React, { useMemo, useRef, useState } from "react";
import Map, { NavigationControl, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import DeckGL from "@deck.gl/react";
import { HexagonLayer } from "@deck.gl/aggregation-layers";
import { GeoJsonLayer } from "@deck.gl/layers";
import { latLngToCell, cellToBoundary } from "h3-js";
import { FlyToInterpolator } from "@deck.gl/core";

type Pt = { lat: number; lon: number };

function bboxFromMap(map: maplibregl.Map) {
  const b = map.getBounds();
  const south = b.getSouth();
  const west = b.getWest();
  const north = b.getNorth();
  const east = b.getEast();
  return [south, west, north, east].map((x) => Number(x.toFixed(6))).join(",");
}

async function fileToCompressedDataUrl(
  file: File,
  opts: { maxDim?: number; quality?: number; maxLen?: number } = {}
) {
  const maxDim = opts.maxDim ?? 1100;        // reduce if still too big
  let quality = opts.quality ?? 0.72;        // reduce if still too big
  const maxLen = opts.maxLen ?? 1_800_000;   // about 1.8M chars in the data URL

  const fileToImage = (f: File) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = reject;
      img.src = url;
    });

  const img = await fileToImage(file);

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0, w, h);

  // Try a couple times if still too large
  let out = canvas.toDataURL("image/jpeg", quality);
  while (out.length > maxLen && quality > 0.45) {
    quality -= 0.08;
    out = canvas.toDataURL("image/jpeg", quality);
  }

  return out;
}

// Helper to build natural sounding TTS sentences
function buildTtsText(opts: { reportCount: number; signageCount: number; aiSummary?: string | null; signageText?: string | null }) {
  const { reportCount, signageCount, aiSummary, signageText } = opts;

  if (reportCount >= 5) {
    return `Community confirmed. ${reportCount} reports in this area.`.slice(0, 120);
  }

  if (aiSummary && aiSummary.trim()) return aiSummary.trim().slice(0, 120);

  if (signageText && signageText.trim()) {
    return `Sign text says: ${signageText.trim()}`.slice(0, 120);
  }

  if (reportCount === 0) return "No reports in this area yet.".slice(0, 120);

  const reportPart = reportCount === 1 ? "1 report" : `${reportCount} reports`;
  const signPart =
    signageCount === 0 ? "No signage mentioned." : signageCount === 1 ? "1 sign mentioned." : `${signageCount} signs mentioned.`;

  return `This area has ${reportPart}. ${signPart}`.slice(0, 120);
}

const H3_RES = 9;

export default function Home() {
  const mapRef = useRef<MapRef | null>(null);
  const refreshTimer = useRef<number | null>(null);

  // Added viewState for controlled Map/DeckGL synchronization
  const [viewState, setViewState] = useState({
    longitude: -75.75,
    latitude: 39.68,
    zoom: 8,
    bearing: 0,
    pitch: 0,
  });

  const [mode, setMode] = useState<"privacy" | "safety">("privacy");
  const [points, setPoints] = useState<Pt[]>([]);
  const [loading, setLoading] = useState(false);

  const [reportText, setReportText] = useState("");
  const [proofImage, setProofImage] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ lat: number; lon: number; h3: string } | null>(null);
  const [lastBbox, setLastBbox] = useState<[number, number, number, number] | null>(null);

  const [reportCells, setReportCells] = useState<
    Array<{ 
      h3_index: string; 
      report_count: number; 
      signage_count: number;
      summary?: string;
      signage_text?: string;
    }>
  >([]);

  const [lastError, setLastError] = useState<string | null>(null);

  const panelStyle: React.CSSProperties = {
    position: "absolute",
    zIndex: 10,
    top: 12,
    left: 12,
    width: 380,
    padding: 14,
    borderRadius: 12,
    background: "rgba(10, 12, 16, 0.92)",
    color: "#ffffff",
    border: "1px solid rgba(255,255,255,0.12)",
    boxShadow: "0 12px 30px rgba(0,0,0,0.35)",
    backdropFilter: "blur(10px)",
  };

  const btn = (active?: boolean): React.CSSProperties => ({
    padding: "8px 10px",
    borderRadius: 10,
    border: active ? "1px solid rgba(255,255,255,0.50)" : "1px solid rgba(255,255,255,0.18)",
    background: active ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)",
    color: "white",
    cursor: "pointer",
    fontSize: 13,
  });

  const smallText: React.CSSProperties = {
    marginTop: 8,
    fontSize: 12,
    color: "rgba(255,255,255,0.82)",
    lineHeight: 1.35,
  };

  const legendRow: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
    fontSize: 12,
    color: "rgba(255,255,255,0.85)",
  };

  const swatch = (rgba: string): React.CSSProperties => ({
    width: 14,
    height: 14,
    borderRadius: 4,
    background: rgba,
    border: "1px solid rgba(255,255,255,0.18)",
    flex: "0 0 auto",
  });

  function reportCellsToGeoJSON() {
    return {
      type: "FeatureCollection",
      features: reportCells.map((c) => {
        const boundary = cellToBoundary(c.h3_index, true);
        const coords = boundary.map(([lat, lon]) => [lon, lat]);
        coords.push(coords[0]);

        return {
          type: "Feature",
          properties: c,
          geometry: { type: "Polygon", coordinates: [coords] },
        };
      }),
    };
  }

  async function playTTS(text: string) {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      new Audio(url).play();
      return;
    }

    const err = await res.json().catch(() => ({}));
    if (res.status === 429 && err?.code === "quota_exceeded") {
      const u = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(u);
      return;
    }

    throw new Error(err?.error || "TTS failed");
  }

  function scheduleRefresh() {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refresh();
    }, 250);
  }

  function flyToUser() {
    if (!navigator.geolocation) return;
  
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
  
        setViewState((v) => ({
          ...v,
          latitude,
          longitude,
          zoom: 18, // bigger zoom
          transitionDuration: 1400,
          transitionInterpolator: new FlyToInterpolator(),
        }));
      },
      (err) => {
        console.log("geolocation error:", err?.message);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function refresh() {
    const map = mapRef.current?.getMap();
    if (!map) return;

    setLoading(true);
    setLastError(null);

    const b = map.getBounds();
    setLastBbox([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
    
    const bbox = bboxFromMap(map);

    try {
      const [camsRes, repRes] = await Promise.all([
        fetch(`/api/cameras?bbox=${encodeURIComponent(bbox)}`),
        fetch(`/api/report?bbox=${encodeURIComponent(bbox)}`),
      ]);

      if (!camsRes.ok) {
        const t = await camsRes.text().catch(() => "");
        throw new Error(`cameras failed (${camsRes.status}): ${t.slice(0, 200)}`);
      }
      const camsJson = await camsRes.json();
      setPoints(camsJson.points || []);

      if (!repRes.ok) {
        const t = await repRes.text().catch(() => "");
        throw new Error(`reports failed (${repRes.status}): ${t.slice(0, 200)}`);
      }
      const repJson = await repRes.json();
      setReportCells(repJson.cells || []);
    } catch (e: any) {
      console.error(e);
      setLastError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  const layers = useMemo(() => {
    const reportGeo = reportCellsToGeoJSON();

    const bboxGeo =
      lastBbox
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [lastBbox[1], lastBbox[0]],
                      [lastBbox[3], lastBbox[0]],
                      [lastBbox[3], lastBbox[2]],
                      [lastBbox[1], lastBbox[2]],
                      [lastBbox[1], lastBbox[0]],
                    ],
                  ],
                },
              },
            ],
          }
        : { type: "FeatureCollection", features: [] };

    const selectedGeo = selected
      ? {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              (() => {
                const boundary = cellToBoundary(selected.h3, true);
                const coords = boundary.map(([lat, lon]) => [lon, lat]);
                coords.push(coords[0]);
                return coords;
              })(),
            ],
          },
        }
      : null;

    const mapLayers = [];

    // 1. Red Base Layer
    mapLayers.push(
      new GeoJsonLayer({
        id: "no-camera-red-base",
        data: bboxGeo as any,
        pickable: false,
        stroked: false,
        filled: true,
        getFillColor: [220, 0, 0, 35],
      })
    );

    // 2. Camera Hexagon Layer
    if (points && points.length > 0) {
      const validPoints = points.filter(p => p.lat != null && p.lon != null);
      
      if (validPoints.length > 0) {
        mapLayers.push(
          new HexagonLayer<Pt>({
            id: "surveillance-hex",
            data: validPoints,
            getPosition: (d) => [Number(d.lon), Number(d.lat)],
            radius: 90,
            extruded: false,
            pickable: true,
            opacity: 0.35,
            colorRange: [
              [0, 60, 0],
              [0, 100, 0],
              [0, 140, 0],
              [0, 180, 0],
              [0, 220, 0],
              [0, 255, 0],
            ],
          })
        );
      }
    }

    // 3. Community Reports Layer
    mapLayers.push(
      new GeoJsonLayer({
        id: "community-reports",
        data: reportGeo as any,
        pickable: true,
        stroked: true,
        filled: true,
        getLineColor: [0, 0, 0, 170],
        getFillColor: (f: any) => {
          const n = f.properties.report_count || 0;
          if (n >= 5) return [140, 0, 255, 180]; // Purple for community confirmed
          if (n >= 2) return [255, 140, 0, 165];
          if (n >= 1) return [255, 235, 0, 155];
          return [0, 0, 0, 0];
        },
        lineWidthMinPixels: 2,
      })
    );

    // 4. Selected Cell Outline Layer
    mapLayers.push(
      new GeoJsonLayer({
        id: "selected-cell-outline",
        data: selectedGeo ? { type: "FeatureCollection", features: [selectedGeo] } : { type: "FeatureCollection", features: [] },
        pickable: false,
        stroked: true,
        filled: true,
        getLineColor: [255, 255, 255, 220],
        getFillColor: [255, 255, 255, 30],
        lineWidthMinPixels: 3,
      })
    );

    return mapLayers;
  }, [points, reportCells, selected, lastBbox]);

  return (
    <div style={{ height: "100vh" }}>
      <div style={panelStyle}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>Privacy ↔ Safety</div>

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button style={btn(mode === "privacy")} onClick={() => setMode("privacy")}>
            Privacy
          </button>
          <button style={btn(mode === "safety")} onClick={() => setMode("safety")}>
            Safety
          </button>
          <button style={btn(false)} onClick={refresh}>
            {loading ? "Loading..." : "Refresh"}
          </button>
          {/* New manual locate button */}
          <button style={btn(false)} onClick={flyToUser}>
            Locate me
          </button>
        </div>

        <div style={smallText}>
          {mode === "privacy"
            ? "Privacy mode shows lower monitoring density areas."
            : "Safety mode shows higher monitoring density areas."}
        </div>

        {/* Legend */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Legend</div>

          <div style={legendRow}>
            <span style={swatch("rgba(0, 255, 0, 0.45)")} />
            <span>Green hexes: cameras detected nearby (from OpenStreetMap).</span>
          </div>

          <div style={legendRow}>
            <span style={swatch("rgba(220, 0, 0, 0.14)")} />
            <span>Light red tint: no cameras detected in this view (not a guarantee).</span>
          </div>

          <div style={legendRow}>
            <span style={swatch("rgba(255, 235, 0, 0.55)")} />
            <span>Yellow cell: 1 community report in this H3 area.</span>
          </div>

          <div style={legendRow}>
            <span style={swatch("rgba(255, 140, 0, 0.60)")} />
            <span>Orange cell: 2 to 4 reports (more confidence).</span>
          </div>

          <div style={legendRow}>
            <span style={swatch("rgba(140, 0, 255, 0.70)")} />
            <span>Purple cell: 5 or more reports (community confirmed).</span>
          </div>

          <div style={legendRow}>
            <span style={swatch("rgba(255, 255, 255, 0.20)")} />
            <span>White outline: currently selected cell.</span>
          </div>

          <div style={{ marginTop: 10, fontSize: 11, color: "rgba(255,255,255,0.65)", lineHeight: 1.35 }}>
            Camera data comes from OpenStreetMap tags and may be incomplete. Community reports are user-submitted and can be wrong.
          </div>
        </div>

        {lastError && (
          <div style={{ ...smallText, color: "rgba(255,120,120,0.95)" }}>
            Error: {lastError}
          </div>
        )}

        {selected && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
              <b>Selected cell:</b> {selected.h3}
            </div>
            
            {reportCells.find((c) => c.h3_index === selected.h3)?.report_count! >= 5 && (
              <div style={{ fontSize: 13, color: "#a855f7", fontWeight: "bold", marginTop: 4 }}>
                ✓ Community confirmed
              </div>
            )}

            <textarea
              value={reportText}
              onChange={(e) => setReportText(e.target.value)}
              placeholder="Quick note. Example: Cameras at entrances, signage present."
              style={{
                marginTop: 8,
                width: "100%",
                height: 74,
                padding: 10,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.06)",
                color: "white",
                outline: "none",
              }}
            />

            <div style={{ marginTop: 8 }}>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const dataUrl = await fileToCompressedDataUrl(f);
                  setProofImage(dataUrl);
                }}
              />

              {proofImage && (
                <img
                  src={proofImage}
                  alt="proof"
                  style={{ marginTop: 8, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)" }}
                />
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button
                style={btn(false)}
                onClick={async () => {
                  try {
                    setLastError(null);

                    if (!reportText.trim()) {
                      setLastError("Write a short note before submitting.");
                      return;
                    }

                    if (!proofImage) {
                      setLastError("You must attach a proof photo.");
                      return;
                    }

                    const res = await fetch("/api/report", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        h3_index: selected.h3,
                        lat: selected.lat,
                        lon: selected.lon,
                        mode,
                        user_text: reportText.trim(),
                        signage_image_base64: proofImage,
                      }),
                    });

                    if (!res.ok) {
                      const j = await res.json().catch(() => ({}));
                      throw new Error(j.error || `Report failed (${res.status})`);
                    }

                    setReportText("");
                    setProofImage(null);
                    await refresh();
                  } catch (e: any) {
                    console.error(e);
                    setLastError(String(e?.message || e));
                  }
                }}
              >
                Submit report
              </button>

              <button
                style={btn(false)}
                onClick={async () => {
                  try {
                    setLastError(null);

                    const cell = reportCells.find((c) => c.h3_index === selected.h3);

                    const ttsText = buildTtsText({
                      reportCount: cell?.report_count || 0,
                      signageCount: cell?.signage_count || 0,
                      aiSummary: cell?.summary ?? null,       
                      signageText: cell?.signage_text ?? null 
                    });

                    await playTTS(ttsText);

                  } catch (e: any) {
                    console.error(e);
                    setLastError(String(e?.message || e));
                  }
                }}
              >
                Read aloud
              </button>

              <button
                style={btn(false)}
                onClick={() => {
                  setSelected(null);
                  setReportText("");
                  setProofImage(null);
                  setLastError(null);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>

      <DeckGL
        viewState={viewState}
        controller={true}
        layers={layers}
        onViewStateChange={({ viewState }) => setViewState(viewState as any)}
        onClick={(info: any) => {
          if (!info?.coordinate) return;
          const [lon, lat] = info.coordinate as [number, number];
          const h3 = latLngToCell(lat, lon, H3_RES);
          setSelected({ lat, lon, h3 });
        }}
      >
        <Map
          ref={mapRef}
          {...viewState}
          mapStyle={`https://api.maptiler.com/maps/streets-v2/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`}
          onLoad={() => {
            refresh();
            flyToUser(); 
          }}
          onMoveEnd={scheduleRefresh}
        >
          <NavigationControl position="bottom-right" />
        </Map>
      </DeckGL>
    </div>
  );
}
"use client";

import React, { useMemo, useRef, useState } from "react";
import Map, { NavigationControl, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import DeckGL from "@deck.gl/react";
import { HexagonLayer } from "@deck.gl/aggregation-layers";
import { GeoJsonLayer } from "@deck.gl/layers";
import { latLngToCell, cellToBoundary, gridDisk } from "h3-js";
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

function getCameraCountsForH3(points: Pt[], h3Index: string, k = 1) {
  // Cameras exactly inside the clicked hex
  const inCell = points.filter((p) => latLngToCell(p.lat, p.lon, H3_RES) === h3Index).length;

  // Cameras in nearby hexes (k=1 means neighbors)
  const nearbySet = new Set(gridDisk(h3Index, k));
  const nearby = points.filter((p) => nearbySet.has(latLngToCell(p.lat, p.lon, H3_RES))).length;

  return { inCell, nearby };
}

// Helper to draw a single H3 hex
function h3CellToFeature(h3Index: string, props: Record<string, any> = {}) {
  const boundary: any[] = cellToBoundary(h3Index, true); // already [lng, lat]

  const coords = boundary.map((pt: any) => {
    // supports both tuple output and object output, just in case
    if (Array.isArray(pt)) return [Number(pt[0]), Number(pt[1])]; // [lng, lat]
    if (pt && typeof pt === "object") return [Number(pt.lng), Number(pt.lat)];
    return pt;
  });

  coords.push(coords[0]); // close polygon

  return {
    type: "Feature",
    properties: props,
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}


async function fileToCompressedDataUrl(
  file: File,
  opts: { maxDim?: number; quality?: number; maxLen?: number } = {}
) {
  const maxDim = opts.maxDim ?? 1100;
  let quality = opts.quality ?? 0.72;
  const maxLen = opts.maxLen ?? 1_800_000;

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

  let out = canvas.toDataURL("image/jpeg", quality);
  while (out.length > maxLen && quality > 0.45) {
    quality -= 0.08;
    out = canvas.toDataURL("image/jpeg", quality);
  }

  return out;
}

function buildDetailedTtsText(opts: {
  reportCount: number;
  signageCount: number;
  camerasInCell: number;
  camerasNearby: number;
  mode: "privacy" | "safety";
  signageText?: string | null;
}) {
  const { reportCount, signageCount, camerasInCell, camerasNearby, mode, signageText } = opts;

  const camLine =
    camerasInCell > 0
      ? `Looks like the map has ${camerasInCell} camera marker${camerasInCell === 1 ? "" : "s"} right here.`
      : camerasNearby > 0
        ? `The map shows cameras close by, but not directly in this spot.`
        : `The map doesn’t show any cameras here, but it can miss things.`;

  const reportLine =
    reportCount === 0
      ? `No one has dropped a report here yet.`
      : reportCount === 1
        ? `There’s 1 community report for this area.`
        : `There are ${reportCount} community reports for this area.`;

  const confidenceLine =
    reportCount >= 5
      ? `At this point it’s basically community confirmed.`
      : reportCount >= 2
        ? `A couple people said the same thing, so it’s probably legit.`
        : reportCount === 1
          ? `It’s just one report though, so take it lightly.`
          : `If you’re seeing something, you can be the first to report it.`;

  const signLine =
    signageCount === 0
      ? `No one mentioned signs.`
      : signageCount === 1
        ? `Someone mentioned a sign about recording.`
        : `A few reports mentioned signage.`;

  const signTextLine =
    signageText && signageText.trim()
      ? `The sign says: ${signageText.trim().slice(0, 90)}.`
      : "";

  const modeLine =
    mode === "privacy"
      ? `You’re in privacy mode, so lower monitoring is the goal.`
      : `You’re in safety mode, so more monitoring might feel “safer”.`;

  const full = `${camLine} ${reportLine} ${confidenceLine} ${signLine} ${signTextLine} ${modeLine}`
    .replace(/\s+/g, " ")
    .trim();

  return full.slice(0, 260);
}

const H3_RES = 9;

export default function Home() {
  const mapRef = useRef<MapRef | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const refreshSeq = useRef(0);

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
  const [submittingReport, setSubmittingReport] = useState(false);

  // New location states
  const [hasUserLocated, setHasUserLocated] = useState(false);
  const [lastBbox, setLastBbox] = useState<[number, number, number, number] | null>(null);

  const [reportText, setReportText] = useState("");
  const [proofImage, setProofImage] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ lat: number; lon: number; h3: string } | null>(null);

  const [hovered, setHovered] = useState<{ lat: number; lon: number; h3: string } | null>(null);
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

  function pickBestVoice() {
  const voices = window.speechSynthesis.getVoices();

  // Prefer higher quality English voices on macOS / Chrome
  const preferred = [
    "Samantha",
    "Karen",
    "Daniel",
    "Google US English",
    "Google UK English Female",
    "Google UK English Male",
  ];

  for (const name of preferred) {
    const v = voices.find((x) => x.name === name);
    if (v) return v;
  }

  // Otherwise pick any en-US/en-GB voice
  return voices.find((v) => v.lang?.startsWith("en-US")) ||
         voices.find((v) => v.lang?.startsWith("en-GB")) ||
         voices[0] ||
         null;
}

async function speakBrowser(text: string) {
  // Some browsers load voices async
  const ensureVoices = () =>
    new Promise<void>((resolve) => {
      const v = window.speechSynthesis.getVoices();
      if (v && v.length) return resolve();
      window.speechSynthesis.onvoiceschanged = () => resolve();
      setTimeout(() => resolve(), 300);
    });

  await ensureVoices();

  window.speechSynthesis.cancel(); // stop any previous speech

  const u = new SpeechSynthesisUtterance(text);
  const voice = pickBestVoice();
  if (voice) u.voice = voice;

  u.rate = 1.04;   // smooth
  u.pitch = 1.02;  // less robotic
  u.volume = 1.0;

  window.speechSynthesis.speak(u);
}

  function reportCellsToGeoJSON() {
  return {
    type: "FeatureCollection",
    features: reportCells.map((c) => h3CellToFeature(c.h3_index, c as any)),
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
      await speakBrowser(text);
      return;
    }

    throw new Error(err?.error || "TTS failed");
  }

  function scheduleRefresh() {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refresh();
    }, 700);
  }

  function flyToUser() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;

        setHasUserLocated(true);

        setViewState((v) => ({
          ...v,
          latitude,
          longitude,
          zoom: 18,
          transitionDuration: 1400,
          transitionInterpolator: new FlyToInterpolator(),
        }));

        window.setTimeout(() => {
          scheduleRefresh();
        }, 1200);
      },
      (err) => {
        // If user denies location, keep overlay off
        setHasUserLocated(false);
        setLastBbox(null);
        console.log("geolocation error:", err?.message);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function refresh() {
    const map = mapRef.current?.getMap();
    if (!map) return;
  
    const mySeq = ++refreshSeq.current; // only the latest refresh can update state
  
    setLoading(true);
    setLastError(null);
  
    const bbox = bboxFromMap(map);
  
    // track bbox for the red overlay
    const b = map.getBounds();
    if (hasUserLocated) {
      setLastBbox([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
    } else {
      setLastBbox(null);
    }
  
    try {
      const [camsRes, repRes] = await Promise.all([
        fetch(`/api/cameras?bbox=${encodeURIComponent(bbox)}`),
        fetch(`/api/report?bbox=${encodeURIComponent(bbox)}`),
      ]);
  
      // if a newer refresh started, ignore this result
      if (mySeq !== refreshSeq.current) return;
  
      if (!camsRes.ok) {
        const t = await camsRes.text().catch(() => "");
        throw new Error(`cameras failed (${camsRes.status}): ${t.slice(0, 200)}`);
      }
      const camsJson = await camsRes.json();
  
      if (mySeq !== refreshSeq.current) return;
      setPoints(camsJson.points || []);
  
      if (!repRes.ok) {
        const t = await repRes.text().catch(() => "");
        throw new Error(`reports failed (${repRes.status}): ${t.slice(0, 200)}`);
      }
      const repJson = await repRes.json();
  
      if (mySeq !== refreshSeq.current) return;
      setReportCells(repJson.cells || []);
    } catch (e: any) {
      if (mySeq !== refreshSeq.current) return;
      console.error(e);
      setLastError(String(e?.message || e));
    } finally {
      if (mySeq === refreshSeq.current) setLoading(false);
    }
  }

  const layers = useMemo(() => {
    const reportGeo = reportCellsToGeoJSON();

    // Red tint now requires both hasUserLocated and lastBbox
    const bboxGeo =
      hasUserLocated && lastBbox
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

    // Create GeoJSON for the currently selected hex
    const selectedGeo = {
      type: "FeatureCollection",
      features: selected ? [h3CellToFeature(selected.h3)] : [],
    };

    const hoveredGeo = {
      type: "FeatureCollection",
      features: hovered ? [h3CellToFeature(hovered.h3)] : [],
    };

    const mapLayers = [];

    // 1. Red Base Layer (Only shows up when user is located)
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
              [0, 160, 0],
              [0, 160, 0],
              [0, 160, 0],
              [0, 160, 0],
              [0, 160, 0],
              [0, 160, 0],
            ],
          })
        );
      }
    }

    mapLayers.push(
      new GeoJsonLayer({
        id: "hovered-hex",
        data: hoveredGeo as any,
        pickable: false,
        stroked: true,
        filled: false,
        lineWidthMinPixels: 3,
        getLineColor: [0, 255, 255, 220],
        parameters: { depthTest: false },
      })
    );

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

    // 4. Selected Hex Layer (Bright cyan outline to sit on top)
    mapLayers.push(
      new GeoJsonLayer({
        id: "selected-hex",
        data: selectedGeo as any,
        pickable: false,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 5,
        getFillColor: [0, 200, 255, 90],
        getLineColor: [0, 200, 255, 255],
        parameters: { depthTest: false }, // this is the key
      })
    );

    return mapLayers;
  }, [points, reportCells, selected, lastBbox, hasUserLocated]);

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
            <span style={swatch("rgba(0, 200, 255, 0.35)")} />
            <span>Cyan outline: currently selected cell.</span>
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
            
            {(reportCells.find((c) => c.h3_index === selected.h3)?.report_count || 0) >= 5 && (
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
                disabled={submittingReport}
                onClick={async () => {
                  if (submittingReport) return;

                  try {
                    setSubmittingReport(true);
                    setLastError(null);

                    if (!selected) {
                      setLastError("Select a cell first.");
                      return;
                    }

                    const text = reportText.trim();
                    if (!text) {
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
                        user_text: text,
                        signage_image_base64: proofImage,
                      }),
                    });

                    const payload = await res.json().catch(() => ({}));

                    if (!res.ok) {
                      throw new Error(payload?.error || `Report failed (${res.status})`);
                    }

                    // Optimistic update so it works on first click visually
                    setReportCells((prev) => {
                      const idx = prev.findIndex((c) => c.h3_index === selected.h3);
                      const signageInc = payload?.signage_text ? 1 : 0;

                      if (idx >= 0) {
                        const next = [...prev];
                        next[idx] = {
                          ...next[idx],
                          report_count: (next[idx].report_count || 0) + 1,
                          signage_count: (next[idx].signage_count || 0) + signageInc,
                          summary: payload?.summary ?? next[idx].summary,
                          signage_text: payload?.signage_text ?? next[idx].signage_text,
                        };
                        return next;
                      }

                      return [
                        ...prev,
                        {
                          h3_index: selected.h3,
                          report_count: 1,
                          signage_count: signageInc,
                          summary: payload?.summary,
                          signage_text: payload?.signage_text,
                        },
                      ];
                    });

                    setReportText("");
                    setProofImage(null);

                    // Sync with server after
                    scheduleRefresh();
                  } catch (e: any) {
                    console.error(e);
                    setLastError(String(e?.message || e));
                  } finally {
                    setSubmittingReport(false);
                  }
                }}
              >
                {submittingReport ? "Submitting..." : "Submit report"}
              </button>

              <button
                style={btn(false)}
                onClick={async () => {
                  try {
                    setLastError(null);

                    const cell = reportCells.find((c) => c.h3_index === selected.h3);
                    
                    // NEW: Retrieve actual camera data for this specific H3 hex and its neighbors
                    const { inCell, nearby } = getCameraCountsForH3(points, selected.h3, 1);

                    const ttsText = buildDetailedTtsText({
                      reportCount: cell?.report_count || 0,
                      signageCount: cell?.signage_count || 0,
                      camerasInCell: inCell,
                      camerasNearby: nearby,
                      mode,
                      signageText: cell?.signage_text ?? null,
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
        onHover={(info: any) => {
        const coord = info?.coordinate;
        if (!coord) return;
        const [lon, lat] = coord as [number, number];
        const h3 = latLngToCell(lat, lon, H3_RES);
        setHovered({ lat, lon, h3 });
      }}
      onClick={(info: any) => {
        const coord = info?.coordinate;
        if (!coord) return;
        const [lon, lat] = coord as [number, number];
        const h3 = latLngToCell(lat, lon, H3_RES);
        setSelected({ lat, lon, h3 });
      }}
      >
        <Map
          ref={mapRef}
          {...viewState}
          mapStyle={`https://api.maptiler.com/maps/streets-v2/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`}
          onLoad={() => {
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
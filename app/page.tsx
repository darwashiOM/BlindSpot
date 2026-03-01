"use client";

import React, { useMemo, useRef, useState } from "react";
import Map, { NavigationControl, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import DeckGL from "@deck.gl/react";
import { HexagonLayer } from "@deck.gl/aggregation-layers";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { latLngToCell, cellToBoundary, gridDisk, cellToLatLng } from "h3-js";
import { FlyToInterpolator } from "@deck.gl/core";
import styles from "./page.module.css";

type Pt = { lat: number; lon: number };

type PlaceKind =
  | "police"
  | "mall"
  | "mcd"
  | "park"
  | "cafe"
  | "library"
  | "community_centre"
  | "community_hotspot";
type Place = {
  id: string;
  kind: PlaceKind;
  name?: string;
  lat: number;
  lon: number;
};

const PLACE_KINDS: PlaceKind[] = [
  "community_hotspot",
  "community_centre",
  "park",
  "cafe",
  "library",
  "mall",
  "mcd",
  "police",
];

type RecommendItem = {
  place: Place;
  score: number;
  distance_m: number;
  h3: string;
  cameras_in_k1: number;
  cameras_in_cell: number;
  report_yes: number;
  report_no: number;
  conflict: boolean;
  reasons: string[];
};

function bboxFromMap(map: maplibregl.Map) {
  const b = map.getBounds();
  const south = b.getSouth();
  const west = b.getWest();
  const north = b.getNorth();
  const east = b.getEast();
  return [south, west, north, east].map((x) => Number(x.toFixed(6))).join(",");
}

function getCameraCountsForH3(points: Pt[], h3Index: string, res: number, k = 1) {
  // Cameras exactly inside the clicked hex
  const inCell = points.filter((p) => latLngToCell(p.lat, p.lon, res) === h3Index).length;

  // Cameras in nearby hexes (k=1 means neighbors)
  const nearbySet = new Set(gridDisk(h3Index, k));
  const nearby = points.filter((p) => nearbySet.has(latLngToCell(p.lat, p.lon, res))).length;

  return { inCell, nearby };
}

function getNearbyReportStatsForTts(
  reportCells: Array<{
    h3_index: string;
    camera_present_count: number;
    camera_absent_count: number;
    signage_count: number;
    summary?: string;
    signage_text?: string;
  }>,
  centerH3: string,
  k: number
) {
  const ring = new Set(gridDisk(centerH3, k));

  let yes = 0;
  let no = 0;
  let signage = 0;

  // pick the "best" summary among nearby cells (the one with most evidence)
  let bestSummary: string | null = null;
  let bestWeight = -1;

  let matchedCells = 0;

  for (const c of reportCells) {
    if (!ring.has(c.h3_index)) continue;

    matchedCells += 1;

    const cy = Number(c.camera_present_count || 0);
    const cn = Number(c.camera_absent_count || 0);
    const cs = Number(c.signage_count || 0);

    yes += cy;
    no += cn;
    signage += cs;

    const weight = cy + cn + cs;
    if (c.summary && weight > bestWeight) {
      bestWeight = weight;
      bestSummary = c.summary;
    }
  }

  return { yes, no, signage, bestSummary, matchedCells };
}

function kindLabel(k: PlaceKind) {
  if (k === "community_hotspot") return "Community confirmed area";
  if (k === "police") return "Police station";
  if (k === "mall") return "Mall";
  if (k === "park") return "Park";
  if (k === "cafe") return "Cafe";
  if (k === "library") return "Library";
  if (k === "community_centre") return "Community center";
  return "McDonald’s";
}

// Helper to draw a single H3 hex
function h3CellToFeature(h3Index: string, props: Record<string, any> = {}) {
  const boundary: any[] = cellToBoundary(h3Index, true);

  const coords = boundary.map((pt: any) => {
    if (Array.isArray(pt)) return [Number(pt[0]), Number(pt[1])];
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
export default function Home() {
  const mapRef = useRef<MapRef | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const refreshSeq = useRef(0);
  const recAbortRef = useRef<AbortController | null>(null);
  const recSeq = useRef(0);

  const didAutoStartRef = useRef(false);


  const [isMobile, setIsMobile] = useState(false);
const [panelOpen, setPanelOpen] = useState(true);

React.useEffect(() => {
  const mq = window.matchMedia("(max-width: 760px)");
  const update = () => setIsMobile(mq.matches);
  update();
  mq.addEventListener?.("change", update);
  return () => mq.removeEventListener?.("change", update);
}, []);

// optional: start closed on phones so map is visible
React.useEffect(() => {
  if (isMobile) setPanelOpen(false);
  else setPanelOpen(true);
}, [isMobile]);

  // default: hide police (you can change defaults)
  const [kindEnabled, setKindEnabled] = useState<Record<PlaceKind, boolean>>(() => ({
    police: false,
    mall: true,
    mcd: true,
    park: true,
    cafe: true,
    library: true,
    community_centre: true,
    community_hotspot: true,
  }));


  const enabledKinds = useMemo(() => PLACE_KINDS.filter((k) => kindEnabled[k]), [kindEnabled]);

// Only real place kinds should be fetched from /api/places.
  // community_hotspot is NOT a DB "place", it comes from reports.
  const enabledPlaceKinds = useMemo(
    () => enabledKinds.filter((k) => k !== "community_hotspot"),
    [enabledKinds]
  );
  const disabledKinds = useMemo(() => PLACE_KINDS.filter((k) => !kindEnabled[k]), [kindEnabled]);

  const [viewState, setViewState] = useState({
    longitude: -75.75,
    latitude: 39.68,
    zoom: 15,
    bearing: 0,
    pitch: 0,
  });

  const reportRes = 12;
  const READ_REPORT_K = 4; 

  const pickRes = reportRes;
  const mode = "safety";

  const [points, setPoints] = useState<Pt[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [submittingReport, setSubmittingReport] = useState(false);
  const [booting, setBooting] = useState(true);

  const [reportText, setReportText] = useState("");
  const [proofImage, setProofImage] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ lat: number; lon: number; h3: string; report_h3: string } | null>(null);

  const [claim, setClaim] = useState<"camera_present" | "camera_absent">("camera_present");
  const abortRef = useRef<AbortController | null>(null);
  const [hovered, setHovered] = useState<{ lat: number; lon: number; h3: string; report_h3: string } | null>(null);
  const [reportCells, setReportCells] = useState<
    Array<{
      h3_index: string;
      camera_present_count: number;
      camera_absent_count: number;
      signage_count: number;
      summary?: string;
      signage_text?: string;
    }>
  >([]);

  const [lastError, setLastError] = useState<string | null>(null);

  // New Recommender UI State
  const [askText, setAskText] = useState("Selling something on Facebook Marketplace");
  const [recommending, setRecommending] = useState(false);
  const [recIntentLabel, setRecIntentLabel] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendItem[]>([]);

  // Trigger a refresh when filters change (so newly enabled kinds actually load)
  React.useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    scheduleRefresh(0);
  }, [kindEnabled]);


  

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

  async function loadPlacesSequentially(opts: { bbox: string; enabledKinds: PlaceKind[]; signal: AbortSignal; seq: number }) {
    const { bbox, enabledKinds, signal, seq } = opts;

    for (const kind of enabledKinds) {
      // if a newer refresh started, stop
      if (seq !== refreshSeq.current) return;

      const res = await fetch(`/api/places?bbox=${encodeURIComponent(bbox)}&kind=${encodeURIComponent(kind)}`, { signal }).catch(
        () => null
      );

      if (!res || !res.ok) continue;

      const json = await res.json().catch(() => ({}));
      const incoming: Place[] = Array.isArray(json?.places) ? json.places : [];

      // stop if newer refresh started
      if (seq !== refreshSeq.current) return;

      // append incrementally
      setPlaces((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const next = [...prev];
        for (const p of incoming) {
          if (!seen.has(p.id)) next.push(p);
        }
        return next;
      });
    }
  }

  function pickBestVoice() {
    const voices = window.speechSynthesis.getVoices();
    const preferred = ["Samantha", "Karen", "Daniel", "Google US English", "Google UK English Female", "Google UK English Male"];

    for (const name of preferred) {
      const v = voices.find((x) => x.name === name);
      if (v) return v;
    }

    return voices.find((v) => v.lang?.startsWith("en-US")) || voices.find((v) => v.lang?.startsWith("en-GB")) || voices[0] || null;
  }

function buildTtsSummaryText(opts: {
  reportSummary?: string | null;
  reportYes: number;
  reportNo: number;
  matchedCells: number;
  camerasInCell: number;
  camerasNearby: number;
}) {
  const { reportSummary, reportYes, reportNo, matchedCells, camerasInCell, camerasNearby } = opts;

  const reportTotal = reportYes + reportNo;

  const communityLine =
    reportTotal === 0
      ? "No community reports nearby."
      : `In the nearby area, ${reportYes} people reported cameras, and ${reportNo} reported no cameras.`;

  const summaryLine =
    reportSummary && reportSummary.trim()
      ? `Summary: ${reportSummary.trim()}`
      : reportTotal > 0
        ? "People have reported here, but there is no summary yet."
        : "";

  const mapLine =
    camerasInCell > 0
      ? "Map data shows camera markers right here."
      : camerasNearby > 0
        ? "Map data shows camera markers nearby."
        : "Map data does not show any camera markers here.";

  const full = `${communityLine} ${summaryLine} ${mapLine}`.replace(/\s+/g, " ").trim();
  return full.slice(0, 240);
}

  async function speakBrowser(text: string) {
    const ensureVoices = () =>
      new Promise<void>((resolve) => {
        const v = window.speechSynthesis.getVoices();
        if (v && v.length) return resolve();
        window.speechSynthesis.onvoiceschanged = () => resolve();
        setTimeout(() => resolve(), 300);
      });

    await ensureVoices();
    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    const voice = pickBestVoice();
    if (voice) u.voice = voice;

    u.rate = 1.04;
    u.pitch = 1.02;
    u.volume = 1.0;

    window.speechSynthesis.speak(u);
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

  function scheduleRefresh(delayMs = 250) {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refresh();
    }, delayMs);
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
          zoom: 15,
          transitionDuration: 1400,
          transitionInterpolator: new FlyToInterpolator(),
        }));

        window.setTimeout(() => {
          refresh();
          setBooting(false);
        }, 1800);
      },
      (err) => {
        console.log("geolocation error:", err?.message);
        refresh();
        setBooting(false);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function refresh() {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const mySeq = ++refreshSeq.current;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setLastError(null);

    const bbox = bboxFromMap(map);

    // Read zoom from the map so refresh is never blocked by stale React state
    const zoomNow = Number(map.getZoom());
    const reportResNow = 12;

    try {
      const wantPlaces = 12;

      // only cameras + reports in parallel
      const [camsRes, repRes] = await Promise.all([
        fetch(`/api/cameras?bbox=${encodeURIComponent(bbox)}`, { signal: controller.signal }),
        fetch(`/api/report?bbox=${encodeURIComponent(bbox)}&res=${reportResNow}`, { signal: controller.signal }),
      ]);

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

      // places load AFTER, sequentially, and only for enabled kinds
      if (wantPlaces) {
        await loadPlacesSequentially({
          bbox,
          enabledKinds: enabledPlaceKinds,
          signal: controller.signal,
          seq: mySeq,
        });
      } else {
        // setPlaces([]);
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      if (mySeq !== refreshSeq.current) return;
      console.error(e);
      setLastError(String(e?.message || e));
    } finally {
      if (mySeq === refreshSeq.current) setLoading(false);
    }
  }

  async function runRecommend() {
    const mySeq = ++recSeq.current;

    // cancel any previous recommend call
    recAbortRef.current?.abort();
    const controller = new AbortController();
    recAbortRef.current = controller;

    try {
      setRecommending(true);
      setLastError(null);

      const lat = viewState.latitude;
      const lon = viewState.longitude;

      // optional: hard timeout (prevents hanging forever)
      const timeoutId = window.setTimeout(() => controller.abort(), 15000);

      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: askText,
          lat,
          lon,
          maxResults: 30, // ask for more, so filtering still leaves enough
          excludeKinds: disabledKinds, // tell backend too (next section)
        }),
        signal: controller.signal,
      });

      window.clearTimeout(timeoutId);

      // If a newer request started, ignore this one
      if (mySeq !== recSeq.current) return;

      const json = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(json?.error || `recommend failed (${res.status})`);
      if (json?.error) throw new Error(json.error);

      setRecIntentLabel(String(json?.intentLabel || "Recommendation"));
      const raw = Array.isArray(json?.results) ? json.results : [];
      const filtered = raw.filter((r: RecommendItem) => kindEnabled[r.place.kind]);

      setRecommendations(filtered.slice(0, 5));
    } catch (e: any) {
      // key part: ignore aborts
      if (e?.name === "AbortError" || String(e?.message || "").toLowerCase().includes("aborted")) {
        return;
      }

      console.error(e);
      setLastError(String(e?.message || e));
      setRecommendations([]);
      setRecIntentLabel(null);
    } finally {
      // only stop spinner if this is still the latest call
      if (mySeq === recSeq.current) setRecommending(false);
    }
  }

  // Memoize heavy GeoJSON
  const reportGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: reportCells.map((c) => h3CellToFeature(c.h3_index, c as any)),
    };
  }, [reportCells]);

  const selectedGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: selected ? [h3CellToFeature(selected.h3)] : [],
    };
  }, [selected]);

  const hoveredGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: hovered ? [h3CellToFeature(hovered.h3)] : [],
    };
  }, [hovered]);

const recLayerData = useMemo(() => {
  return recommendations
    .map((r) => r.place)
    .filter((p) => Boolean(kindEnabled[p.kind as PlaceKind]));
}, [recommendations, kindEnabled]);


  const layers = useMemo(() => {
    if (booting) return [];

    const mapLayers = [];

    mapLayers.push(
      new GeoJsonLayer({
        id: "hovered-hex",
        data: hoveredGeo as any,
        pickable: true,
        stroked: true,
        filled: false,
        lineWidthMinPixels: 3,
        getLineColor: [0, 255, 255, 220],
        parameters: { depthTest: false },
      })
    );

    if (places && places.length > 0) {
      const placeRadius = 12;

      const filteredPlaces = places.filter((p) => kindEnabled[p.kind]);
      mapLayers.push(
        new ScatterplotLayer<Place>({
          id: "places-layer",
          data: filteredPlaces,
          getPosition: (d) => [Number(d.lon), Number(d.lat)],
          getFillColor: () => [0, 255, 208, 180],
          getRadius: placeRadius,
          radiusMinPixels: 4,
          getLineColor: [0, 0, 0, 120],
          lineWidthMinPixels: 1,
          stroked: true,
          pickable: true,
        })
      );
    }

    const showCommunityReports = kindEnabled.community_hotspot; // or make a separate toggle if you want

if (showCommunityReports) {
  mapLayers.push(
    new GeoJsonLayer({
      id: "community-reports",
      data: reportGeo as any,
      pickable: true,
      stroked: true,
      filled: true,
      getLineColor: [0, 0, 0, 170],
      getFillColor: (f: any) => {
        const yes = f.properties.camera_present_count || 0;
        const no = f.properties.camera_absent_count || 0;

        const conflict = yes > 0 && no > 0;
        if (conflict) return [255, 0, 255, 160];

        if (yes >= 5) return [140, 0, 255, 180];
        if (yes >= 2) return [255, 140, 0, 165];
        if (yes >= 1) return [255, 235, 0, 155];

        if (no >= 5) return [255, 0, 0, 190];
        if (no >= 2) return [255, 60, 60, 150];
        if (no >= 1) return [255, 120, 120, 120];

        return [0, 0, 0, 0];
      },
      lineWidthMinPixels: 2,
    })
  );

}

    if (recLayerData.length > 0) {
      mapLayers.push(
        new ScatterplotLayer<Place>({
          id: "recommendations",
          data: recLayerData,
          pickable: false,
          getPosition: (d) => [d.lon, d.lat],
          getRadius: 44,
          radiusUnits: "pixels",
          getFillColor: [0, 0, 0, 0],
          getLineColor: [0, 255, 200, 240],
          lineWidthMinPixels: 4,
          stroked: true,
        })
      );
    }

    const cameraRadius = 12;

    if (viewState.zoom >= 13 && points && points.length > 0 && mode === "safety") {
      const validPoints = points.filter((p) => p.lat != null && p.lon != null);
      if (validPoints.length > 0) {
        mapLayers.push(
          new HexagonLayer<Pt>({
            id: "surveillance-hex",
            data: validPoints,
            getPosition: (d) => [Number(d.lon), Number(d.lat)],
            radius: cameraRadius,
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
        id: "selected-hex",
        data: selectedGeo as any,
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 5,
        getFillColor: [0, 200, 255, 90],
        getLineColor: [0, 200, 255, 255],
        parameters: { depthTest: false },
      })
    );

    


    return mapLayers;
  }, [booting, points, places, reportCells, selected, hovered, viewState.zoom, mode, recLayerData, kindEnabled, hoveredGeo, reportGeo, selectedGeo]);

  // UPDATED: Main wrapper is now a full-screen flex container
  return (
    <div className={styles.page}>
      {/* --- Top bar --- */}
      <div className={styles.topBar}>
        <div className={styles.brand}>
          <div className={styles.brandTitle}>Blind Spot</div>
          <div className={styles.brandSub}>Community + map signals</div>
        </div>

        <div className={styles.actions}>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => setPanelOpen((v) => !v)}
          >
            {panelOpen ? "Hide panel" : "Open panel"}
          </button>

          <button className={styles.btn} onClick={refresh}>
            {loading ? "Loading..." : "Refresh"}
          </button>

          <button className={styles.btn} onClick={flyToUser}>
            Locate me
          </button>
        </div>
      </div>

      {/* --- Floating Panel --- */}
      <div
        className={[styles.panel, !panelOpen ? styles.panelClosed : ""].join(" ")}
        style={{ zIndex: 15, overflowY: "auto", maxHeight: "calc(100vh - 80px)" }}
      >
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>Controls</div>

          <button className={styles.btn} onClick={() => setPanelOpen(false)}>
            Close
          </button>
        </div>

        {/* --- AI Recommendations UI --- */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Ask for a safe spot</div>
          <input
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            placeholder="Example: Selling something on Facebook Marketplace"
            style={{
              width: "100%",
              padding: "10px 10px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
              color: "white",
              outline: "none",
              fontSize: 13,
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button style={btn(false)} onClick={runRecommend} disabled={recommending}>
              {recommending ? "Thinking..." : "Suggest spots"}
            </button>
            <button
              style={btn(false)}
              onClick={() => {
                setRecommendations([]);
                setRecIntentLabel(null);
              }}
            >
              Clear suggestions
            </button>
          </div>

          {recIntentLabel && (
            <div style={{ ...smallText, marginTop: 10 }}>
              <b>{recIntentLabel}</b> (based on map camera markers + community reports)
            </div>
          )}

          {recommendations.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {recommendations.map((r) => {
                const name = r.place.name || kindLabel(r.place.kind);
                const shortReasons = r.reasons.slice(0, 2).join(" • ");
                const dist = Math.round(r.distance_m);
                return (
                  <div
                    key={r.place.id}
                    style={{
                      marginTop: 8,
                      padding: 10,
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.14)",
                      background: "rgba(255,255,255,0.05)",
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 13 }}>
                      {name} <span style={{ fontWeight: 600, opacity: 0.75 }}>({dist}m)</span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                      {kindLabel(r.place.kind)} • {shortReasons}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                      Cameras nearby: {r.cameras_in_k1} • Reports: {r.report_yes + r.report_no}
                      {r.conflict ? " • conflict" : ""}
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      <button
                        style={btn(false)}
                        onClick={() => {
                          setViewState((v) => ({
                            ...v,
                            latitude: r.place.lat,
                            longitude: r.place.lon,
                            zoom: Math.max(v.zoom, 12),
                            transitionDuration: 900,
                            transitionInterpolator: new FlyToInterpolator(),
                          }));
                          if (isMobile) setPanelOpen(false); // Auto-close panel on mobile when flying
                        }}
                      >
                        Fly to
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Place filters</div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {PLACE_KINDS.map((k) => (
              <button
                key={k}
                style={btn(kindEnabled[k])}
                onClick={() => setKindEnabled((prev) => ({ ...prev, [k]: !prev[k] }))}
              >
                {kindLabel(k)}
              </button>
            ))}
          </div>

          <div style={{ ...smallText }}>Disabled kinds will not appear on the map and will not be suggested by AI.</div>
        </div>

        {/* --- Legend --- */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Legend</div>

          {mode === "safety" ? (
            <div style={legendRow}>
              <span style={swatch("rgba(0, 255, 0, 0.45)")} />
              <span>Green hexes: cameras detected nearby (from OpenStreetMap).</span>
            </div>
          ) : (
            <div style={legendRow}>
              <span style={swatch("rgba(255, 0, 0, 0.8)")} />
              <span>Red dots: known cameras (from OpenStreetMap).</span>
            </div>
          )}

          <div style={legendRow}>
            <span style={swatch("rgba(220, 0, 0, 0.14)")} />
            <span>Light red tint: no cameras detected in this view.</span>
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
            <span style={swatch("rgba(255, 0, 255, 0.63)")} />
            <span>Magenta cell: conflicting reports.</span>
          </div>

          <div style={legendRow}>
            <span style={swatch("rgba(0, 200, 255, 0.35)")} />
            <span>Cyan outline: currently selected cell.</span>
          </div>

          <div style={legendRow}>
            <span style={swatch("rgba(0, 255, 200, 0.75)")} />
            <span>Teal rings: AI recommended spots.</span>
          </div>

          <div style={{ marginTop: 10, fontSize: 11, color: "rgba(255,255,255,0.65)", lineHeight: 1.35 }}>
            Camera data comes from OpenStreetMap tags and may be incomplete. Community reports are user-submitted and can be wrong.
          </div>
        </div>

        {lastError && <div style={{ ...smallText, color: "rgba(255,120,120,0.95)" }}>Error: {lastError}</div>}

        {/* --- Reporting UI --- */}
        {selected && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
              <b>Selected cell:</b> {selected.h3}
            </div>

            {(() => {
              const cellData = reportCells.find((c) => c.h3_index === selected.report_h3);
              const yesCount = cellData?.camera_present_count || 0;

              if (yesCount >= 5) {
                return (
                  <div style={{ fontSize: 13, color: "#a855f7", fontWeight: "bold", marginTop: 4 }}>
                    ✓ Community confirmed camera area
                  </div>
                );
              }
            })()}

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

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button style={btn(claim === "camera_present")} onClick={() => setClaim("camera_present")}>
                Camera here
              </button>
              <button style={btn(claim === "camera_absent")} onClick={() => setClaim("camera_absent")}>
                No camera seen
              </button>
            </div>

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
                  style={{
                    marginTop: 8,
                    width: "100%",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.15)",
                  }}
                />
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button
                style={btn(false)}
                disabled={submittingReport}
                onClick={async () => {
                  // ... Keep your exact submit logic here (omitted for brevity, paste your submit handler)
                }}
              >
                {submittingReport ? "Submitting..." : "Submit report"}
              </button>

              <button
                style={btn(false)}
                onClick={async () => {
                  // ... Keep your exact TTS logic here
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

      {/* --- Map full screen behind --- */}
      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
        <DeckGL
          viewState={viewState}
          controller={true}
          layers={layers}
          useDevicePixels={1}
          onViewStateChange={({ viewState }) => setViewState(viewState as any)}
          onInteractionStateChange={(s) => {
            const active = s.isDragging || s.isPanning || s.isZooming || s.isRotating;
            if (!active) scheduleRefresh(300);
          }}
          onHover={(info) => {
            const pickResUi = 12;
            if (!info?.viewport) return;
            const [lon, lat] = info.viewport.unproject([info.x, info.y]);

            const reportH3 = latLngToCell(lat, lon, reportRes);
            const uiH3 = latLngToCell(lat, lon, pickResUi);

            const [centerLat, centerLon] = cellToLatLng(reportH3);
            setHovered({ lat: centerLat, lon: centerLon, h3: uiH3, report_h3: reportH3 });
          }}
          onClick={(info: any) => {
            const pickResUi = 12;
            if (!info?.viewport) return;
            const [lon, lat] = info.viewport.unproject([info.x, info.y]);

            const reportH3 = latLngToCell(lat, lon, reportRes);
            const uiH3 = latLngToCell(lat, lon, pickResUi);

            const [centerLat, centerLon] = cellToLatLng(reportH3);
            setSelected({ lat: centerLat, lon: centerLon, h3: uiH3, report_h3: reportH3 });

            // Auto-open panel on mobile when an area is selected to show report UI
            setPanelOpen(true);
          }}
        >
          <Map
            ref={mapRef}
            {...viewState}
            pixelRatio={1}
            mapStyle={`https://api.maptiler.com/maps/streets-v2/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`}
            onLoad={() => {
              const map = mapRef.current?.getMap();
              if (map) {
                map.on("styleimagemissing", (e: any) => {
                  try {
                    const img = new ImageData(1, 1);
                    map.addImage(e.id, img as any);
                  } catch {}
                });
              }

              if (!didAutoStartRef.current) {
                didAutoStartRef.current = true;
                setBooting(false);
                scheduleRefresh(0);
              }

              setTimeout(() => flyToUser(), 600);
            }}
          >
            <NavigationControl position="bottom-right" />
          </Map>
        </DeckGL>
      </div>
    </div>
  );
}
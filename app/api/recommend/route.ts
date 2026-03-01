import { NextResponse } from "next/server";
import { latLngToCell, gridDisk, cellToLatLng, cellToParent } from "h3-js";

export const runtime = "nodejs";

type PlaceKind =
  | "police"
  | "mall"
  | "mcd"
  | "park"
  | "cafe"
  | "library"
  | "parking"
  | "community_centre"
  | "community_hotspot";

type Place = {
  id: string;
  kind: PlaceKind;
  name?: string;
  lat: number;
  lon: number;
};

type CameraPt = { lat: number; lon: number };

type ReportCell = {
  h3_index: string;
  camera_present_count: number;
  camera_absent_count: number;
  signage_count: number;
  summary?: string;
  signage_text?: string;
};

type Intent =
  | "facebook_marketplace_sale"
  | "first_date"
  | "night_walk"
  | "general_safe_meetup";

type RecommendRequest = {
  text: string;
  lat: number;
  lon: number;
  maxResults?: number;
  excludeKinds?: string[];
};

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

type CacheEntry = { at: number; data: any };
const memCache = new Map<string, CacheEntry>();

function baseUrlFromReq(req: Request) {
  const host = req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const sLat1 = toRad(aLat);
  const sLat2 = toRad(bLat);

  const sin1 = Math.sin(dLat / 2);
  const sin2 = Math.sin(dLon / 2);

  const h = sin1 * sin1 + Math.cos(sLat1) * Math.cos(sLat2) * sin2 * sin2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function metersToBBox(lat: number, lon: number, radiusM: number) {
  const latDeg = radiusM / 111_320;
  const lonDeg = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - latDeg,
    north: lat + latDeg,
    west: lon - lonDeg,
    east: lon + lonDeg,
  };
}

function bboxToParam(b: { south: number; west: number; north: number; east: number }) {
  return [b.south, b.west, b.north, b.east].map((x) => Number(x.toFixed(6))).join(",");
}

function classifyIntent(text: string): Intent {
  const t = (text || "").toLowerCase();
  if (t.includes("facebook") || t.includes("marketplace") || t.includes("sell") || t.includes("buyer") || t.includes("cash"))
    return "facebook_marketplace_sale";
  if (t.includes("date") || t.includes("tinder") || t.includes("hinge") || t.includes("first time"))
    return "first_date";
  if (t.includes("night") || t.includes("walk") || t.includes("parking") || t.includes("late"))
    return "night_walk";
  return "general_safe_meetup";
}

function intentConfig(intent: Intent) {
  if (intent === "facebook_marketplace_sale") {
    return {
      radiusM: 6500,
      maxDistanceM: 6500,
      kindWeight: {
        police: 1.0,
        parking: 0.8,
        mall: 0.75,
        community_centre: 0.65,
        cafe: 0.45,
        library: 0.55,
        park: 0.35,
        mcd: 0.45,
        community_hotspot: 0.55, // lowered so it helps but doesn't dominate
      } as Record<PlaceKind, number>,
      label: "Marketplace sale",
      kindsQuery: ["police", "parking", "mall", "community_centre", "library", "cafe", "mcd"] as const,
    };
  }

  if (intent === "first_date") {
    return {
      radiusM: 5000,
      maxDistanceM: 5000,
      kindWeight: {
        cafe: 1.0,
        mall: 0.8,
        park: 0.7,
        library: 0.6,
        community_centre: 0.6,
        mcd: 0.5,
        police: 0.25,
        parking: 0.3,
        community_hotspot: 0.5, // lowered
      } as Record<PlaceKind, number>,
      label: "First date",
      kindsQuery: ["cafe", "mall", "park", "library", "community_centre", "mcd"] as const,
    };
  }

  if (intent === "night_walk") {
    return {
      radiusM: 4000,
      maxDistanceM: 4000,
      kindWeight: {
        police: 1.0,
        parking: 0.75,
        mall: 0.6,
        cafe: 0.45,
        library: 0.35,
        community_centre: 0.55,
        park: 0.25,
        mcd: 0.45,
        community_hotspot: 0.55, // lowered
      } as Record<PlaceKind, number>,
      label: "Night walk",
      kindsQuery: ["police", "parking", "mall", "mcd", "community_centre"] as const,
    };
  }

  return {
    radiusM: 5500,
    maxDistanceM: 5500,
    kindWeight: {
      police: 0.75,
      mall: 0.75,
      cafe: 0.75,
      park: 0.6,
      library: 0.6,
      community_centre: 0.65,
      parking: 0.55,
      mcd: 0.55,
      community_hotspot: 0.55, // lowered
    } as Record<PlaceKind, number>,
    label: "Safe meetup",
    kindsQuery: ["police", "mall", "cafe", "park", "library", "community_centre", "parking", "mcd"] as const,
  };
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function safeNum(x: any) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Dedupes ALL kinds (including hotspots) so you don't get 3 markers on one house
function dedupeByDistance(items: RecommendItem[], minMeters: number) {
  const out: RecommendItem[] = [];
  for (const it of items) {
    const ok = out.every((o) => haversineMeters(o.place.lat, o.place.lon, it.place.lat, it.place.lon) >= minMeters);
    if (ok) out.push(it);
  }
  return out;
}

export async function POST(req: Request) {
  const CAM_RES = 10; // cameras + scoring resolution
  const HOTSPOT_RES = 9; // merge nearby report cells so hotspots don't spam
  const baseUrl = baseUrlFromReq(req);

  let body: RecommendRequest | null = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const exclude = new Set<PlaceKind>((body?.excludeKinds || []) as PlaceKind[]);

  const text = String(body?.text || "").slice(0, 800);
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);

  const maxResults = Math.max(1, Math.min(30, Number(body?.maxResults || 5)));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "bad_lat_lon" }, { status: 400 });
  }

  const intent = classifyIntent(text);
  const cfg = intentConfig(intent);

  const excludeKey = [...exclude].sort().join("|");
  const cacheKey = `rec:${intent}:${lat.toFixed(4)}:${lon.toFixed(4)}:${maxResults}:ex=${excludeKey}`;
  const now = Date.now();
  const ttlMs = 60 * 1000;

  const hit = memCache.get(cacheKey);
  if (hit && now - hit.at < ttlMs) {
    return NextResponse.json(hit.data, { status: 200 });
  }

  const bbox = metersToBBox(lat, lon, cfg.radiusM);
  const bboxParam = bboxToParam(bbox);

  const communityEnabled = !exclude.has("community_hotspot");

  const allowedKinds = (cfg.kindsQuery as readonly string[]).filter((k) => !exclude.has(k as PlaceKind));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    // If the user excluded all place kinds, do NOT call /api/places with empty kinds
    const placesPromise =
      allowedKinds.length === 0
        ? Promise.resolve({ places: [] as Place[] })
        : fetch(`${baseUrl}/api/places?bbox=${encodeURIComponent(bboxParam)}&kinds=${encodeURIComponent(allowedKinds.join(","))}`, {
            signal: controller.signal,
          })
            .then((r) => r.json().catch(() => ({})))
            .then((j) => ({ places: (Array.isArray(j?.places) ? j.places : []) as Place[] }))
            .catch(() => ({ places: [] as Place[] }));

    const [placesWrap, camsJson, repJson] = await Promise.all([
      placesPromise,
      fetch(`${baseUrl}/api/cameras?bbox=${encodeURIComponent(bboxParam)}`, { signal: controller.signal })
        .then((r) => r.json().catch(() => ({})))
        .catch(() => ({})),
      fetch(`${baseUrl}/api/report?bbox=${encodeURIComponent(bboxParam)}&res=${CAM_RES}`, { signal: controller.signal })
        .then((r) => r.json().catch(() => ({})))
        .catch(() => ({})),
    ]);

    const places: Place[] = placesWrap.places || [];
    const cameras: CameraPt[] = Array.isArray(camsJson?.points) ? camsJson.points : [];
    const reportCells: ReportCell[] = Array.isArray(repJson?.cells) ? repJson.cells : [];

    // Camera counts per CAM_RES cell
    const camCounts = new Map<string, number>();
    for (const p of cameras) {
      const plat = Number(p?.lat);
      const plon = Number(p?.lon);
      if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
      const h3 = latLngToCell(plat, plon, CAM_RES);
      camCounts.set(h3, (camCounts.get(h3) || 0) + 1);
    }

    // Report map by CAM_RES cell (same res as scoring)
    const repMap = new Map<string, ReportCell>();
    for (const c of reportCells) {
      if (!c?.h3_index) continue;
      repMap.set(c.h3_index, c);
    }

    // Build merged hotspots so one building does not create 2 to 3 hotspot points
    const hotspots: Place[] = [];
    if (communityEnabled) {
      type HotAgg = {
  yes: number;
  no: number;
  count: number;
  bestChild: string;   // CAM_RES-ish child cell that has strongest "yes"
  bestYes: number;
};

const agg = new Map<string, HotAgg>();

for (const c of reportCells) {
  const yes = safeNum(c?.camera_present_count);
  const no = safeNum(c?.camera_absent_count);

  // Safety mode hotspot: require at least 2 "yes" reports
  if (yes < 2) continue;

  const child = c.h3_index; // this is the report cell returned at res=CAM_RES
  let parent = child;
  try {
    parent = cellToParent(child, HOTSPOT_RES);
  } catch {}

  const prev = agg.get(parent);
  if (!prev) {
    agg.set(parent, { yes, no, count: 1, bestChild: child, bestYes: yes });
  } else {
    prev.yes += yes;
    prev.no += no;
    prev.count += 1;

    // pick a child cell that best represents this hotspot
    if (yes > prev.bestYes) {
      prev.bestYes = yes;
      prev.bestChild = child;
    }
  }
}

for (const [parent, a] of agg.entries()) {
  // IMPORTANT: place the hotspot at the best CHILD cell center,
  // so repMap(placeH3) hits the cell with your votes.
  const [centerLat, centerLon] = cellToLatLng(a.bestChild);

  const d = haversineMeters(lat, lon, centerLat, centerLon);
  if (d > cfg.maxDistanceM * 1.05) continue;

  hotspots.push({
    id: `community/${parent}`, // keep id stable
    kind: "community_hotspot",
    name: a.yes >= 5 ? "Community confirmed camera area" : "Community reported camera area",
    lat: centerLat,
    lon: centerLon,
  });
}
    }

    const scored: RecommendItem[] = [];

    function scorePlace(pl: Place) {
      if (exclude.has(pl.kind)) return;

      const d = haversineMeters(lat, lon, pl.lat, pl.lon);
      if (d > cfg.maxDistanceM * 1.05) return;

      const placeH3 = latLngToCell(pl.lat, pl.lon, CAM_RES);
      const neighbors = gridDisk(placeH3, 1);

      const camsInCell = camCounts.get(placeH3) || 0;
      let camsK1 = 0;
      for (const h of neighbors) camsK1 += camCounts.get(h) || 0;

      const cell = repMap.get(placeH3);
      const yes = safeNum(cell?.camera_present_count);
      const no = safeNum(cell?.camera_absent_count);
      const conflict = yes > 0 && no > 0;

      const distScore = clamp01(1 - d / cfg.maxDistanceM);
      const camScore = clamp01(Math.log1p(camsK1) / Math.log(1 + 18));

      let repScore = 0;
      if (yes >= 5) repScore += 1.0;
      else if (yes >= 2) repScore += 0.6;
      else if (yes >= 1) repScore += 0.25;

      if (no >= 5) repScore -= 0.8;
      else if (no >= 2) repScore -= 0.35;
      else if (no >= 1) repScore -= 0.15;

      const isHotspot = pl.kind === "community_hotspot";
      const conflictPenalty = conflict ? 0.55 : 0;

      const typeW = cfg.kindWeight[pl.kind] ?? 0.5;

      // Hotspots should help, not auto-win
      const typeFactor = isHotspot ? 1.2 : 2.0;
      const distFactor = 2.0;
      const camFactor = isHotspot ? 1.0 : 1.8;
      const repFactor = isHotspot ? 1.4 : 2.0;

      const evidenceBoost =
        (camsK1 >= 1 ? (isHotspot ? 0.18 : 0.35) : 0) + (yes >= 1 ? (isHotspot ? 0.18 : 0.35) : 0);

      // If a hotspot has weak nearby camera signal, slightly downgrade it
      const weakHotspotPenalty = isHotspot && camsK1 === 0 && yes < 5 ? 0.45 : 0;

      const score =
        typeW * typeFactor +
        distScore * distFactor +
        camScore * camFactor +
        repScore * repFactor -
        conflictPenalty +
        evidenceBoost -
        weakHotspotPenalty;

      const reasons: string[] = [];

      if (isHotspot) {
        reasons.push(yes >= 5 ? "Community confirmed camera presence" : "Community reports camera presence");
      } else {
        reasons.push(`Type: ${pl.kind.replaceAll("_", " ")}`);
      }

      if (yes >= 5) reasons.push("High community confidence");
      else if (yes >= 2) reasons.push("Some community confirmation");

      if (camsK1 >= 6) reasons.push("High camera marker density nearby");
      else if (camsK1 >= 2) reasons.push("Some camera markers nearby");
      else reasons.push("Camera coverage uncertain (map data can be incomplete)");

      if (conflict) reasons.push("Conflicting community reports");

      scored.push({
        place: pl,
        score,
        distance_m: d,
        h3: placeH3,
        cameras_in_k1: camsK1,
        cameras_in_cell: camsInCell,
        report_yes: yes,
        report_no: no,
        conflict,
        reasons,
      });
    }

    for (const pl of places) {
      if (!pl || !Number.isFinite(pl.lat) || !Number.isFinite(pl.lon)) continue;
      scorePlace(pl);
    }
    for (const h of hotspots) scorePlace(h);

    scored.sort((a, b) => b.score - a.score);

    // If user excluded all place kinds, return hotspots only (or empty if community disabled)
    if (allowedKinds.length === 0) {
      const onlyHotspots = communityEnabled ? dedupeByDistance(scored.filter((x) => x.place.kind === "community_hotspot"), 250) : [];
      const payload = {
        intent,
        intentLabel: cfg.label,
        bbox: bboxParam,
        results: onlyHotspots.slice(0, maxResults),
        meta: {
          placesFetched: places.length,
          camerasFetched: cameras.length,
          reportCellsFetched: reportCells.length,
          hotspotCandidates: hotspots.length,
          allowedKinds,
          communityEnabled,
        },
        note: communityEnabled
          ? "Community-only mode: showing community hotspot candidates."
          : "All place kinds excluded and community disabled, returning no results.",
      };

      memCache.set(cacheKey, { at: now, data: payload });
      return NextResponse.json(payload, { status: 200 });
    }

    // Diversity selection: cap hotspots so they do not take over the list
    const maxHotspots = communityEnabled ? Math.min(2, Math.ceil(maxResults / 3)) : 0;

    const hotspotsSorted = dedupeByDistance(
        scored.filter((x) => x.place.kind === "community_hotspot"),
        250
        );

        const othersSorted = dedupeByDistance(
        scored.filter((x) => x.place.kind !== "community_hotspot"),
        250
        );

    const hasEvidence = (x: RecommendItem) => x.cameras_in_k1 > 0 || x.report_yes > 0;
    const primary = othersSorted.filter(hasEvidence);
    const secondary = othersSorted.filter((x) => !hasEvidence(x));

    const top: RecommendItem[] = [];
    const used = new Set<string>();

    // Add a few hotspots (optional signal)
    for (const h of hotspotsSorted) {
      if (top.length >= maxHotspots) break;
      if (used.has(h.place.id)) continue;
      top.push(h);
      used.add(h.place.id);
    }

    // Then real places, prioritized by evidence
    for (const it of primary) {
      if (top.length >= maxResults) break;
      if (used.has(it.place.id)) continue;
      top.push(it);
      used.add(it.place.id);
    }

    // Fill any remaining slots
    for (const it of secondary) {
      if (top.length >= maxResults) break;
      if (used.has(it.place.id)) continue;
      top.push(it);
      used.add(it.place.id);
    }

    const payload = {
      intent,
      intentLabel: cfg.label,
      bbox: bboxParam,
      results: top.slice(0, maxResults),
      meta: {
        placesFetched: places.length,
        camerasFetched: cameras.length,
        reportCellsFetched: reportCells.length,
        hotspotCandidates: hotspots.length,
        allowedKinds,
        communityEnabled,
        maxHotspots,
      },
      note: "Recommendations prioritize meetup-friendly places. Community hotspots are capped so they do not dominate.",
    };

    memCache.set(cacheKey, { at: now, data: payload });
    return NextResponse.json(payload, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e), intent }, { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}
import { NextResponse } from "next/server";
import { latLngToCell, gridDisk, cellToLatLng, cellToParent } from "h3-js";
import { getGemini } from "@/lib/gemini";

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

  place_name?: string;
  place_kind?: string;
  place_id?: string | null;
  place_source?: string;
  place_address?: string | null;
  details?: any;
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

  report_signage: number;
  report_summary?: string | null;
  report_signage_text?: string | null;

  report_place_name?: string | null;
  report_place_kind?: string | null;
  report_place_id?: string | null;
  report_place_source?: string | null;
  report_place_address?: string | null;
  report_details?: any;

  // internal helpers
  _dedupeKey?: string;
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

type CacheEntry = { at: number; data: any };
const memCache = new Map<string, CacheEntry>();

function baseUrlFromReq(req: Request) {
  const host = req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}


function normalizeNameForKey(name?: string | null) {
  return String(name || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeByNameAndDistance(items: RecommendItem[], maxMeters = 180) {
  const out: RecommendItem[] = [];

  for (const it of items) {
    const nameKey = normalizeNameForKey(it.place.name || it.report_place_name);
    const isDup = out.some((o) => {
      const otherKey = normalizeNameForKey(o.place.name || o.report_place_name);
      if (!nameKey || !otherKey) return false;
      if (nameKey !== otherKey) return false;

      const d = haversineMeters(o.place.lat, o.place.lon, it.place.lat, it.place.lon);
      return d <= maxMeters;
    });

    if (!isDup) out.push(it);
  }

  return out;
}


function normalizeText(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quickHashBase36(s: string) {
  const str = String(s || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
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
  const t = normalizeText(text);
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
        community_hotspot: 0.55,
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
        community_hotspot: 0.5,
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
        community_hotspot: 0.55,
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
      community_hotspot: 0.55,
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

function nameMatchScore(a?: string, b?: string) {
  const A = normalizeText(a || "");
  const B = normalizeText(b || "");
  if (!A || !B) return 0;

  if (A === B) return 1;

  // token overlap
  const aToks = new Set(A.split(" ").filter(Boolean));
  const bToks = new Set(B.split(" ").filter(Boolean));
  let inter = 0;
  for (const t of aToks) if (bToks.has(t)) inter++;
  const denom = Math.max(1, Math.min(aToks.size, bToks.size));
  const overlap = inter / denom;

  // substring helps for "gore" vs "gore hall"
  const sub = A.includes(B) || B.includes(A) ? 0.35 : 0;

  return Math.max(overlap, sub);
}

function promptMentionsPlace(text: string, placeName?: string) {
  const t = normalizeText(text);
  const n = normalizeText(placeName || "");
  if (!t || !n) return 0;

  // try matching full name and also key tokens
  if (t.includes(n)) return 1;

  const toks = n.split(" ").filter(Boolean);
  if (toks.length) {
    const strongTok = toks.find((x) => x.length >= 4 && t.includes(x));
    if (strongTok) return 0.55;
  }
  return 0;
}

// Dedupes "same place represented multiple times" without killing nearby distinct buildings
function dedupeBestByKey(items: RecommendItem[]) {
  const best = new Map<string, RecommendItem>();

  for (const it of items) {
    const nameKey = it.place.name ? normalizeText(it.place.name) : "";
    const cellKey = latLngToCell(it.place.lat, it.place.lon, 13);
    const key = nameKey ? `${it.place.kind}|${nameKey}` : `${it.place.kind}|${cellKey}`;

    it._dedupeKey = key;

    const prev = best.get(key);
    if (!prev || it.score > prev.score) best.set(key, it);
  }

  return Array.from(best.values());
}

function pickBestNearbyReportCell(repMap: Map<string, ReportCell>, h3: string, k: number) {
  let best: ReportCell | null = null;
  let bestW = -1;

  for (const hh of gridDisk(h3, k)) {
    const c = repMap.get(hh);
    if (!c) continue;

    const w = safeNum(c.camera_present_count) + safeNum(c.camera_absent_count) + safeNum(c.signage_count);
    if (w > bestW) {
      bestW = w;
      best = c;
    }
  }

  return best;
}

async function aiRerankResults(opts: {
  ai: any;
  text: string;
  intentLabel: string;
  userLat: number;
  userLon: number;
  items: RecommendItem[];
}) {
  const { ai, text, intentLabel, userLat, userLon, items } = opts;

  if (items.length <= 1) {
    return { ordered: items, aiUsed: false, aiReasons: {} as Record<string, string> };
  }

  // Keep prompt small but include what matters for the UX
  const candidates = items.slice(0, 25).map((it) => ({
    id: it.place.id,
    name: it.place.name ?? null,
    kind: it.place.kind,
    distance_m: Math.round(it.distance_m),
    cameras_in_k1: it.cameras_in_k1,
    report_yes: it.report_yes,
    report_no: it.report_no,
    report_signage: it.report_signage,
    conflict: it.conflict,
    report_place_name: it.report_place_name ?? null,
    report_summary_present: Boolean(it.report_summary && String(it.report_summary).trim()),
  }));

  const prompt =
    `You are ranking meetup locations for the user request.\n` +
    `User request: ${JSON.stringify(text)}\n` +
    `Intent label: ${JSON.stringify(intentLabel)}\n` +
    `User location: ${userLat.toFixed(5)}, ${userLon.toFixed(5)}\n\n` +
    `Candidate fields:\n` +
    `- kind: type of place\n` +
    `- distance_m: distance from user\n` +
    `- cameras_in_k1: map camera markers nearby (higher means more cameras)\n` +
    `- report_yes/report_no: community reports about cameras\n` +
    `- report_signage: count of signage mentions\n` +
    `- conflict: true if both yes and no reports exist\n\n` +
    `Ranking rules:\n` +
    `- Strongly prioritize community evidence: higher report_yes and report_signage.\n` +
    `- Penalize high report_no and penalize conflict.\n` +
    `- Prefer closer distance when evidence is similar.\n` +
    `- Use the user request semantics: for studying prefer library/cafe; for parking prefer parking/mall; for night prefer police/mall.\n` +
    `- Do NOT remove candidates, only reorder.\n` +
    `- Use ONLY the ids provided. Do NOT invent ids.\n\n` +
    `Return ONLY valid JSON with this exact shape:\n` +
    `{"order": string[], "reasons": Record<string,string>}\n\n` +
    `Candidates:\n` +
    `${JSON.stringify(candidates)}`;

  const timeoutMs = 6000;
  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ai_rerank_timeout")), timeoutMs));

  const aiPromise = ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });

  let aiJson: any = null;
  try {
    const resp: any = await Promise.race([aiPromise, timeoutPromise]);
    const txt = String(resp?.text ?? "").trim();
    aiJson = txt ? JSON.parse(txt) : null;
  } catch {
    aiJson = null;
  }

  const order: string[] = Array.isArray(aiJson?.order) ? aiJson.order.map(String) : [];
  const reasons: Record<string, string> = aiJson?.reasons && typeof aiJson.reasons === "object" ? aiJson.reasons : {};

  const byId = new Map(items.map((it) => [it.place.id, it]));
  const used = new Set<string>();
  const ordered: RecommendItem[] = [];

  for (const id of order) {
    const it = byId.get(id);
    if (!it) continue;
    if (used.has(id)) continue;
    used.add(id);

    const r = reasons[id];
    if (r && typeof r === "string" && r.trim()) {
      it.reasons = [r.trim().slice(0, 90), ...it.reasons];
    }
    ordered.push(it);
  }

  for (const it of items) {
    if (used.has(it.place.id)) continue;
    ordered.push(it);
  }

  return { ordered, aiUsed: ordered.length > 0, aiReasons: reasons };
}

export async function POST(req: Request) {
  const ai = getGemini();
  const CAM_RES = 10; // scoring resolution
  const HOTSPOT_RES = 9; // merge report cells for hotspot markers
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
  const textKey = quickHashBase36(normalizeText(text).slice(0, 260)); // make prompt affect caching
  const cacheKey = `rec:${intent}:${lat.toFixed(4)}:${lon.toFixed(4)}:${maxResults}:t=${textKey}:ex=${excludeKey}`;

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
    const placesPromise =
      allowedKinds.length === 0
        ? Promise.resolve({ places: [] as Place[] })
        : fetch(
            `${baseUrl}/api/places?bbox=${encodeURIComponent(bboxParam)}&kinds=${encodeURIComponent(allowedKinds.join(","))}`,
            { signal: controller.signal }
          )
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

    // Cameras per CAM_RES cell
    const camCounts = new Map<string, number>();
    for (const p of cameras) {
      const plat = Number(p?.lat);
      const plon = Number(p?.lon);
      if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
      const h3 = latLngToCell(plat, plon, CAM_RES);
      camCounts.set(h3, (camCounts.get(h3) || 0) + 1);
    }

    // Reports by CAM_RES cell
    const repMap = new Map<string, ReportCell>();
    for (const c of reportCells) {
      if (!c?.h3_index) continue;
      repMap.set(c.h3_index, c);
    }

    // Build merged hotspots (optional)
    const hotspots: Place[] = [];
    if (communityEnabled) {
      type HotAgg = { yes: number; no: number; count: number; bestChild: string; bestYes: number };
      const agg = new Map<string, HotAgg>();

      for (const c of reportCells) {
        const yes = safeNum(c?.camera_present_count);
        const no = safeNum(c?.camera_absent_count);
        if (yes < 2) continue;

        const child = c.h3_index;
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
          if (yes > prev.bestYes) {
            prev.bestYes = yes;
            prev.bestChild = child;
          }
        }
      }

      for (const [parent, a] of agg.entries()) {
        const [centerLat, centerLon] = cellToLatLng(a.bestChild);

        const d = haversineMeters(lat, lon, centerLat, centerLon);
        if (d > cfg.maxDistanceM * 1.05) continue;

        const bestCell = repMap.get(a.bestChild);
        const hotspotName =
          (bestCell?.place_name && String(bestCell.place_name).trim()) ||
          (a.yes >= 5 ? "Community confirmed camera area" : "Community reported camera area");

        hotspots.push({
          id: `community/${parent}`,
          kind: "community_hotspot",
          name: hotspotName,
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

      // If this exact cell has no report row, try nearby cells so "same building area" still gets evidence
      let cell = repMap.get(placeH3) || null;

if (!cell) {
  const bestNearby = pickBestNearbyReportCell(repMap, placeH3, 1);

  // only borrow if the report place name matches this place name decently
  const match = nameMatchScore(pl.name, bestNearby?.place_name);
  if (match >= 0.45) cell = bestNearby;
}

      const yes = safeNum(cell?.camera_present_count);
      const no = safeNum(cell?.camera_absent_count);
      const signage = safeNum(cell?.signage_count);
      const conflict = yes > 0 && no > 0;

      const reportSummary = typeof cell?.summary === "string" ? cell.summary : null;
      const reportSignageText = typeof cell?.signage_text === "string" ? cell.signage_text : null;

      const reportPlaceName = typeof cell?.place_name === "string" ? cell.place_name : null;
      const reportPlaceKind = typeof cell?.place_kind === "string" ? cell.place_kind : null;
      const reportPlaceSource = typeof cell?.place_source === "string" ? cell.place_source : null;
      const reportPlaceId = cell?.place_id != null ? String(cell.place_id) : null;
      const reportPlaceAddress = typeof cell?.place_address === "string" ? cell.place_address : null;
      const reportDetails = cell?.details ?? null;

      // Core scoring: emphasize community reports first, then distance, then cameras.
      // Keep type influence small so adding a new nearby place does not automatically kick out the old one.
      const distScore = clamp01(1 - d / cfg.maxDistanceM);

      // soft log scale: 0..1-ish
      const camScore = clamp01(Math.log1p(camsK1) / Math.log(1 + 18));

      // community evidence: yes boosts, no penalizes; signage mildly boosts
      let repScore = 0;
      if (yes >= 6) repScore += 1.15;
      else if (yes >= 4) repScore += 0.95;
      else if (yes >= 2) repScore += 0.70;
      else if (yes >= 1) repScore += 0.30;

      if (no >= 6) repScore -= 0.95;
      else if (no >= 4) repScore -= 0.70;
      else if (no >= 2) repScore -= 0.35;
      else if (no >= 1) repScore -= 0.15;

      const signageScore = clamp01(signage / 4) * 0.35;

      // Name matching: if reports in this cell are about a specific place, prefer that place
      const match = nameMatchScore(pl.name, reportPlaceName);
      const placeMatchBoost = match >= 0.75 ? 0.45 : match >= 0.45 ? 0.22 : 0;

      // If the cell has a different named place and this place does not match, lightly avoid "borrowing" those reviews
      const mismatchPenalty = reportPlaceName && match < 0.2 ? 0.10 : 0;

      // If the user prompt mentions the place name, bump it (lets users ask for Gore Hall directly)
      const promptBoost = promptMentionsPlace(text, pl.name) > 0 ? 0.35 : 0;

      // Small type bonus (not dominating)
      const typeW = cfg.kindWeight[pl.kind] ?? 0.55;
      const typeBonus = (typeW - 0.55) * 0.8;

      const isHotspot = pl.kind === "community_hotspot";
      const conflictPenalty = conflict ? 0.35 : 0;

      // Hotspots should help but not auto-win
      const weakHotspotPenalty = isHotspot && camsK1 === 0 && yes < 5 ? 0.28 : 0;

      const score =
        repScore * 2.5 +
        signageScore * 1.0 +
        distScore * 1.7 +
        camScore * 1.1 +
        typeBonus +
        placeMatchBoost +
        promptBoost -
        mismatchPenalty -
        conflictPenalty -
        weakHotspotPenalty;

      const reasons: string[] = [];

      if (placeMatchBoost > 0) reasons.push("Matches community reports for this place");
      if (promptBoost > 0) reasons.push("Matches your request");

      if (isHotspot) {
        reasons.push(yes >= 5 ? "Community confirmed camera presence" : "Community reports camera presence");
      } else {
        reasons.push(`Type: ${pl.kind.replaceAll("_", " ")}`);
      }

      if (yes >= 5) reasons.push("High community confidence");
      else if (yes >= 2) reasons.push("Some community confirmation");
      else if (no >= 2) reasons.push("Community reports fewer cameras");

      if (camsK1 >= 6) reasons.push("High camera marker density nearby");
      else if (camsK1 >= 2) reasons.push("Some camera markers nearby");
      else reasons.push("Camera coverage uncertain (map data can be incomplete)");

      if (signage >= 1) reasons.push("Signage mentioned nearby");
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
        report_signage: signage,
        conflict,
        reasons,

        report_summary: reportSummary,
        report_signage_text: reportSignageText,

        report_place_name: reportPlaceName,
        report_place_kind: reportPlaceKind,
        report_place_id: reportPlaceId,
        report_place_source: reportPlaceSource,
        report_place_address: reportPlaceAddress,
        report_details: reportDetails,
      });
    }

    for (const pl of places) {
      if (!pl || !Number.isFinite(pl.lat) || !Number.isFinite(pl.lon)) continue;
      scorePlace(pl);
    }
    for (const h of hotspots) scorePlace(h);

    // IMPORTANT: dedupe by "same place" key, not by distance (so Gore and Evans can both exist)
    const deduped = dedupeBestByKey(scored);

    // Sort high score first
    deduped.sort((a, b) => b.score - a.score);

    // If user excluded all place kinds, return hotspots only (or empty if community disabled)
    if (allowedKinds.length === 0) {
      const onlyHotspots = communityEnabled ? deduped.filter((x) => x.place.kind === "community_hotspot") : [];
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

    // Cap hotspots so they do not dominate
    const maxHotspots = communityEnabled ? Math.min(2, Math.ceil(maxResults / 3)) : 0;

    const hotspotsSorted = deduped.filter((x) => x.place.kind === "community_hotspot");
    const othersSorted = deduped.filter((x) => x.place.kind !== "community_hotspot");

    // Prefer evidence, but allow close-by strong places to compete fairly
    const evidenceStrength = (x: RecommendItem) => x.report_yes * 2 + x.report_signage + Math.min(6, x.cameras_in_k1);
    const hasEvidence = (x: RecommendItem) => evidenceStrength(x) >= 2;

    const primary = othersSorted.filter(hasEvidence);
    const secondary = othersSorted.filter((x) => !hasEvidence(x));

    const top: RecommendItem[] = [];
    const usedIds = new Set<string>();

    for (const h of hotspotsSorted) {
      if (top.length >= maxHotspots) break;
      if (usedIds.has(h.place.id)) continue;
      top.push(h);
      usedIds.add(h.place.id);
    }

    for (const it of primary) {
      if (top.length >= maxResults) break;
      if (usedIds.has(it.place.id)) continue;
      top.push(it);
      usedIds.add(it.place.id);
    }

    for (const it of secondary) {
      if (top.length >= maxResults) break;
      if (usedIds.has(it.place.id)) continue;
      top.push(it);
      usedIds.add(it.place.id);
    }

    let finalTop = top.slice(0, maxResults);
    let aiRerankUsed = false;

    try {
      const rr = await aiRerankResults({
        ai,
        text,
        intentLabel: cfg.label,
        userLat: lat,
        userLon: lon,
        items: finalTop,
      });

      finalTop = rr.ordered.slice(0, maxResults);
      aiRerankUsed = rr.aiUsed;
    } catch {
      // keep deterministic order if AI fails
    }

    finalTop = dedupeByNameAndDistance(finalTop, 180).slice(0, maxResults);

    const payload = {
      intent,
      intentLabel: cfg.label,
      bbox: bboxParam,
      results: finalTop,
      meta: {
        placesFetched: places.length,
        camerasFetched: cameras.length,
        reportCellsFetched: reportCells.length,
        hotspotCandidates: hotspots.length,
        allowedKinds,
        communityEnabled,
        maxHotspots,
        aiRerankUsed,
        cacheKeyHint: cacheKey.slice(0, 60),
      },
      note:
        "Recommendations prioritize community reports first, then distance, then camera markers. Place type has only a small influence so one nearby new place will not automatically kick out another.",
    };

    memCache.set(cacheKey, { at: now, data: payload });
    return NextResponse.json(payload, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e), intent }, { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}
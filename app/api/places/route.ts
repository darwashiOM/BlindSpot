import { NextResponse } from "next/server";

export const runtime = "nodejs";

type PlaceKind =
  | "police"
  | "mall"
  | "mcd"
  | "park"
  | "cafe"
  | "library"
  | "parking"
  | "community_centre";

type Place = {
  id: string;
  kind: PlaceKind;
  name?: string;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
};

type CacheEntry = { at: number; data: Place[] };
const memCache = new Map<string, CacheEntry>();

const ALL_KINDS: PlaceKind[] = [
  "police",
  "mall",
  "mcd",
  "park",
  "cafe",
  "library",
  "parking",
  "community_centre",
];

function parseBBoxParam(bboxRaw: string | null) {
  if (!bboxRaw) return null;
  const parts = bboxRaw.split(",").map((x) => Number(x));
  if (parts.length !== 4) return null;
  const [south, west, north, east] = parts;
  if (![south, west, north, east].every((n) => Number.isFinite(n))) return null;
  if (north <= south) return null;
  return { south, west, north, east };
}

function parseKindsParam(kindsRaw: string | null): PlaceKind[] {
  if (!kindsRaw) return ALL_KINDS;
  const parts = kindsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out: PlaceKind[] = [];
  for (const p of parts) {
    if ((ALL_KINDS as string[]).includes(p)) out.push(p as PlaceKind);
  }
  return out.length ? out : ALL_KINDS;
}

function classify(tags: Record<string, string> | undefined): PlaceKind | null {
  if (!tags) return null;

  if (tags.amenity === "police") return "police";
  if (tags.shop === "mall") return "mall";

  if (tags.leisure === "park") return "park";
  if (tags.amenity === "cafe") return "cafe";
  if (tags.amenity === "library") return "library";
  if (tags.amenity === "parking") return "parking";
  if (tags.amenity === "community_centre") return "community_centre";

  // McDonald's matching (OSM often uses brand:wikidata)
  if (tags["brand:wikidata"] === "Q38076") return "mcd";
  if (tags.brand && tags.brand.toLowerCase().includes("mcdonald")) return "mcd";
  if (tags.name && tags.name.toLowerCase().includes("mcdonald")) return "mcd";
  if (tags.amenity === "fast_food" && tags.name?.toLowerCase().includes("mcdonald")) return "mcd";

  return null;
}

function buildOverpassQuery(
  b: { south: number; west: number; north: number; east: number },
  kinds: PlaceKind[]
) {
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;

  const lines: string[] = [];

  if (kinds.includes("police")) lines.push(`nwr["amenity"="police"](${bbox});`);
  if (kinds.includes("mall")) lines.push(`nwr["shop"="mall"](${bbox});`);

  if (kinds.includes("park")) lines.push(`nwr["leisure"="park"](${bbox});`);
  if (kinds.includes("cafe")) lines.push(`nwr["amenity"="cafe"](${bbox});`);
  if (kinds.includes("library")) lines.push(`nwr["amenity"="library"](${bbox});`);
  if (kinds.includes("parking")) lines.push(`nwr["amenity"="parking"](${bbox});`);
  if (kinds.includes("community_centre")) lines.push(`nwr["amenity"="community_centre"](${bbox});`);

  if (kinds.includes("mcd")) {
    lines.push(`nwr["brand:wikidata"="Q38076"](${bbox});`);
    lines.push(`nwr["amenity"="fast_food"]["brand"="McDonald's"](${bbox});`);
  }

  return `
[out:json][timeout:25];
(
  ${lines.join("\n  ")}
);
out center;
  `.trim();
}

async function fetchOverpass(query: string, signal: AbortSignal) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  let lastErr: any = null;

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "user-agent": "BlindSpotHackathon/1.0 (Next.js)",
        },
        body: query,
        signal,
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Overpass failed (${res.status}): ${t.slice(0, 180)}`);
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  throw lastErr || new Error("Overpass failed");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const bbox = parseBBoxParam(searchParams.get("bbox"));

  // NEW: allow single kind=police (for sequential loading)
  const kindRaw = searchParams.get("kind");
  const kinds =
    kindRaw && (ALL_KINDS as string[]).includes(kindRaw)
      ? ([kindRaw as PlaceKind] as PlaceKind[])
      : parseKindsParam(searchParams.get("kinds"));

  if (!bbox) {
    return NextResponse.json({ places: [], error: "bad_bbox" }, { status: 200 });
  }

  // guard huge bboxes
  const latSpan = Math.abs(bbox.north - bbox.south);
  const lonSpan = Math.abs(bbox.east - bbox.west);
  if (latSpan > 0.6 || lonSpan > 0.6) {
    return NextResponse.json(
      { places: [], note: "zoom_in_for_places" },
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  }

  // IMPORTANT: do not mutate kinds with .sort()
  const key =
    `places:${[...kinds].sort().join("|")}:` +
    `${bbox.south.toFixed(4)}:${bbox.west.toFixed(4)}:${bbox.north.toFixed(4)}:${bbox.east.toFixed(4)}`;

  const now = Date.now();
  const ttlMs = 10 * 60 * 1000;

  const hit = memCache.get(key);
  if (hit && now - hit.at < ttlMs) {
    return NextResponse.json(
      { places: hit.data, cached: true },
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const q = buildOverpassQuery(bbox, kinds);
    const json = await fetchOverpass(q, controller.signal);

    const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];

    const out: Place[] = [];
    const seen = new Set<string>();

    for (const el of elements) {
      const type = el?.type;
      const idNum = el?.id;
      if (!type || !idNum) continue;

      const id = `${type}/${idNum}`;
      if (seen.has(id)) continue;

      const tags: Record<string, string> | undefined = el?.tags;
      const kind = classify(tags);
      if (!kind) continue;
      if (!kinds.includes(kind)) continue;

      const lat = Number(el?.lat ?? el?.center?.lat);
      const lon = Number(el?.lon ?? el?.center?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      seen.add(id);
      out.push({
        id,
        kind,
        name: tags?.name,
        lat,
        lon,
        tags,
      });
    }

    // keep response small
    const trimmed = out.slice(0, 700);

    memCache.set(key, { at: now, data: trimmed });

    return NextResponse.json(
      { places: trimmed, cached: false },
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  } catch (e: any) {
    return NextResponse.json({ places: [], error: String(e?.message || e) }, { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}
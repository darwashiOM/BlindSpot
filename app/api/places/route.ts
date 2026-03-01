import { NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";

type PlaceKind =
  | "police"
  | "mall"
  | "mcd"
  | "park"
  | "cafe"
  | "library"
  | "community_centre";

type Place = {
  id: string;
  kind: PlaceKind;
  name?: string;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
  // Optional: if you later add it in DB
  address?: string | null;
};

const ALL_KINDS: PlaceKind[] = [
  "police",
  "mall",
  "mcd",
  "park",
  "cafe",
  "library",
  "community_centre",
];

const dbUrl = process.env.DATABASE_URL || "";
const isLocalDb =
  dbUrl.includes("localhost") ||
  dbUrl.includes("127.0.0.1") ||
  dbUrl.includes("postgresql://postgres@") ||
  dbUrl.includes("postgres://postgres@");

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false },
});

function parseBBoxParam(bboxRaw: string | null) {
  if (!bboxRaw) return null;
  const parts = bboxRaw.split(",").map((x) => Number(x));
  if (parts.length !== 4) return null;

  const [south, west, north, east] = parts;

  if (![south, west, north, east].every((n) => Number.isFinite(n))) return null;
  if (north <= south) return null;

  // handle dateline? (optional)
  if (east <= west) return null;

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

  // if they passed only invalid kinds, return empty (don’t fall back to ALL)
  return out;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const bbox = parseBBoxParam(searchParams.get("bbox"));
  if (!bbox) {
    return NextResponse.json({ places: [], error: "bad_bbox" }, { status: 200 });
  }

  // Backward compat:
  // - /api/places?kind=cafe
  // - /api/places?kinds=cafe,park
  const kindRaw = searchParams.get("kind")?.trim() || null;

  // If "kind" is provided but invalid, return empty instead of falling back to ALL.
  if (kindRaw && !(ALL_KINDS as string[]).includes(kindRaw)) {
    return NextResponse.json({ places: [], error: "bad_kind" }, { status: 200 });
  }

  const kinds: PlaceKind[] =
    kindRaw && (ALL_KINDS as string[]).includes(kindRaw)
      ? [kindRaw as PlaceKind]
      : parseKindsParam(searchParams.get("kinds"));

  // If they explicitly asked for kinds (kinds=...) but all were invalid
  const kindsParamProvided = searchParams.has("kinds") && kindRaw == null;
  if (kindsParamProvided && kinds.length === 0) {
    return NextResponse.json({ places: [], error: "bad_kinds" }, { status: 200 });
  }

  // If neither kind nor kinds are provided, default to ALL
  const effectiveKinds = kindRaw == null && !searchParams.has("kinds") ? ALL_KINDS : kinds;

  // Guard massive bboxes to prevent expensive full-table scans
  const latSpan = Math.abs(bbox.north - bbox.south);
  const lonSpan = Math.abs(bbox.east - bbox.west);
  if (latSpan > 0.6 || lonSpan > 0.6) {
    return NextResponse.json(
      { places: [], note: "zoom_in_for_places" },
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  }

  try {
    const { rows } = await pool.query(
      `
      select osm_id, kind, name, lat, lon, tags
      from places_static
      where lat between $1 and $2
        and lon between $3 and $4
        and kind = any($5)
      limit 700
      `,
      [bbox.south, bbox.north, bbox.west, bbox.east, effectiveKinds]
    );

    const places: Place[] = (rows || []).map((r: any) => ({
      id: String(r.osm_id),
      kind: r.kind as PlaceKind,
      name: r.name ?? undefined,
      lat: Number(r.lat),
      lon: Number(r.lon),
      tags: r.tags ?? undefined,
      // address: r.address ?? null, // if you add it later
    }));

    return NextResponse.json(
      { places, cached: true },
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  } catch (e: any) {
    return NextResponse.json({ places: [], error: String(e?.message || e) }, { status: 200 });
  }
}
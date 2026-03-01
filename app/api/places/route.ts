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

const ALL_KINDS: PlaceKind[] = [
  "police",
  "mall",
  "mcd",
  "park",
  "cafe",
  "library",
  "parking",
  "community_centre"
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
  return out;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const bbox = parseBBoxParam(searchParams.get("bbox"));

  const kindRaw = searchParams.get("kind");

// If "kind" is provided but invalid, return empty instead of falling back to ALL.
if (kindRaw && !(ALL_KINDS as string[]).includes(kindRaw)) {
  return NextResponse.json({ places: [], error: "bad_kind" }, { status: 200 });
}

const kinds =
  kindRaw && (ALL_KINDS as string[]).includes(kindRaw)
    ? ([kindRaw as PlaceKind] as PlaceKind[])
    : parseKindsParam(searchParams.get("kinds"));

  if (!bbox) {
    return NextResponse.json({ places: [], error: "bad_bbox" }, { status: 200 });
  }

  // ✅ Guard massive bboxes to prevent expensive full-table scans
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
      [bbox.south, bbox.north, bbox.west, bbox.east, kinds]
    );

    const places: Place[] = rows.map((r: any) => ({
      id: String(r.osm_id),
      kind: r.kind,
      name: r.name ?? undefined,
      lat: Number(r.lat),
      lon: Number(r.lon),
      tags: r.tags ?? undefined,
    }));

    return NextResponse.json(
      { places, cached: true }, 
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  } catch (e: any) {
    return NextResponse.json({ places: [], error: String(e?.message || e) }, { status: 200 });
  }
}
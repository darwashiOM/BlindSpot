import { NextResponse } from "next/server";
import { z } from "zod";
import { LRUCache } from "lru-cache";
import { Pool } from "pg";

export const runtime = "nodejs";

type Pt = { lat: number; lon: number };

// Retain memory cache to reduce duplicate database queries
const cache = new LRUCache<string, { points: Pt[]; source: string }>({
  max: 200,
  ttl: 1000 * 60 * 5,
});

const schema = z.object({
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/),
});

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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = schema.safeParse({ bbox: url.searchParams.get("bbox") });

  if (!parsed.success) {
    return NextResponse.json({ error: "bad_bbox" }, { status: 400 });
  }

  const bboxStr = parsed.data.bbox;
  const cached = cache.get(bboxStr);
  if (cached) {
    return NextResponse.json(
      { ...cached, from_cache: true },
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  }

  const [south, west, north, east] = bboxStr.split(",").map(Number);

  // Guard massive bboxes to prevent expensive full-table scans
  const latSpan = Math.abs(north - south);
  const lonSpan = Math.abs(east - west);
  if (!Number.isFinite(latSpan) || !Number.isFinite(lonSpan) || latSpan > 1.2 || lonSpan > 1.2) {
    const payload = { points: [] as Pt[], source: "guard_zoom_in" };
    cache.set(bboxStr, payload);
    return NextResponse.json(payload, {
      status: 200,
      headers: { "cache-control": "public, max-age=60" },
    });
  }

  try {
    const { rows } = await pool.query(
      `
      select lat, lon
      from cameras_static
      where lat between $1 and $2
        and lon between $3 and $4
      limit 5000
      `,
      [south, north, west, east]
    );

    const points: Pt[] = (rows || []).map((r: any) => ({
      lat: Number(r.lat),
      lon: Number(r.lon),
    }));

    const payload = { points, source: "postgres" };
    cache.set(bboxStr, payload);

    return NextResponse.json(payload, {
      status: 200,
      headers: { "cache-control": "public, max-age=60" },
    });
  } catch (e: any) {
    // Returning 200 so the frontend doesn't crash, just shows empty results
    return NextResponse.json({ points: [], error: String(e?.message || e) }, { status: 200 });
  }
}
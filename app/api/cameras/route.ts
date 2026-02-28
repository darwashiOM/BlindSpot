import { NextResponse } from "next/server";
import { z } from "zod";
import { LRUCache } from "lru-cache";
import { Pool } from "pg";

export const runtime = "nodejs";

type Pt = { lat: number; lon: number };

// Retain memory cache to reduce duplicate database queries
const cache = new LRUCache<string, any>({ max: 200, ttl: 1000 * 60 * 5 });

const schema = z.object({
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/),
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = schema.safeParse({ bbox: url.searchParams.get("bbox") });

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid bbox" }, { status: 400 });
  }

  const bbox = parsed.data.bbox;
  const cached = cache.get(bbox);
  if (cached) {
    return NextResponse.json(
      { ...cached, from_cache: true },
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  }

  const [south, west, north, east] = bbox.split(",").map(Number);

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

    const points: Pt[] = rows.map((r: any) => ({
      lat: Number(r.lat),
      lon: Number(r.lon),
    }));

    const payload = { points, source: "postgres" };
    cache.set(bbox, payload);

    return NextResponse.json(
      payload,
      { status: 200, headers: { "cache-control": "public, max-age=60" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { points: [], error: String(e?.message || e) },
      { status: 200 } // Returning 200 so the frontend doesn't crash, just shows empty results
    );
  }
}
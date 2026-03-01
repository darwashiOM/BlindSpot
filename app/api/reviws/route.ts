import { NextResponse } from "next/server";
import { z } from "zod";
import { Pool } from "pg";
import { latLngToCell } from "h3-js";

export const runtime = "nodejs";

const CANONICAL_RES = 12;

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

const schema = z.object({
  lat: z.coerce.number(),
  lon: z.coerce.number(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = schema.safeParse({
    lat: url.searchParams.get("lat"),
    lon: url.searchParams.get("lon"),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "bad_lat_lon" }, { status: 400 });
  }

  const { lat, lon } = parsed.data;
  const h3 = latLngToCell(lat, lon, CANONICAL_RES);

  try {
    // total counts and latest summary/signage
    const agg = await pool.query(
      `
      select
        sum(case when claim = 'camera_present' then 1 else 0 end)::int as yes,
        sum(case when claim = 'camera_absent' then 1 else 0 end)::int as no,
        (array_agg(summary order by id desc))[1] as summary,
        (array_agg(signage_text order by id desc))[1] as signage_text
      from reports
      where is_allowed = true
        and h3_index = $1
      `,
      [h3]
    );

    // last few notes (do NOT return photo)
    const notes = await pool.query(
      `
      select claim, user_text
      from reports
      where is_allowed = true
        and h3_index = $1
      order by id desc
      limit 5
      `,
      [h3]
    );

    const row = agg.rows?.[0] || {};
    const yes = Number(row.yes || 0);
    const no = Number(row.no || 0);

    return NextResponse.json({
      h3_index: h3,
      yes,
      no,
      summary: row.summary ?? null,
      signage_text: row.signage_text ?? null,
      notes: (notes.rows || []).map((r: any) => ({
        claim: r.claim,
        text: String(r.user_text || "").slice(0, 180),
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
import { NextResponse } from "next/server";
import { z } from "zod";
import { Pool } from "pg";
import { latLngToCell, gridDisk } from "h3-js";

export const runtime = "nodejs";

const CANONICAL_RES = 12;

// How wide to read around the tapped point.
// 0 = only the exact cell
// 1 = include neighbors, etc.
const READ_K_DEFAULT = 4;

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

// Added optional k so the frontend can match your "READ_REPORT_K" behavior
const schema = z.object({
  lat: z.coerce.number(),
  lon: z.coerce.number(),
  k: z.coerce.number().int().min(0).max(10).optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = schema.safeParse({
    lat: url.searchParams.get("lat"),
    lon: url.searchParams.get("lon"),
    k: url.searchParams.get("k"),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "bad_lat_lon" }, { status: 400 });
  }

  const { lat, lon } = parsed.data;
  const k = parsed.data.k ?? READ_K_DEFAULT;

  const centerH3 = latLngToCell(lat, lon, CANONICAL_RES);
  const ring = gridDisk(centerH3, k); // includes center

  try {
    // Aggregate counts + pick the "best" summary/signage from the most informative cell
    // (highest (yes+no+signage_count)).
    const agg = await pool.query(
      `
      with ring as (
        select unnest($1::text[]) as h3_index
      ),
      cells as (
        select
          r.h3_index,
          sum(case when rep.claim = 'camera_present' then 1 else 0 end)::int as yes,
          sum(case when rep.claim = 'camera_absent' then 1 else 0 end)::int as no,
          sum(case when coalesce(rep.signage_count, 0) > 0 then coalesce(rep.signage_count, 0) else 0 end)::int as signage,
          (array_agg(rep.summary order by rep.id desc))[1] as summary,
          (array_agg(rep.signage_text order by rep.id desc))[1] as signage_text
        from ring r
        left join reports rep
          on rep.h3_index = r.h3_index
         and rep.is_allowed = true
        group by r.h3_index
      )
      select
        coalesce(sum(yes), 0)::int as yes,
        coalesce(sum(no), 0)::int as no,
        coalesce(sum(signage), 0)::int as signage,
        count(*) filter (where (yes + no + signage) > 0)::int as matched_cells,
        (
          select c.summary
          from cells c
          order by (c.yes + c.no + c.signage) desc, c.h3_index asc
          limit 1
        ) as summary,
        (
          select c.signage_text
          from cells c
          order by (c.yes + c.no + c.signage) desc, c.h3_index asc
          limit 1
        ) as signage_text
      from cells
      `,
      [ring]
    );

    // Notes: last few notes in the ring (no photos), newest first
    const notes = await pool.query(
      `
      select claim, user_text, created_at
      from reports
      where is_allowed = true
        and h3_index = any($1::text[])
      order by id desc
      limit 8
      `,
      [ring]
    );

    const row = agg.rows?.[0] || {};
    const yes = Number(row.yes || 0);
    const no = Number(row.no || 0);
    const signage = Number(row.signage || 0);
    const matchedCells = Number(row.matched_cells || 0);

    return NextResponse.json({
      center_h3_index: centerH3,
      k,
      yes,
      no,
      signage,
      matchedCells,
      summary: row.summary ?? null,
      signage_text: row.signage_text ?? null,
      notes: (notes.rows || []).map((r: any) => ({
        claim: r.claim,
        text: String(r.user_text || "").slice(0, 220),
        created_at: r.created_at ?? null,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
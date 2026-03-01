import { NextResponse } from "next/server";
import { snowflakeQuery } from "@/lib/snowflakeSql";
import { pickErr, reqId, requireSecret, safeDayParam } from "../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = reqId();

  try {
    if (!requireSecret(req)) {
      return NextResponse.json({ ok: false, reqId: id, error: "forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const day = safeDayParam(url.searchParams.get("day"));

    const rows = await snowflakeQuery(
      `
      with day_cells as (
        select *
        from CIVICFIX.MART.HEATMAP_DAILY_RES10
        where D = coalesce(try_to_date(?), current_date())
      )
      select
        c.H3,
        c.D,
        c.YES,
        c.NO,
        c.SIGNAGE,
        c.CONFLICT,
        c.CONFIDENCE_TIER,
        ctx.PLACE_NAME,
        ctx.PLACE_KIND,
        ctx.SUMMARY,
        ctx.SIGNAGE_TEXT,
        ctx.DETAILS
      from day_cells c
      left join CIVICFIX.MART.LATEST_CONTEXT_RES10 ctx
        on ctx.H3 = c.H3
      order by (c.YES - c.NO) desc, c.SIGNAGE desc
      limit 2500
      `,
      [day]
    );

    return NextResponse.json({ ok: true, reqId: id, rows });
  } catch (e: any) {
    console.error(`[analytics:heatmap:${id}]`, e);
    return NextResponse.json({ ok: false, reqId: id, error: "heatmap_failed", detail: pickErr(e) }, { status: 500 });
  }
}
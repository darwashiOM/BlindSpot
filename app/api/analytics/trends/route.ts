import { NextResponse } from "next/server";
import { snowflakeQuery } from "@/lib/snowflakeSql";
import { pickErr, reqId, requireSecret } from "../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = reqId();

  try {
    if (!requireSecret(req)) {
      return NextResponse.json({ ok: false, reqId: id, error: "forbidden" }, { status: 403 });
    }

    const rows = await snowflakeQuery(
      `
      select
        DAY,
        YES_REPORTS,
        NO_REPORTS,
        SIGNAGE_MENTIONS,
        ACTIVE_CELLS,
        CONFLICT_RATE_CELLS,
        CONFIRMED_CELLS
      from CIVICFIX.MART.TRENDS_DAILY
      where DAY >= dateadd('day', -14, current_date())
      order by DAY asc
      `
    );

    return NextResponse.json({ ok: true, reqId: id, rows });
  } catch (e: any) {
    console.error(`[analytics:trends:${id}]`, e);
    return NextResponse.json({ ok: false, reqId: id, error: "trends_failed", detail: pickErr(e) }, { status: 500 });
  }
}
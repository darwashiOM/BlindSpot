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
        FROM_DAY,
        TO_DAY,
        YES_REPORTS,
        NO_REPORTS,
        SIGNAGE_MENTIONS,
        ACTIVE_CELLS,
        CONFLICT_CELLS,
        CONFLICT_RATE,
        CONFIRMED_CELLS
      from CIVICFIX.MART.OVERVIEW_LAST_7D
      `
    );

    return NextResponse.json({ ok: true, reqId: id, row: rows?.[0] || null });
  } catch (e: any) {
    console.error(`[analytics:overview:${id}]`, e);
    return NextResponse.json({ ok: false, reqId: id, error: "overview_failed", detail: pickErr(e) }, { status: 500 });
  }
}
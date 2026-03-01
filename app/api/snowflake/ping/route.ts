import { NextResponse } from "next/server";
import { snowflakeQuery } from "@/lib/snowflakeSql";

export const runtime = "nodejs";

export async function GET() {
  try {
    const rows = await snowflakeQuery(`
      select
        current_account() as account,
        current_region() as region,
        current_user() as user,
        current_role() as role,
        current_warehouse() as wh,
        current_database() as db,
        current_schema() as schema
    `);

    return NextResponse.json({ ok: true, rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
import { NextResponse } from "next/server";
import { snowflakeQuery } from "@/lib/snowflakeSql";
import { pickErr, reqId } from "../_util"

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const id = reqId();
  try {
    const ctx = await snowflakeQuery(`
      select
        current_account() as account,
        current_region() as region,
        current_user() as user,
        current_role() as role,
        current_warehouse() as wh,
        current_database() as db,
        current_schema() as schema
    `);

    const objs = await snowflakeQuery(`
      select table_name, table_schema, table_type
      from CIVICFIX.information_schema.tables
      where table_schema = 'MART'
        and table_name in ('HEATMAP_DAILY_RES10','LATEST_CONTEXT_RES10','OVERVIEW_LAST_7D','TRENDS_DAILY')
      order by table_name
    `);

    return NextResponse.json({ ok: true, reqId: id, ctx: ctx?.[0] || null, objects: objs || [] });
  } catch (e: any) {
    return NextResponse.json({ ok: false, reqId: id, detail: pickErr(e) }, { status: 500 });
  }
}
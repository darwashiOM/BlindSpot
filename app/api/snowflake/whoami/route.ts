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

    const env = {
      SNOWFLAKE_ACCOUNT: process.env.SNOWFLAKE_ACCOUNT || null,
      SNOWFLAKE_USERNAME: process.env.SNOWFLAKE_USERNAME || null,
      SNOWFLAKE_ROLE: process.env.SNOWFLAKE_ROLE || null,
      SNOWFLAKE_DATABASE: process.env.SNOWFLAKE_DATABASE || null,
      SNOWFLAKE_SCHEMA: process.env.SNOWFLAKE_SCHEMA || null,
      KEY_LEN: (process.env.SNOWFLAKE_PRIVATE_KEY_B64 || "").length,
    };

    return NextResponse.json({ ok: true, env, rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
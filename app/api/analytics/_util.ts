import crypto from "crypto";

export function reqId() {
  return crypto.randomUUID();
}

export function safeDayParam(day: string | null) {
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return day;
}

export function pickErr(e: any) {
  return {
    message: String(e?.message || e),
    code: e?.code ?? null,
    sqlState: e?.sqlState ?? e?.sql_state ?? null,
    queryId: e?.queryId ?? e?.query_id ?? null,
    name: e?.name ?? null,
  };
}

export function requireSecret(req: Request) {
  const secret = process.env.ANALYTICS_SECRET;
  if (!secret) return true;
  const got = req.headers.get("x-analytics-secret") || "";
  return got === secret;
}
type ExecResult = any;

export async function snowflakeExec(statement: string, binds: any[] = []): Promise<ExecResult> {
  const account = process.env.SNOWFLAKE_ACCOUNT!;
  const token = process.env.SNOWFLAKE_PAT!;

  const warehouse = process.env.SNOWFLAKE_WAREHOUSE!;
  const database = process.env.SNOWFLAKE_DATABASE!;
  const schema = process.env.SNOWFLAKE_SCHEMA!;
  const role = process.env.SNOWFLAKE_ROLE!;

  const url = `https://${account}.snowflakecomputing.com/api/v2/statements`;

  const body = {
    statement,
    timeout: 60,
    database,
    schema,
    warehouse,
    role,
    bindings: binds.map((v) => ({ type: "TEXT", value: String(v) })),
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "Authorization": `Bearer ${token}`,
      "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Snowflake SQL API failed (${r.status}): ${text.slice(0, 400)}`);

  return JSON.parse(text);
}
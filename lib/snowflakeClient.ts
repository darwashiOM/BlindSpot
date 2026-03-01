export async function snowflakeQuery<T = any>(sql: string, binds: any[] = []): Promise<T[]> {
  const conn = await getSnowflakeConnectionSomehow(); // reuse your existing connection logic
  return await new Promise<T[]>((resolve, reject) => {
    conn.execute({
      sqlText: sql,
      binds,
      complete: (err: any, _stmt: any, rows: T[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}
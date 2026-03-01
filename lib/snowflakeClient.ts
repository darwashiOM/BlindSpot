import "server-only";
import snowflake from "snowflake-sdk";

type Row = Record<string, any>;
let connPromise: Promise<snowflake.Connection> | null = null;

function requireEnv(name: string, val: string) {
  if (!val) throw new Error(`Missing ${name}`);
}

function buildCfg() {
  const account = (process.env.SNOWFLAKE_ACCOUNT || "").trim();
  const username = (process.env.SNOWFLAKE_USERNAME || process.env.SNOWFLAKE_USER || "").trim();

  const warehouse = (process.env.SNOWFLAKE_WAREHOUSE || "").trim();
  const database = (process.env.SNOWFLAKE_DATABASE || "CIVICFIX").trim();
  const schema = (process.env.SNOWFLAKE_SCHEMA || "PUBLIC").trim();
  const role = (process.env.SNOWFLAKE_ROLE || "").trim();

  const privateKeyB64 = (process.env.SNOWFLAKE_PRIVATE_KEY_B64 || "").trim();
  const pat = (process.env.SNOWFLAKE_PAT || "").trim();
  const password = (process.env.SNOWFLAKE_PASSWORD || "").trim();

  requireEnv("SNOWFLAKE_ACCOUNT", account);
  requireEnv("SNOWFLAKE_USERNAME (or SNOWFLAKE_USER)", username);

  const cfg: any = {
    account,
    username,
    warehouse: warehouse || undefined,
    database: database || undefined,
    schema: schema || undefined,
    role: role || undefined,
    clientSessionKeepAlive: true,
  };

  // Key pair auth (JWT)
  if (privateKeyB64) {
    const pem = Buffer.from(privateKeyB64, "base64").toString("utf8").trim();
    if (!pem.includes("BEGIN PRIVATE KEY")) {
      throw new Error(
        "SNOWFLAKE_PRIVATE_KEY_B64 must be PKCS8 PEM and start with -----BEGIN PRIVATE KEY-----"
      );
    }
    cfg.privateKey = pem;
    cfg.authenticator = "SNOWFLAKE_JWT";
    return cfg;
  }

  // PAT auth
  if (pat) {
    cfg.authenticator = "PROGRAMMATIC_ACCESS_TOKEN";
    cfg.token = pat;
    return cfg;
  }

  // Username/password auth
  requireEnv("SNOWFLAKE_PASSWORD", password);
  cfg.password = password;
  cfg.authenticator = "SNOWFLAKE";
  return cfg;
}

function getConnection() {
  if (connPromise) return connPromise;

  const cfg = buildCfg();
  connPromise = new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(cfg);
    conn.connect((err) => {
      if (err) {
        connPromise = null;
        reject(err);
        return;
      }
      resolve(conn);
    });
  });

  return connPromise;
}

async function execInternal<T = Row>(sqlText: string, binds: any[] = []) {
  const conn = await getConnection();

  return await new Promise<T[]>((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: T[]) => {
        if (err) {
          const msg = String(err?.message || err).toLowerCase();
          if (msg.includes("terminated") || msg.includes("closed")) connPromise = null;
          reject(err);
          return;
        }
        resolve(rows || []);
      },
    });
  });
}

export async function snowflakeQuery<T = Row>(sqlText: string, binds: any[] = []) {
  return await execInternal<T>(sqlText, binds);
}

export async function snowflakeExec(sqlText: string, binds: any[] = []) {
  await execInternal(sqlText, binds);
}
import { NextResponse } from "next/server";
import { z } from "zod";
import { LRUCache } from "lru-cache";

export const runtime = "nodejs";

const cache = new LRUCache<string, any>({ max: 200, ttl: 1000 * 60 * 5 });

const schema = z.object({
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/),
});

const OVERPASS_ENDPOINTS = [
  process.env.OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
].filter(Boolean) as string[];

async function tryOverpass(endpoint: string, query: string) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": "privacy-safety-map/1.0",
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: controller.signal,
    });

    const text = await resp.text(); // read text first so we can show errors
    if (!resp.ok) {
      return { ok: false as const, status: resp.status, text, endpoint };
    }

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false as const, status: resp.status, text, endpoint };
    }

    return { ok: true as const, status: resp.status, json, endpoint };
  } catch (e: any) {
    return { ok: false as const, status: 0, text: String(e?.message || e), endpoint };
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = schema.safeParse({ bbox: url.searchParams.get("bbox") });

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid bbox" }, { status: 400 });
  }

  const bbox = parsed.data.bbox;
  const cached = cache.get(bbox);
  if (cached) return NextResponse.json(cached);

  const [south, west, north, east] = bbox.split(",").map(Number);

  const query = `
[out:json][timeout:25];
(
  node["man_made"="surveillance"](${south},${west},${north},${east});
  way["man_made"="surveillance"](${south},${west},${north},${east});
  relation["man_made"="surveillance"](${south},${west},${north},${east});
);
out center;
`;

  let lastErr: any = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const res = await tryOverpass(endpoint, query);
    if (res.ok) {
      const points = (res.json.elements || [])
        .map((el: any) => {
          if (el.type === "node" && typeof el.lat === "number" && typeof el.lon === "number") {
            return { lat: el.lat, lon: el.lon };
          }
          if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") {
            return { lat: el.center.lat, lon: el.center.lon };
          }
          return null;
        })
        .filter(Boolean);

      const payload = { points, overpass: res.endpoint };
      cache.set(bbox, payload);
      return NextResponse.json(payload);
    }

    lastErr = res;
  }

  return NextResponse.json(
    {
      error: "Overpass failed",
      upstreamStatus: lastErr?.status,
      upstreamEndpoint: lastErr?.endpoint,
      upstreamBodyPreview: (lastErr?.text || "").slice(0, 300),
    },
    { status: 502 }
  );
}
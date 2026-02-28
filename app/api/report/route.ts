import { NextResponse } from "next/server";
import { z } from "zod";
import { Pool } from "pg";
import { ai } from "@/lib/gemini";
import { LRUCache } from "lru-cache";

export const runtime = "nodejs";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const postSchema = z.object({
  h3_index: z.string().min(5),
  lat: z.number(),
  lon: z.number(),
  mode: z.enum(["privacy", "safety"]),
  user_text: z.string().min(3).max(500),

  // Now required for proof
  signage_image_base64: z.string().min(50),
});

const getSchema = z.object({
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/),
});

// --- Overpass Public Check Helpers ---

const OVERPASS_ENDPOINTS = [
  process.env.OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
].filter(Boolean) as string[];

const publicCache = new LRUCache<string, boolean>({ max: 1000, ttl: 1000 * 60 * 60 * 24 });

async function tryOverpass(endpoint: string, query: string) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);

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

    const text = await resp.text();
    if (!resp.ok) return { ok: false as const, text };

    const json = JSON.parse(text);
    return { ok: true as const, json };
  } catch (e: any) {
    return { ok: false as const, text: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function isPublicPlace(lat: number, lon: number) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = publicCache.get(key);
  if (cached !== undefined) return cached;

  const query = `
[out:json][timeout:12];
(
  node(around:40,${lat},${lon})["highway"];
  way(around:40,${lat},${lon})["highway"];
  node(around:40,${lat},${lon})["amenity"];
  way(around:40,${lat},${lon})["amenity"];
  node(around:40,${lat},${lon})["leisure"];
  way(around:40,${lat},${lon})["leisure"];
  node(around:40,${lat},${lon})["shop"];
  way(around:40,${lat},${lon})["shop"];
  node(around:40,${lat},${lon})["public_transport"];
  way(around:40,${lat},${lon})["public_transport"];
);
out tags 25;
`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const res = await tryOverpass(endpoint, query);
    if (!res.ok) continue;

    const els = res.json?.elements || [];
    const publicHit = els.some((el: any) => {
      const t = el.tags || {};
      if (t.access && String(t.access).toLowerCase() === "private") return false;
      return Boolean(t.highway || t.amenity || t.leisure || t.shop || t.public_transport);
    });

    publicCache.set(key, publicHit);
    return publicHit;
  }

  // If Overpass is down, do not block submissions, just allow
  publicCache.set(key, true);
  return true;
}

// -------------------------------------

// GET /api/report?bbox=south,west,north,east
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const parsed = getSchema.safeParse({ bbox: url.searchParams.get("bbox") });
    if (!parsed.success) return NextResponse.json({ error: "Invalid bbox" }, { status: 400 });

    const [south, west, north, east] = parsed.data.bbox.split(",").map(Number);

    const { rows } = await pool.query(
      `
      select
        h3_index,
        count(*)::int as report_count,
        sum(case when signage_text is not null and signage_text <> '' then 1 else 0 end)::int as signage_count
      from reports
      where is_allowed = true
        and lat between $1 and $2
        and lon between $3 and $4
      group by h3_index
      `,
      [south, north, west, east]
    );

    return NextResponse.json({ cells: rows });
  } catch (e: any) {
    console.error("GET /api/report failed:", e);
    return NextResponse.json(
      { error: "GET /api/report failed", message: String(e?.message || e) },
      { status: 500 }
    );
  }
}

// POST /api/report
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Bad input" }, { status: 400 });
    }

    const { h3_index, lat, lon, mode, user_text, signage_image_base64 } = parsed.data;

    // Size guard so people cannot send huge images
    const base64Part = signage_image_base64.includes(",")
      ? signage_image_base64.split(",", 2)[1]
      : signage_image_base64;

    const approxBytes = Math.floor((base64Part.length * 3) / 4);
    if (approxBytes > 1_500_000) {
      return NextResponse.json({ error: "Image too large. Use a smaller photo." }, { status: 413 });
    }

    // 1. Verify it's a public place before spending AI tokens
    const publicOk = await isPublicPlace(lat, lon);
    if (!publicOk) {
      return NextResponse.json(
        { error: "Only public places are allowed. Private property submissions are rejected." },
        { status: 403 }
      );
    }

    // 2. Gemini text moderation
    const promptText =
      `You are moderating and structuring a map report about "how monitored a place feels".\n` +
      `Return ONLY valid JSON with this exact shape:\n` +
      `{"is_allowed": boolean, "tags": string[], "summary": string}\n` +
      `Rules:\n` +
      `- Block if it tries to help wrongdoing, evasion, stalking, or targeting people.\n` +
      `- Otherwise allow.\n` +
      `- tags should be short and useful: indoor, outdoor, entrance, parking, signage_present, crowded, quiet.\n\n` +
      `Report text: ${user_text}`;

    const moderation = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: promptText,
      config: {
        responseMimeType: "application/json",
      },
    });

    const aiText = (moderation.text ?? "").trim();
    if (!aiText) throw new Error("Gemini returned empty response");

    const aiJson = JSON.parse(aiText);

    if (!aiJson.is_allowed) {
      return NextResponse.json({ error: "Report not allowed" }, { status: 403 });
    }

    // 3. Optional signage extraction and proof verification (vision)
    let signageText: string | null = null;
    let autoTags: string[] = []; // Lifted to correctly merge tags

    if (signage_image_base64) {
      let mimeType = "image/jpeg";
      let data = signage_image_base64;

      if (data.includes(",")) {
        const [meta, b64] = data.split(",", 2);
        data = b64;
        const m = meta.match(/data:(.*?);base64/i);
        if (m?.[1]) mimeType = m[1];
      }

      const vision = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          { inlineData: { mimeType, data } },
          {
            text:
              `Analyze the photo as proof for a public safety/privacy report.\n` +
              `Return ONLY JSON with this exact shape:\n` +
              `{"proof_ok": boolean, "public_place": boolean, "contains_camera": boolean, "contains_signage": boolean, "signage_text": string|null}\n` +
              `Rules:\n` +
              `- proof_ok is true only if the image clearly relates to monitoring (camera visible, surveillance sign, CCTV sign, or obvious monitoring setup).\n` +
              `- public_place true if it looks like a public space (street, campus walkway, store entrance, parking lot, etc).\n` +
              `- signage_text should include any readable CCTV/recording policy text, else null.\n`,
          },
        ],
        config: { responseMimeType: "application/json" },
      });

      const vText = (vision.text ?? "").trim();
      if (!vText) throw new Error("Gemini returned empty image analysis");
      const vJson = JSON.parse(vText);

      // hard rules
      if (!vJson.proof_ok) {
        return NextResponse.json({ error: "Proof photo does not show monitoring evidence." }, { status: 400 });
      }
      if (!vJson.public_place) {
        return NextResponse.json({ error: "Only public places are allowed." }, { status: 403 });
      }

      signageText = vJson.signage_text || null;

      // add tags automatically
      if (vJson.contains_camera) autoTags.push("camera_visible");
      if (vJson.contains_signage) autoTags.push("signage_present");
    }

    // Merge text tags with vision tags, avoiding duplicates
    const mergedTags = Array.from(new Set([...(aiJson.tags || []), ...autoTags]));

    await pool.query(
      `insert into reports (h3_index, lat, lon, mode, user_text, tags, is_allowed, signage_text)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [h3_index, lat, lon, mode, user_text, JSON.stringify(mergedTags), true, signageText]
    );

    return NextResponse.json({
      ok: true,
      tags: mergedTags,
      summary: aiJson.summary,
      signage_text: signageText,
    });
  } catch (e: any) {
    console.error("POST /api/report failed:", e);
    return NextResponse.json(
      { error: "POST /api/report failed", message: String(e?.message || e) },
      { status: 500 }
    );
  }
}
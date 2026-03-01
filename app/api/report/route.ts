import { NextResponse } from "next/server";
import { z } from "zod";
import { Pool } from "pg";
import { getGemini } from "@/lib/gemini";
import { LRUCache } from "lru-cache";
import { latLngToCell, cellToParent } from "h3-js";

export const runtime = "nodejs";

const CANONICAL_RES = 12;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const getSchema = z.object({
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/),
  res: z.coerce.number().int().optional(),
});

const postSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  claim: z.enum(["camera_present", "camera_absent"]),
  user_text: z.string().min(3).max(500),
  signage_image_base64: z.string().min(50),
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

  publicCache.set(key, true);
  return true;
}



// -------------------------------------

// GET /api/report?bbox=south,west,north,east&res=10
export async function GET(req: Request) {
    const ai = getGemini();
  try {
    const url = new URL(req.url);
    const parsed = getSchema.safeParse({
      bbox: url.searchParams.get("bbox"),
      res: url.searchParams.get("res"),
    });
    if (!parsed.success) return NextResponse.json({ error: "Invalid bbox" }, { status: 400 });

    const [south, west, north, east] = parsed.data.bbox.split(",").map(Number);

    const reqResRaw = parsed.data.res ?? CANONICAL_RES;
    const reqRes = [8, 10, 12].includes(reqResRaw) ? reqResRaw : CANONICAL_RES;

    // IMPORTANT: no max(id) here
    const { rows } = await pool.query(
      `
      select
        h3_index,
        sum(case when claim = 'camera_present' then 1 else 0 end)::int as camera_present_count,
        sum(case when claim = 'camera_absent' then 1 else 0 end)::int as camera_absent_count,
        sum(case when signage_text is not null and signage_text <> '' then 1 else 0 end)::int as signage_count,
        (array_agg(summary order by id desc))[1] as summary,
        (array_agg(signage_text order by id desc))[1] as signage_text
      from reports
      where is_allowed = true
        and lat between $1 and $2
        and lon between $3 and $4
      group by h3_index
      `,
      [south, north, west, east]
    );

    // If they want canonical res, return directly
    if (reqRes === CANONICAL_RES) {
      return NextResponse.json({ cells: rows });
    }

    // Roll up canonical cells into parent res
    const agg = new Map<
      string,
      {
        h3_index: string;
        camera_present_count: number;
        camera_absent_count: number;
        signage_count: number;
        summary?: string;
        signage_text?: string;
        best_weight: number;
      }
    >();

    for (const r of rows as any[]) {
      let parent = r.h3_index as string;
      try {
        parent = cellToParent(r.h3_index, reqRes);
      } catch {}

      const yes = Number(r.camera_present_count) || 0;
      const no = Number(r.camera_absent_count) || 0;
      const sig = Number(r.signage_count) || 0;

      // weight used only to pick which summary/signage_text to keep
      const weight = yes + no + sig;

      const prev = agg.get(parent);
      if (!prev) {
        agg.set(parent, {
          h3_index: parent,
          camera_present_count: yes,
          camera_absent_count: no,
          signage_count: sig,
          summary: r.summary ?? undefined,
          signage_text: r.signage_text ?? undefined,
          best_weight: weight,
        });
      } else {
        prev.camera_present_count += yes;
        prev.camera_absent_count += no;
        prev.signage_count += sig;

        // Keep a "better" summary: prefer the child with more evidence
        if (weight > prev.best_weight) {
          prev.best_weight = weight;
          if (r.summary) prev.summary = r.summary;
          if (r.signage_text) prev.signage_text = r.signage_text;
        } else {
          // Fill blanks if we have none yet
          if (!prev.summary && r.summary) prev.summary = r.summary;
          if (!prev.signage_text && r.signage_text) prev.signage_text = r.signage_text;
        }
      }
    }

    const out = [...agg.values()].map(({ best_weight, ...rest }) => rest);
    return NextResponse.json({ cells: out });
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
    const ai = getGemini();
  try {
    const body = await req.json().catch(() => null);
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Bad input" }, { status: 400 });

    const { lat, lon, claim, user_text, signage_image_base64 } = parsed.data;
    const mode: "safety" = "safety";
   
    const base64Part = signage_image_base64.includes(",")
      ? signage_image_base64.split(",", 2)[1]
      : signage_image_base64;

    const approxBytes = Math.floor((base64Part.length * 3) / 4);
    if (approxBytes > 1_500_000) {
      return NextResponse.json({ error: "Image too large. Use a smaller photo." }, { status: 413 });
    }

    const publicOk = await isPublicPlace(lat, lon);
    if (!publicOk) {
      return NextResponse.json(
        { error: "Only public places are allowed. Private property submissions are rejected." },
        { status: 403 }
      );
    }

    const h3_index = latLngToCell(lat, lon, CANONICAL_RES);

    const promptText =
      `You are moderating and structuring a community map report.\n` +
      `Return ONLY valid JSON with this exact shape:\n` +
      `{"is_allowed": boolean, "tags": string[], "summary": string}\n` +
      `Rules:\n` +
      `- Block if it tries to help wrongdoing, evasion, stalking, or targeting people.\n` +
      `- Otherwise allow.\n` +
      `- tags: indoor, outdoor, entrance, signage_present, crowded, quiet.\n\n` +
      `Mode: ${mode}\n` +
      `Claim: ${claim}\n` +
      `Report text: ${user_text}`;

    const moderation = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: promptText,
      config: { responseMimeType: "application/json" },
    });

    const aiText = (moderation.text ?? "").trim();
    if (!aiText) throw new Error("Gemini returned empty response");
    const aiJson = JSON.parse(aiText);

    if (!aiJson.is_allowed) {
      return NextResponse.json({ error: "Report not allowed" }, { status: 403 });
    }

    let signageText: string | null = null;
    const autoTags: string[] = [];

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
            `Analyze the photo as proof for a community report.\n` +
            `Return ONLY JSON with this exact shape:\n` +
            `{"public_place": boolean, "scene_clear": boolean, "contains_camera": boolean, "contains_signage": boolean, "signage_text": string|null}\n` +
            `Rules:\n` +
            `- public_place true if it looks like a public space.\n` +
            `- scene_clear true if the photo is not too dark/blurry and shows the area context.\n` +
            `- contains_camera true if a camera is visible.\n` +
            `- contains_signage true if CCTV/recording signage is visible.\n` +
            `- signage_text should include readable text if present.\n`,
        },
      ],
      config: { responseMimeType: "application/json" },
    });

    const vText = (vision.text ?? "").trim();
    if (!vText) throw new Error("Gemini returned empty image analysis");
    const vJson = JSON.parse(vText);

    if (!vJson.public_place) {
      return NextResponse.json({ error: "Only public places are allowed." }, { status: 403 });
    }
    if (!vJson.scene_clear) {
      return NextResponse.json({ error: "Photo is too unclear. Retake it with more context." }, { status: 400 });
    }

    if (claim === "camera_present") {
      if (!vJson.contains_camera && !vJson.contains_signage) {
        return NextResponse.json(
          { error: "Safety reports need a photo showing a camera or surveillance signage." },
          { status: 400 }
        );
      }
    } else {
      if (vJson.contains_camera) {
        return NextResponse.json(
          { error: "Privacy reports should show an area with no visible camera in the photo." },
          { status: 400 }
        );
      }
    }

    signageText = vJson.signage_text || null;

    if (vJson.contains_camera) autoTags.push("camera_visible");
    if (vJson.contains_signage) autoTags.push("signage_present");

    const mergedTags = Array.from(new Set([...(aiJson.tags || []), ...autoTags]));

    await pool.query(
      `insert into reports (h3_index, lat, lon, mode, claim, user_text, tags, is_allowed, signage_text, summary, proof_image_base64)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        h3_index,
        lat,
        lon,
        mode,
        claim,
        user_text,
        JSON.stringify(mergedTags),
        true,
        signageText,
        aiJson.summary ?? null,
        signage_image_base64,
      ]
    );

    return NextResponse.json({
      ok: true,
      h3_index,
      claim,
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
import { NextResponse } from "next/server";
import { z } from "zod";
import { Pool } from "pg";
import { getGemini } from "@/lib/gemini";
import { LRUCache } from "lru-cache";
import { latLngToCell, cellToParent } from "h3-js";

import { snowflakeExec } from "@/lib/snowflakeSql";


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

  // still required for your proof flow
  signage_image_base64: z.string().optional().nullable(),

  // NEW: place identity
  place_name: z.string().min(2).max(120),
  place_kind: z.string().min(2).max(40),
  place_id: z.string().max(80).optional().nullable(),
  place_source: z.enum(["places_api", "user"]).default("user"),
  place_address: z.string().max(200).optional().nullable(),

  // NEW: structured details
  details: z.record(z.string(), z.any()).default({}),
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
  (array_agg(signage_text order by id desc))[1] as signage_text,

  (array_agg(place_name order by id desc))[1] as place_name,
  (array_agg(place_kind order by id desc))[1] as place_kind,
  (array_agg(place_id order by id desc))[1] as place_id,
  (array_agg(place_source order by id desc))[1] as place_source,
  (array_agg(place_address order by id desc))[1] as place_address,
  (array_agg(details order by id desc))[1] as details

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

    place_name?: string;
    place_kind?: string;
    place_id?: string;
    place_source?: string;
    place_address?: string;
    details?: any;

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

  place_name: r.place_name ?? undefined,
  place_kind: r.place_kind ?? undefined,
  place_id: r.place_id ?? undefined,
  place_source: r.place_source ?? undefined,
  place_address: r.place_address ?? undefined,
  details: r.details ?? undefined,

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

  if (r.place_name) prev.place_name = r.place_name;
  if (r.place_kind) prev.place_kind = r.place_kind;
  if (r.place_id) prev.place_id = r.place_id;
  if (r.place_source) prev.place_source = r.place_source;
  if (r.place_address) prev.place_address = r.place_address;
  if (r.details) prev.details = r.details;
} else {
  if (!prev.summary && r.summary) prev.summary = r.summary;
  if (!prev.signage_text && r.signage_text) prev.signage_text = r.signage_text;

  if (!prev.place_name && r.place_name) prev.place_name = r.place_name;
  if (!prev.place_kind && r.place_kind) prev.place_kind = r.place_kind;
  if (!prev.place_id && r.place_id) prev.place_id = r.place_id;
  if (!prev.place_source && r.place_source) prev.place_source = r.place_source;
  if (!prev.place_address && r.place_address) prev.place_address = r.place_address;
  if (!prev.details && r.details) prev.details = r.details;
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

    const {
      lat,
      lon,
      claim,
      user_text,
      signage_image_base64,
      place_name,
      place_kind,
      place_id,
      place_source,
      place_address,
      details,
    } = parsed.data;

    const mode = "safety";

    // still keep your public-place location guard
    const publicOk = await isPublicPlace(lat, lon);
    if (!publicOk) {
      return NextResponse.json(
        { error: "Only public places are allowed. Private property submissions are rejected." },
        { status: 403 }
      );
    }

    const h3_index = latLngToCell(lat, lon, CANONICAL_RES);

    // --- Gemini moderation + summary (no photo required) ---
    const promptText =
      `You are moderating and structuring a community map report.\n` +
      `Return ONLY valid JSON with this exact shape:\n` +
      `{"is_allowed": boolean, "tags": string[], "summary": string}\n` +
      `Rules:\n` +
      `- Block if it tries to help wrongdoing, evasion, stalking, or targeting people.\n` +
      `- Otherwise allow.\n` +
      `- tags: indoor, outdoor, entrance, signage_present, crowded, quiet.\n\n` +
      `Place name: ${place_name}\n` +
      `Place type: ${place_kind}\n` +
      `Place source: ${place_source}\n` +
      `Details: ${JSON.stringify(details).slice(0, 500)}\n` +
      `Mode: ${mode}\n` +
      `Claim: ${claim}\n` +
      `Report text: ${user_text}`;

    const moderation = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: promptText,
      config: { responseMimeType: "application/json" },
    });

    const aiText = String(moderation?.text ?? "").trim();
    if (!aiText) throw new Error("Gemini returned empty response");
    let aiJson: any = null;
try {
  const start = aiText.indexOf("{");
  const end = aiText.lastIndexOf("}");
  const slice = start >= 0 && end > start ? aiText.slice(start, end + 1) : aiText;
  aiJson = JSON.parse(slice);
} catch (err) {
  return NextResponse.json(
    { error: "bad_ai_json", preview: aiText.slice(0, 220) },
    { status: 502 }
  );
}

    if (!aiJson.is_allowed) {
      return NextResponse.json({ error: "Report not allowed" }, { status: 403 });
    }

    // --- Optional image analysis (ONLY if provided) ---
    let signageText: string | null = null;
    const autoTags: string[] = [];

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
              `Analyze the photo as optional context for a community report.\n` +
              `Return ONLY JSON with this exact shape:\n` +
              `{"scene_clear": boolean, "contains_camera": boolean, "contains_signage": boolean, "signage_text": string|null}\n`,
          },
        ],
        config: { responseMimeType: "application/json" },
      });

      const vText = String(vision?.text ?? "").trim();
      if (vText) {
        const vJson = JSON.parse(vText);

        if (vJson.contains_camera) autoTags.push("camera_visible");
        if (vJson.contains_signage) autoTags.push("signage_present");
        signageText = vJson.signage_text || null;
      }
    }

    const mergedTags = Array.from(new Set([...(aiJson.tags || []), ...autoTags]));

    // --- Insert into Postgres ---
    const insertRes = await pool.query(
      `insert into reports
        (
          h3_index, lat, lon, mode, claim,
          place_name, place_kind, place_id, place_source, place_address, details,
          user_text, tags, is_allowed, signage_text, summary, proof_image_base64
        )
       values
        (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17
        )
       returning id, created_at`,
      [
        h3_index,
        lat,
        lon,
        mode,
        claim,

        place_name,
        place_kind,
        place_id ?? null,
        place_source ?? "user",
        place_address ?? null,
        JSON.stringify(details || {}),

        user_text,
        JSON.stringify(mergedTags),
        true,
        signageText,
        aiJson.summary ?? null,
        signage_image_base64 ?? null,
      ]
    );

    const insertedId = insertRes.rows?.[0]?.id ?? null;
    const createdAt = insertRes.rows?.[0]?.created_at ?? null;

    // --- Best-effort Snowflake insert (do not block user) ---
    try {
      await snowflakeExec(
        `insert into CIVICFIX.PUBLIC.REPORT_EVENTS
          (EVENT_ID, CREATED_AT, H3_INDEX, LAT, LON, MODE, TAGS, SUMMARY, SIGNAGE_TEXT)
         select
          ?, ?, ?, ?, ?, ?, parse_json(?), ?, ?`,
        [
          insertedId ? String(insertedId) : null,
          createdAt ? String(createdAt) : null,
          h3_index,
          String(lat),
          String(lon),
          mode,
          JSON.stringify(mergedTags),
          aiJson.summary ?? "",
          signageText ?? "",
        ]
      );
    } catch (e) {
      console.error("Snowflake insert failed:", e);
    }

    return NextResponse.json({
      ok: true,
      h3_index,
      claim,
      place_name,
      place_kind,
      place_id: place_id ?? null,
      tags: mergedTags,
      details,
      summary: aiJson.summary,
      signage_text: signageText,
    });
  } catch (e: any) {
    console.error("POST /api/report failed:", e);
    return NextResponse.json(
  {
    error: "POST /api/report failed",
    message: String(e?.message || e),
    code: (e as any)?.code,
    detail: (e as any)?.detail,
    hint: (e as any)?.hint,
  },
  { status: 500 }
);
  }
}
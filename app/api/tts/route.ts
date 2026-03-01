import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

// keep it short to reduce credits needed
const schema = z.object({
  text: z.string().min(1).max(260),
});

export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey) {
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY in env" }, { status: 500 });
  }
  if (!voiceId) {
    return NextResponse.json({ error: "Missing ELEVENLABS_VOICE_ID in env" }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad input: expected { text: string }" }, { status: 400 });
  }

  const text = parsed.data.text.slice(0, 260);

  let r: Response;
  try {
    r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        // cheaper model for hackathon demos
        model_id: "eleven_turbo_v2",
      }),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Failed to reach ElevenLabs", code: "network_error", detail: String(e?.message || e) },
      { status: 502 }
    );
  }

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    let msg = "ElevenLabs request failed";
    let code = "upstream_error";

    try {
      const j = JSON.parse(errText);

      // ElevenLabs commonly returns quota/rate errors under "detail"
      const detailStatus = j?.detail?.status || j?.detail?.code || j?.status || j?.code;
      if (detailStatus === "quota_exceeded") {
        msg = "ElevenLabs quota exceeded (try shorter text or add credits).";
        code = "quota_exceeded";
        return NextResponse.json({ error: msg, code, upstreamStatus: r.status }, { status: 429 });
      }
    } catch {
      // ignore JSON parse errors
    }

    // If upstream throttled (even if body isn't JSON), bubble as 429
    if (r.status === 429) {
      return NextResponse.json(
        { error: "ElevenLabs rate limit hit. Try again shortly.", code: "rate_limited", upstreamStatus: r.status },
        { status: 429 }
      );
    }

    return NextResponse.json(
      {
        error: msg,
        code,
        upstreamStatus: r.status,
        upstreamBodyPreview: errText.slice(0, 400),
      },
      { status: 502 }
    );
  }

  const audio = await r.arrayBuffer();
  return new NextResponse(audio, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
    },
  });
}
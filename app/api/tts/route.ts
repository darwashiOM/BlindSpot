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

  if (!apiKey) return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY in env" }, { status: 500 });
  if (!voiceId) return NextResponse.json({ error: "Missing ELEVENLABS_VOICE_ID in env" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Bad input: expected { text: string }" }, { status: 400 });

  const text = parsed.data.text.slice(0, 260);

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
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

  if (!r.ok) {
  const errText = await r.text();
  let msg = "ElevenLabs request failed";
  let code = "upstream_error";

  try {
    const j = JSON.parse(errText);
    if (j?.detail?.status === "quota_exceeded") {
      msg = "ElevenLabs quota exceeded (try shorter text or add credits).";
      code = "quota_exceeded";
      return NextResponse.json(
        { error: msg, code, upstreamStatus: r.status },
        { status: 429 }
      );
    }
  } catch {}

  return NextResponse.json(
    { error: msg, code, upstreamStatus: r.status, upstreamBodyPreview: errText.slice(0, 400) },
    { status: 502 }
  );
}

  const audio = await r.arrayBuffer();
  return new NextResponse(audio, { headers: { "content-type": "audio/mpeg" } });
}
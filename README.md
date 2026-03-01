# BlindSpot

**BlindSpot** is a community powered safety map that helps people choose safer meetup spots by combining **community reports** with **map signals**, then ranking nearby places based on evidence, distance, and context (marketplace sale, first date, night walk, general meetup).

---

## Smalltalk Mini Category (LabWare / Smalltalk)

This repo includes a **Smalltalk based analytics generator** used to create demo friendly rollups and sanity check the same metrics we show in the dashboard (heatmaps + trends). This makes it easy for judges to evaluate our analytics logic without needing to run the full web stack.

### Where Smalltalk is used (exact paths)

- `smalltalk/BlindSpotAnalytics.st`  
  Smalltalk script that reads exported report events data and generates:
  - daily trends (yes, no, signage, conflict rate)
  - per H3 cell rollups for heatmaps (day + H3)

- `smalltalk/README.md`  
  How to run the script (Pharo) and what outputs it produces.

- `smalltalk/input/report_events.jsonl`  
  Example input format (one JSON object per line, exported from Snowflake).

- `smalltalk/output/`  
  Output JSON artifacts created by the script:
  - `trends_daily.json`
  - `heatmap_daily_res10.json`

If you are judging Smalltalk usage, start here:
**`smalltalk/README.md`**

---

## Inspiration

Safety advice is usually generic, but real safety is **location specific**. People already try to meet near places like police stations, busy cafes, or malls, but it is hard to know:
- what is actually nearby,
- what the community has seen there (cameras, signage),
- and whether reports conflict.

BlindSpot turns those signals into something actionable in seconds.

---

## What it does

### 1) Community reporting (H3 grid)
Users can click the map and submit a report for the selected area:
- camera present or camera absent
- a short note
- optional place identity (name, kind, source)
- structured context (indoors/outdoors, lighting, crowd, time of day, camera location)

Reports are shown back as a heatmap, with “community confirmed” tiers and conflict highlighting.

### 2) AI recommendations
Users can type a request like:
- “meeting someone from marketplace”
- “going to study”
- “walking at night”

The backend classifies the intent and recommends nearby spots (cafe, mall, police station, etc.) while prioritizing:
1) community evidence (yes/no reports + signage + confidence)
2) distance
3) camera markers density from map data

### 3) Voice mode (hands free)
BlindSpot can read the top recommendations aloud and let the user pick:
- option 1, option 2, repeat, new request, stop

### 4) Analytics dashboard (Snowflake)
Every report is mirrored into Snowflake to support:
- heatmaps by H3 over time
- daily trends (yes/no/signage)
- conflict rate and confirmed cell rollups
- stakeholder friendly dashboard views

---

## How it is built (high level)

### Frontend
- Next.js (App Router) + React + TypeScript
- MapLibre + DeckGL for layers (cells, markers, highlights)
- H3 (h3-js) for stable spatial aggregation

Key UI files:
- Main map UI: `app/page.tsx` (or wherever your home map lives)
- Analytics dashboard UI: `app/dashboard/page.tsx`

### Backend (Next.js API routes)
Key endpoints:
- **Reporting**: `app/api/report/route.ts`  
  Validates submissions, runs moderation + summary, stores in Postgres, mirrors into Snowflake.
- **Recommendations**: `app/api/recommend/route.ts`  
  Intent classification, candidate building, scoring, optional AI rerank.
- **Reviews / nearby evidence**: `app/api/reviews/route.ts`  
  Aggregates nearby report evidence for the selected location.
- **Analytics (Snowflake)**:
  - `app/api/analytics/overview/route.ts`
  - `app/api/analytics/trends/route.ts`
  - `app/api/analytics/heatmap/route.ts`

### Data + AI
- Postgres: live app storage for reports
- Snowflake: analytics warehouse and dashboard views
- Gemini API: moderation + structured summaries
- Overpass API: public place guard
- ElevenLabs: TTS for voice mode (with browser TTS fallback)

---

## Snowflake analytics (what is stored and how it is used)

### Raw events table
- `CIVICFIX.RAW.REPORT_EVENTS`

### Views powering the dashboard
- `CIVICFIX.MART.HEATMAP_DAILY_RES10`
- `CIVICFIX.MART.HEATMAP_HOURLY_RES10`
- `CIVICFIX.MART.TRENDS_DAILY`
- `CIVICFIX.MART.OVERVIEW_LAST_7D`
- `CIVICFIX.MART.LATEST_CONTEXT_RES10`

These views let the UI load fast and keep the dashboard logic simple.

---

## Text to Speech (ElevenLabs)

BlindSpot includes a Text to Speech endpoint used by Voice Mode to read recommendations and summaries out loud.

**Location in repo:**
- `app/api/tts/route.ts`

**What it does:**
- Accepts `{ text }` and returns an `audio/mpeg` response
- Uses ElevenLabs `eleven_turbo_v2` (cheaper for demos)
- Handles quota exceeded and rate limit cases cleanly

---

## Built with
- TypeScript
- Next.js (React, App Router)
- MapLibre + react-map-gl
- DeckGL
- H3 (h3-js)
- PostgreSQL
- Snowflake
- Google Gemini API
- ElevenLabs (TTS)
- Overpass API

---

## Local setup

### 1) Install
```bash
npm install
2) Environment variables

Create .env.local:

NEXT_PUBLIC_MAPTILER_KEY=...

DATABASE_URL=...

GEMINI_API_KEY=...

ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...

SNOWFLAKE_ACCOUNT=...
SNOWFLAKE_USERNAME=...
SNOWFLAKE_ROLE=...
SNOWFLAKE_WAREHOUSE=...
SNOWFLAKE_DATABASE=CIVICFIX
SNOWFLAKE_SCHEMA=RAW
SNOWFLAKE_PRIVATE_KEY_B64=... (base64 of PKCS8 private key pem)
3) Run
npm run dev
Try it out:
  https://coral-app-258o8.ondigitalocean.app/
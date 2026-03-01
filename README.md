# BlindSpot

BlindSpot is a community powered safety map that helps people choose safer meetup spots by combining community reports with map signals, then ranking nearby places based on evidence, distance, and context.

## Smalltalk Mini Category (LabWare)

This repo includes a Smalltalk based analytics generator used to build demo friendly rollups and heatmap JSON from exported Snowflake data. It helps us produce consistent dashboard inputs and sanity check the rollups outside the web app.

### Where Smalltalk is used (files and paths)

- `smalltalk/BlindSpotAnalytics.st`
  - Reads exported report events data and generates:
    - daily trends (yes, no, signage, conflict rate)
    - per H3 cell rollups (heatmap style aggregates)
  - Outputs JSON files you can use for demo, debugging, or offline playback.

- `smalltalk/README.md`
  - Short instructions for running the Smalltalk script and expected outputs.

- Optional helper script:
  - `smalltalk/run.sh`
  - One command wrapper to run the Smalltalk generator (Pharo headless).

If you are judging Smalltalk usage, start here:
`smalltalk/README.md`

---

## What the app does

### 1) Interactive safety map
- Users explore a map (MapLibre + DeckGL).
- The UI visualizes:
  - camera marker density from map data
  - community report heatmap by H3 cells
  - places like cafes, malls, libraries, police stations

### 2) Community reporting
Users can click a map cell and submit:
- camera present or camera absent
- a short note
- place identity (name, kind, source)
- structured details (indoors, lighting, crowd, time of day, camera location)

### 3) AI recommendations
Users type something like:
- "meeting marketplace buyer"
- "going to study"
- "walking at night"

The backend classifies intent and recommends nearby spots, prioritizing:
1) community evidence (yes, signage, conflict penalties)
2) distance
3) camera markers density

### 4) Voice mode
The app can read recommendations aloud and lets the user say:
- option 1, option 2, repeat, new request, stop

### 5) Snowflake analytics dashboard
There is a dashboard UI that loads Snowflake views for:
- heatmaps and confidence tiers
- daily trends and overview metrics
- conflict rate and confirmed cell rollups

---

## Repo structure (high level)

- `app/`
  - Main Next.js app pages and API routes
- `app/api/report/route.ts`
  - Accepts reports, stores in Postgres, mirrors into Snowflake, returns the structured response
- `app/api/recommend/route.ts`
  - Intent classification, candidate generation, scoring, optional AI rerank
- `app/api/reviews/route.ts`
  - Aggregates nearby evidence around a selected point
- `app/api/analytics/*`
  - Reads Snowflake views for heatmap, trends, overview
- `lib/snowflakeSql.ts`
  - Snowflake connection and query helpers (JWT key pair auth)
- `smalltalk/`
  - Smalltalk analytics generator used for rollups and demo artifacts

---

## Built with

- TypeScript
- Next.js (React, App Router)
- MapLibre + react-map-gl
- DeckGL
- H3 (h3-js)
- PostgreSQL
- Snowflake
- Google Gemini API (moderation + summaries)
- ElevenLabs (TTS) with browser fallback
- Overpass API (public place guard)

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

Open:

App: http://localhost:3000

Dashboard: http://localhost:3000/dashboard (if your route is set up there)
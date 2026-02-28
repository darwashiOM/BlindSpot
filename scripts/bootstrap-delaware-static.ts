/* scripts/bootstrap-delaware-static.ts
   Run:  DATABASE_URL=... node --loader ts-node/esm scripts/bootstrap-delaware-static.ts
   If you do not want TS tooling, see the JS version below.
*/

import { Pool } from "pg";

type OSMEl = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type PlaceKind =
  | "police"
  | "mall"
  | "mcd"
  | "park"
  | "cafe"
  | "library"
  | "community_centre";

function classify(tags: Record<string, string> | undefined): PlaceKind | null {
  if (!tags) return null;

  if (tags.amenity === "police") return "police";
  if (tags.shop === "mall") return "mall";

  if (tags.leisure === "park") return "park";
  if (tags.amenity === "cafe") return "cafe";
  if (tags.amenity === "library") return "library";
  if (tags.amenity === "community_centre") return "community_centre";

  // McDonald's
  if (tags["brand:wikidata"] === "Q38076") return "mcd";
  if (tags.brand && tags.brand.toLowerCase().includes("mcdonald")) return "mcd";
  if (tags.name && tags.name.toLowerCase().includes("mcdonald")) return "mcd";
  if (tags.amenity === "fast_food" && tags.name?.toLowerCase().includes("mcdonald")) return "mcd";

  return null;
}

function getLatLon(el: OSMEl) {
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function osmKey(el: OSMEl) {
  return `${el.type}/${el.id}`;
}

function buildOverpassQueryPlaces(bbox: { south: number; west: number; north: number; east: number }) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;

  return `
[out:json][timeout:120];
(
  nwr["amenity"="police"](${b});
  nwr["shop"="mall"](${b});
  nwr["leisure"="park"](${b});
  nwr["amenity"="cafe"](${b});
  nwr["amenity"="library"](${b});
  nwr["amenity"="community_centre"](${b});

  nwr["brand:wikidata"="Q38076"](${b});
  nwr["amenity"="fast_food"]["brand"="McDonald's"](${b});
);
out center tags;
  `.trim();
}

function buildOverpassQueryCameras(bbox: { south: number; west: number; north: number; east: number }) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;

  // Cameras in OSM can be mapped in a few ways.
  // This covers common tags:
  // - man_made=surveillance + surveillance:type=camera
  // - surveillance=camera
  return `
[out:json][timeout:120];
(
  nwr["man_made"="surveillance"](${b});
  nwr["surveillance"="camera"](${b});
  nwr["surveillance:type"="camera"](${b});
);
out center tags;
  `.trim();
}

async function fetchOverpass(query: string, endpoint: string) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 120000);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "user-agent": "BlindSpotHackathon/1.0 (bootstrap)",
      },
      body: query,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Overpass failed ${res.status}: ${text.slice(0, 250)}`);

    const json = JSON.parse(text);
    const elements: OSMEl[] = Array.isArray(json?.elements) ? json.elements : [];
    return elements;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const OVERPASS = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

  // Delaware bounding box (south, west, north, east)
  const bbox = {
    south: 38.451013,
    west: -75.788658,
    north: 39.839007,
    east: -75.048939,
  };

  console.log("Bootstrapping Delaware static cache...");
  console.log("Overpass:", OVERPASS);
  console.log("BBox:", bbox);

  const [placeEls, cameraEls] = await Promise.all([
    fetchOverpass(buildOverpassQueryPlaces(bbox), OVERPASS),
    fetchOverpass(buildOverpassQueryCameras(bbox), OVERPASS),
  ]);

  const places: Array<{
    osm_id: string;
    kind: PlaceKind;
    name?: string;
    lat: number;
    lon: number;
    tags: Record<string, string>;
  }> = [];

  const seenPlace = new Set<string>();
  for (const el of placeEls) {
    const tags = el.tags || {};
    const kind = classify(tags);
    if (!kind) continue;

    const ll = getLatLon(el);
    if (!ll) continue;

    const id = osmKey(el);
    if (seenPlace.has(id)) continue;
    seenPlace.add(id);

    places.push({
      osm_id: id,
      kind,
      name: tags.name,
      lat: ll.lat,
      lon: ll.lon,
      tags,
    });
  }

  const cameras: Array<{
    osm_id: string;
    lat: number;
    lon: number;
    tags: Record<string, string>;
  }> = [];

  const seenCam = new Set<string>();
  for (const el of cameraEls) {
    const ll = getLatLon(el);
    if (!ll) continue;

    const id = osmKey(el);
    if (seenCam.has(id)) continue;
    seenCam.add(id);

    cameras.push({
      osm_id: id,
      lat: ll.lat,
      lon: ll.lon,
      tags: el.tags || {},
    });
  }

  console.log(`Found places: ${places.length}`);
  console.log(`Found cameras: ${cameras.length}`);

  const client = await pool.connect();
  try {
    await client.query("begin");

    // Full refresh for hackathon simplicity
    await client.query("truncate table places_static");
    await client.query("truncate table cameras_static");

    // Insert places in chunks
    const placeChunk = 1000;
    for (let i = 0; i < places.length; i += placeChunk) {
      const chunk = places.slice(i, i + placeChunk);
      const values: any[] = [];
      const rowsSql: string[] = [];

      chunk.forEach((p, idx) => {
        const base = idx * 6;
        rowsSql.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb)`
        );
        values.push(p.osm_id, p.kind, p.name ?? null, p.lat, p.lon, JSON.stringify(p.tags));
      });

      await client.query(
        `
        insert into places_static (osm_id, kind, name, lat, lon, tags)
        values ${rowsSql.join(",")}
        on conflict (osm_id) do update set
          kind = excluded.kind,
          name = excluded.name,
          lat = excluded.lat,
          lon = excluded.lon,
          tags = excluded.tags,
          updated_at = now()
        `,
        values
      );
    }

    // Insert cameras in chunks
    const camChunk = 2000;
    for (let i = 0; i < cameras.length; i += camChunk) {
      const chunk = cameras.slice(i, i + camChunk);
      const values: any[] = [];
      const rowsSql: string[] = [];

      chunk.forEach((c, idx) => {
        const base = idx * 4;
        rowsSql.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`);
        values.push(c.osm_id, c.lat, c.lon, JSON.stringify(c.tags));
      });

      await client.query(
        `
        insert into cameras_static (osm_id, lat, lon, tags)
        values ${rowsSql.join(",")}
        on conflict (osm_id) do update set
          lat = excluded.lat,
          lon = excluded.lon,
          tags = excluded.tags,
          updated_at = now()
        `,
        values
      );
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  console.log("Done. Static Delaware cache is now in Postgres.");
}

main().catch((e) => {
  console.error("bootstrap failed:", e);
  process.exit(1);
});
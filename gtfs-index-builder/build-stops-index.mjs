// build-stops-index.mjs
// Downloads the full Dutch GTFS feed (free, published by OVapi) and produces
// one compact JSON file: every real stop in the Netherlands, with its actual
// name, town, and transport mode. No hardcoded stop lists — this replaces
// the seed list entirely with the real national dataset.
//
// Run via `node build-stops-index.mjs` (GitHub Actions runs this nightly —
// see .github/workflows/build-index.yml). Needs: npm install adm-zip csv-parse

import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import readline from 'readline';

const GTFS_URL = 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip';
const OUT_FILE = './public/stops-nl.json';

// GTFS route_type -> our app's mode strings. NL feeds use both the basic
// GTFS codes (0-7) and the "extended" hundred-series codes some EU feeds use.
function mapRouteType(rt) {
  const n = Number(rt);
  if (n === 0 || (n >= 900 && n < 1000)) return 'tram';
  if (n === 1 || (n >= 400 && n < 500)) return 'metro';
  if (n === 2 || (n >= 100 && n < 200)) return 'train';
  if (n === 4 || (n >= 1000 && n < 1100)) return 'ferry';
  return 'bus'; // default bucket: 3 and 700-series, trolleybus, etc.
}

async function main() {
  console.log('Downloading GTFS-NL feed (this file is large, ~150-250MB)...');
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync('./gtfs-nl.zip', buf);

  console.log('Extracting...');
  const zip = new AdmZip('./gtfs-nl.zip');
  zip.extractAllTo('./gtfs-nl', true);

  console.log('Parsing stops.txt...');
  const stopsRaw = parse(fs.readFileSync('./gtfs-nl/stops.txt'), { columns: true, skip_empty_lines: true });
  const stops = new Map(); // stop_id -> { id, name, town, lat, lon, modes:Set }
  for (const row of stopsRaw) {
    // Dutch GTFS stop_name convention is usually "Town, Stop Name".
    const raw = row.stop_name || '';
    const commaIdx = raw.indexOf(',');
    const town = commaIdx > -1 ? raw.slice(0, commaIdx).trim() : null;
    const name = commaIdx > -1 ? raw.slice(commaIdx + 1).trim() : raw.trim();
    stops.set(row.stop_id, {
      id: row.stop_id,
      name: name || raw,
      town: town || 'Other',
      lat: parseFloat(row.stop_lat),
      lon: parseFloat(row.stop_lon),
      modes: new Set(),
    });
  }

  console.log('Parsing routes.txt and trips.txt for mode lookup...');
  const routesRaw = parse(fs.readFileSync('./gtfs-nl/routes.txt'), { columns: true, skip_empty_lines: true });
  const routeType = new Map(routesRaw.map(r => [r.route_id, r.route_type]));
  const tripsRaw = parse(fs.readFileSync('./gtfs-nl/trips.txt'), { columns: true, skip_empty_lines: true });
  const tripRoute = new Map(tripsRaw.map(t => [t.trip_id, t.route_id]));

  console.log('Streaming stop_times.txt to attach modes to stops (this is the big file)...');
  const rl = readline.createInterface({ input: fs.createReadStream('./gtfs-nl/stop_times.txt'), crlfDelay: Infinity });
  let header = null;
  let tripIdx = -1, stopIdx = -1;
  let lineCount = 0;
  for await (const line of rl) {
    if (!header) {
      header = line.split(',');
      tripIdx = header.indexOf('trip_id');
      stopIdx = header.indexOf('stop_id');
      continue;
    }
    lineCount++;
    if (lineCount % 2000000 === 0) console.log(`  ...${lineCount} stop_times rows processed`);
    const cols = line.split(',');
    const tripId = cols[tripIdx];
    const stopId = cols[stopIdx];
    const routeId = tripRoute.get(tripId);
    if (!routeId) continue;
    const rt = routeType.get(routeId);
    const stop = stops.get(stopId);
    if (stop && rt !== undefined) stop.modes.add(mapRouteType(rt));
  }

  console.log('Writing compact output...');
  const out = [...stops.values()]
    .filter(s => s.modes.size > 0) // drop stops with no known service (e.g. inactive)
    .map(s => ({
      id: s.id,
      name: s.name,
      town: s.town,
      mode: [...s.modes][0], // primary mode for the icon; full set not needed client-side
      lat: s.lat,
      lon: s.lon,
    }));

  fs.mkdirSync('./public', { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Done. Wrote ${out.length} stops to ${OUT_FILE}`);

  // cleanup
  fs.rmSync('./gtfs-nl.zip');
  fs.rmSync('./gtfs-nl', { recursive: true, force: true });
}

main().catch(e => { console.error(e); process.exit(1); });

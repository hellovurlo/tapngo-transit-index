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
    // Real-world GTFS-NL naming is inconsistent: some entries are "Town, Stop Name",
    // others are "Stop Name, [Town] extra description". Bracketed text is the
    // reliable town signal wherever it appears; fall back to the comma-split
    // heuristic only when there's no bracket, and to "no comma at all" for plain
    // station names (e.g. "Almere Buiten") where the name itself IS the place.
    const raw = (row.stop_name || '').trim();
    const bracketMatch = raw.match(/\[([^\]]+)\]/);
    let town, name;
    if (bracketMatch) {
      town = bracketMatch[1].trim();
      name = raw.replace(/\[[^\]]+\]/, '').replace(/^,\s*|,\s*$/g, '').trim() || town;
    } else if (raw.includes(',')) {
      const commaIdx = raw.indexOf(',');
      town = raw.slice(0, commaIdx).trim();
      name = raw.slice(commaIdx + 1).trim();
    } else {
      town = raw; // plain station names double as their own town, e.g. "Almere Buiten"
      name = raw;
    }
    stops.set(row.stop_id, {
      id: row.stop_id,
      name: name || raw,
      town: town || 'Other',
      lat: parseFloat(row.stop_lat),
      lon: parseFloat(row.stop_lon),
      modes: new Set(),
      lines: new Set(),
      stopCode: row.stop_code || null, // operator-facing code, if this feed provides one
    });
  }

  console.log('Parsing routes.txt and trips.txt for mode lookup...');
  const routesRaw = parse(fs.readFileSync('./gtfs-nl/routes.txt'), { columns: true, skip_empty_lines: true });
  const routeType = new Map(routesRaw.map(r => [r.route_id, r.route_type]));
  const routeShortName = new Map(routesRaw.map(r => [r.route_id, r.route_short_name || r.route_long_name || '']));
  const tripsRaw = parse(fs.readFileSync('./gtfs-nl/trips.txt'), { columns: true, skip_empty_lines: true });
  const tripRoute = new Map(tripsRaw.map(t => [t.trip_id, t.route_id]));
  const tripHeadsign = new Map(tripsRaw.map(t => [t.trip_id, t.trip_headsign || '']));

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
    if (stop && rt !== undefined) {
      stop.modes.add(mapRouteType(rt));
      const shortName = routeShortName.get(routeId);
      if (shortName) stop.lines.add(shortName); // real line numbers/names actually serving this stop
    }
  }

  console.log('Writing compact output...');
  const out = [...stops.values()]
    .filter(s => s.modes.size > 0) // drop stops with no known service (e.g. inactive)
    .map(s => ({
      id: s.id,
      name: s.name,
      town: s.town,
      mode: [...s.modes][0], // primary mode for the icon; full set not needed client-side
      lines: [...s.lines].sort().slice(0, 12), // real line numbers serving this stop, for display before a live code exists
      lat: s.lat,
      lon: s.lon,
      stopCode: s.stopCode || null, // operator-facing code, used below to auto-match a live TPC
    }));

  console.log('Attempting automatic OVapi code matching via NDOV CHB PassengerStopAssignment...');
  console.log('(Experimental — this is a first attempt at eliminating manual ovzoeker.nl lookups.');
  console.log(' If the match rate below is low or codes look wrong when spot-checked, this needs');
  console.log(' more work rather than being trusted blindly.)');
  let autoMatched = 0;
  try {
    const listingRes = await fetch('https://data.ndovloket.nl/haltes/');
    const listingHtml = await listingRes.text();
    const fileMatch = listingHtml.match(/href="([^"]*PassengerStopAssignment[^"]*)"/i);
    if (!fileMatch) throw new Error('Could not find PassengerStopAssignment file in haltes/ listing');
    const chbUrl = 'https://data.ndovloket.nl/haltes/' + fileMatch[1];
    console.log('  Downloading', chbUrl);
    const chbRes = await fetch(chbUrl);
    const chbBuf = Buffer.from(await chbRes.arrayBuffer());
    fs.writeFileSync('./chb.xml.gz', chbBuf);
    // Most CHB exports are gzipped XML; decompress if needed.
    const zlib = await import('zlib');
    let chbXml;
    try {
      chbXml = zlib.gunzipSync(chbBuf).toString('utf8');
    } catch {
      chbXml =

// build-stops-index.mjs (v2 — schedule-based architecture)
//
// Downloads the free Dutch GTFS feed and produces TWO kinds of output:
//   1. public/stops-nl.json        — lightweight search index (name, town, mode, lines)
//   2. public/schedules/<id>.json  — one file per stop: every line's real
//      timetable at that stop (departure times + which weekdays they run)
//
// The key shift from v1: "next departure" is computed from the ACTUAL
// SCHEDULE (GTFS stop_times), not from a live per-stop OVapi code. That
// code requirement was the entire source of the "needs code" problem —
// most stops never expose one. The timetable has no such gap: every stop
// in this feed has its real schedule, always. Live delay data becomes an
// optional bonus layer later, never a requirement to see anything at all.

import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import readline from 'readline';

const GTFS_URL = 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip';
const STOPS_OUT = './public/stops-nl.json';
const SCHEDULES_DIR = './public/schedules';

function mapRouteType(rt) {
  const n = Number(rt);
  if (n === 0 || (n >= 900 && n < 1000)) return 'tram';
  if (n === 1 || (n >= 400 && n < 500)) return 'metro';
  if (n === 2 || (n >= 100 && n < 200)) return 'train';
  if (n === 4 || (n >= 1000 && n < 1100)) return 'ferry';
  return 'bus';
}

async function main() {
  console.log('Downloading GTFS-NL feed...');
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  fs.writeFileSync('./gtfs-nl.zip', Buffer.from(await res.arrayBuffer()));

  console.log('Extracting...');
  new AdmZip('./gtfs-nl.zip').extractAllTo('./gtfs-nl', true);

  console.log('Parsing stops.txt...');
  const stopsRaw = parse(fs.readFileSync('./gtfs-nl/stops.txt'), { columns: true, skip_empty_lines: true });
  const stops = new Map();
  for (const row of stopsRaw) {
    const raw = (row.stop_name || '').trim();
    const bracketMatch = raw.match(/\[([^\]]+)\]/);
    let town, name;
    if (bracketMatch) {
      town = bracketMatch[1].trim();
      name = raw.replace(/\[[^\]]+\]/, '').replace(/^,\s*|,\s*$/g, '').trim() || town;
    } else if (raw.includes(',')) {
      const i = raw.indexOf(',');
      town = raw.slice(0, i).trim();
      name = raw.slice(i + 1).trim();
    } else {
      town = raw;
      name = raw;
    }
    stops.set(row.stop_id, {
      id: row.stop_id, name: name || raw, town: town || 'Other',
      lat: parseFloat(row.stop_lat), lon: parseFloat(row.stop_lon),
      modes: new Set(), lines: new Set(),
    });
  }

  console.log('Parsing calendar.txt (which days each service runs)...');
  const dayCols = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const serviceDays = new Map(); // service_id -> [Mon..Sun] booleans
  if (fs.existsSync('./gtfs-nl/calendar.txt')) {
    const calRaw = parse(fs.readFileSync('./gtfs-nl/calendar.txt'), { columns: true, skip_empty_lines: true });
    for (const row of calRaw) {
      serviceDays.set(row.service_id, dayCols.map(c => row[c] === '1'));
    }
  }
  // Known simplification: calendar_dates.txt (holiday additions/removals) is
  // not applied — schedules reflect the normal weekly pattern, not one-off
  // exceptions. Good enough for "what time does my bus usually come"; not
  // exact for public holidays.

  console.log('Parsing routes.txt and trips.txt...');
  const routesRaw = parse(fs.readFileSync('./gtfs-nl/routes.txt'), { columns: true, skip_empty_lines: true });
  const routeType = new Map(routesRaw.map(r => [r.route_id, r.route_type]));
  const routeShortName = new Map(routesRaw.map(r => [r.route_id, r.route_short_name || r.route_long_name || '']));
  const tripsRaw = parse(fs.readFileSync('./gtfs-nl/trips.txt'), { columns: true, skip_empty_lines: true });
  const tripRoute = new Map(tripsRaw.map(t => [t.trip_id, t.route_id]));
  const tripService = new Map(tripsRaw.map(t => [t.trip_id, t.service_id]));
  const tripHeadsign = new Map(tripsRaw.map(t => [t.trip_id, t.trip_headsign || '']));
  const tripDirection = new Map(tripsRaw.map(t => [t.trip_id, t.direction_id]));

  console.log('Streaming stop_times.txt (the big file) — building per-stop timetables...');
  // stopSchedules: stop_id -> Map("route|headsign" -> { route, headsign, mode, times: [{t, days}] })
  const stopSchedules = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream('./gtfs-nl/stop_times.txt'), crlfDelay: Infinity });
  let header = null, tripIdx = -1, stopIdx = -1, depIdx = -1, lineCount = 0;
  for await (const line of rl) {
    if (!header) {
      header = line.split(',');
      tripIdx = header.indexOf('trip_id');
      stopIdx = header.indexOf('stop_id');
      depIdx = header.indexOf('departure_time');
      continue;
    }
    lineCount++;
    if (lineCount % 3000000 === 0) console.log(`  ...${lineCount} rows`);
    const cols = line.split(',');
    const tripId = cols[tripIdx], stopId = cols[stopIdx], depTime = cols[depIdx];
    const routeId = tripRoute.get(tripId);
    const stop = stops.get(stopId);
    if (!routeId || !stop || !depTime) continue;
    const rt = routeType.get(routeId);
    if (rt === undefined) continue;
    const mode = mapRouteType(rt);
    const shortName = routeShortName.get(routeId) || '?';
    stop.modes.add(mode);
    stop.lines.add(shortName);

    const headsign = tripHeadsign.get(tripId) || '';
    const directionId = tripDirection.get(tripId);
    const days = serviceDays.get(tripService.get(tripId)) || [true,true,true,true,true,true,true];

    if (!stopSchedules.has(stopId)) stopSchedules.set(stopId, new Map());
    const perStop = stopSchedules.get(stopId);
    // Group by GTFS direction_id (a stable 0/1 flag), not by headsign text —
    // operators are inconsistent with headsign wording across trips/snapshots,
    // which fragments what should be one direction into several. Fall back to
    // headsign grouping only if this feed doesn't provide direction_id at all.
    const key = (directionId === '0' || directionId === '1')
      ? `${shortName}|dir${directionId}`
      : `${shortName}|${headsign}`;
    if (!perStop.has(key)) perStop.set(key, { route: shortName, headsignCounts: new Map(), mode, times: [] });
    const group = perStop.get(key);
    group.headsignCounts.set(headsign, (group.headsignCounts.get(headsign) || 0) + 1);
    group.times.push({ t: depTime.slice(0,5), days });
  }

  console.log('Writing search index (stops-nl.json)...');
  const stopsOut = [...stops.values()]
    .filter(s => s.modes.size > 0)
    .map(s => ({
      id: s.id, name: s.name, town: s.town,
      mode: [...s.modes][0], lines: [...s.lines].sort().slice(0, 12),
      lat: s.lat, lon: s.lon,
    }));
  fs.mkdirSync('./public', { recursive: true });
  fs.writeFileSync(STOPS_OUT, JSON.stringify(stopsOut));
  console.log(`  Wrote ${stopsOut.length} stops.`);

  console.log('Writing per-stop timetables (public/schedules/*.json)...');
  fs.mkdirSync(SCHEDULES_DIR, { recursive: true });
  let scheduleFileCount = 0;
  for (const [stopId, perStop] of stopSchedules.entries()) {
    const lines = [...perStop.values()].map(l => {
      // Pick the most common headsign in this direction group as the label —
      // resilient to occasional inconsistent wording on individual trips.
      let bestHeadsign = '', bestCount = -1;
      for (const [hs, count] of l.headsignCounts.entries()) {
        if (count > bestCount) { bestHeadsign = hs; bestCount = count; }
      }
      return {
        route: l.route, headsign: bestHeadsign, mode: l.mode,
        times: l.times.sort((a,b) => a.t.localeCompare(b.t)),
      };
    });
    fs.writeFileSync(`${SCHEDULES_DIR}/${stopId}.json`, JSON.stringify(lines));
    scheduleFileCount++;
  }
  console.log(`  Wrote ${scheduleFileCount} schedule files.`);
  console.log('Done. Every stop now has a real timetable — no live code required to see next departures.');

  fs.rmSync('./gtfs-nl.zip');
  fs.rmSync('./gtfs-nl', { recursive: true, force: true });
}

main().catch(e => { console.error(e); process.exit(1); });

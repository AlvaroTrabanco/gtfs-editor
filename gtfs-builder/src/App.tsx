import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { v4 as uuidv4 } from "uuid";

/** ---------- Types ---------- */
type Stop = { uid: string; stop_id: string; stop_name: string; stop_lat: number; stop_lon: number; };
type Agency = { agency_id: string; agency_name: string; agency_url: string; agency_timezone: string };
type RouteRow = { route_id: string; route_short_name: string; route_long_name: string; route_type: number; agency_id: string };
type Service = {
  service_id: string;
  monday: number; tuesday: number; wednesday: number; thursday: number; friday: number; saturday: number; sunday: number;
  start_date: string; end_date: string;
};
type Trip = { route_id: string; service_id: string; trip_id: string; trip_headsign?: string; shape_id?: string };
type StopTime = { trip_id: string; arrival_time: string; departure_time: string; stop_id: string; stop_sequence: number };
type ShapePt = { shape_id: string; lat: number; lon: number; seq: number };
type Issue = { level: "error" | "warning"; file: string; row?: number; message: string };
type Banner = { kind: "success" | "error" | "info"; text: string } | null;

type FeedState = {
  agencies: Agency[];
  stops: Stop[];
  routes: RouteRow[];
  services: Service[];
  trips: Trip[];
  stopTimes: StopTime[];
  shapePts: ShapePt[];
};

/** ---------- Helpers ---------- */
function toYYYYMMDD(d: string | Date) {
  const date = typeof d === "string" ? new Date(d) : d;
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${y}${m}${day}`;
}
function csvify<T extends Record<string, any>>(rows: T[], headerOrder?: string[]) {
  if (!rows || rows.length === 0) return "";
  const headers = headerOrder ?? Object.keys(rows[0]);
  const escape = (v: any) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes("\n") || s.includes("\"")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => escape(r[h])).join(","));
  return lines.join("\n") + "\n";
}
function timeToSecs(t: string) {
  const [h, m, s] = t.split(":").map(Number);
  if ([h, m, s].some(Number.isNaN)) return NaN;
  return h * 3600 + m * 60 + s;
}

/** ---------- Validation ---------- */
function validateFeed(ctx: FeedState): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const required = [
    ["agency.txt", ctx.agencies.length],
    ["stops.txt", ctx.stops.length],
    ["routes.txt", ctx.routes.length],
    ["trips.txt", ctx.trips.length],
    ["stop_times.txt", ctx.stopTimes.length],
    ["calendar.txt", ctx.services.length],
  ];
  for (const [name, count] of required) if (!count) errors.push({ level: "error", file: name, message: "File is required but empty." });

  const dupCheck = <T, K extends keyof T>(rows: T[], key: K, file: string) => {
    const seen = new Set<any>();
    rows.forEach((r, i) => {
      const k = (r as any)[key];
      if (seen.has(k)) errors.push({ level: "error", file, row: i + 1, message: `Duplicate ${String(key)}: ${k}` });
      seen.add(k);
    });
  };
  dupCheck(ctx.stops, "stop_id", "stops.txt");
  dupCheck(ctx.routes, "route_id", "routes.txt");
  dupCheck(ctx.trips, "trip_id", "trips.txt");
  dupCheck(ctx.services, "service_id", "calendar.txt");

  const routeIds = new Set(ctx.routes.map(r => r.route_id));
  const serviceIds = new Set(ctx.services.map(s => s.service_id));
  const stopIds = new Set(ctx.stops.map(s => s.stop_id));
  const shapeIds = new Set(ctx.shapePts.map(p => p.shape_id));

  ctx.trips.forEach((t, i) => {
    if (!routeIds.has(t.route_id)) errors.push({ level: "error", file: "trips.txt", row: i + 1, message: `Unknown route_id ${t.route_id}` });
    if (!serviceIds.has(t.service_id)) errors.push({ level: "error", file: "trips.txt", row: i + 1, message: `Unknown service_id ${t.service_id}` });
    if (t.shape_id && !shapeIds.has(t.shape_id)) warnings.push({ level: "warning", file: "trips.txt", row: i + 1, message: `shape_id ${t.shape_id} set but no matching shapes` });
  });

  ctx.stopTimes.forEach((st, i) => {
    if (!stopIds.has(st.stop_id)) errors.push({ level: "error", file: "stop_times.txt", row: i + 1, message: `Unknown stop_id ${st.stop_id}` });
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(st.arrival_time) || !/^\d{1,2}:\d{2}:\d{2}$/.test(st.departure_time)) {
      errors.push({ level: "error", file: "stop_times.txt", row: i + 1, message: `Bad time format (HH:MM:SS)` });
    }
  });

  const byTrip = new Map<string, StopTime[]>();
  for (const st of ctx.stopTimes) {
    const a = byTrip.get(st.trip_id) || [];
    a.push(st);
    byTrip.set(st.trip_id, a);
  }
  for (const [tripId, list] of byTrip) {
    const sorted = [...list].sort((a, b) => a.stop_sequence - b.stop_sequence);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      const prevDep = timeToSecs(prev.departure_time);
      const curArr = timeToSecs(cur.arrival_time);
      if (!Number.isNaN(prevDep) && !Number.isNaN(curArr) && curArr < prevDep) {
        warnings.push({ level: "warning", file: "stop_times.txt", message: `Trip ${tripId}: arrival earlier than previous departure at seq ${cur.stop_sequence}` });
      }
    }
  }

  const ptsByShape = new Map<string, ShapePt[]>();
  for (const p of ctx.shapePts) {
    const a = ptsByShape.get(p.shape_id) || [];
    a.push(p);
    ptsByShape.set(p.shape_id, a);
  }
  for (const [sid, pts] of ptsByShape) {
    const seqs = pts.map(p => p.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 0; i < seqs.length; i++) {
      if (seqs[i] !== sorted[i]) {
        warnings.push({ level: "warning", file: "shapes.txt", message: `shape_id ${sid}: non-sequential shape_pt_sequence` });
        break;
      }
    }
  }

  return { errors, warnings };
}

/** ---------- Zip export ---------- */
async function exportGTFSZip(payload: FeedState) {
  const zip = new JSZip();
  zip.file("agency.txt", csvify(payload.agencies, ["agency_id", "agency_name", "agency_url", "agency_timezone"]));
  zip.file("stops.txt", csvify(payload.stops.map(({ uid, ...s }) => s), ["stop_id", "stop_name", "stop_lat", "stop_lon"]));
  zip.file("routes.txt", csvify(payload.routes, ["route_id", "route_short_name", "route_long_name", "route_type", "agency_id"]));
  const anyShape = payload.trips.some(t => t.shape_id);
  const tripHeaders = anyShape ? ["route_id","service_id","trip_id","trip_headsign","shape_id"] : ["route_id","service_id","trip_id","trip_headsign"];
  zip.file("trips.txt", csvify(payload.trips, tripHeaders));
  zip.file("stop_times.txt", csvify(payload.stopTimes, ["trip_id","arrival_time","departure_time","stop_id","stop_sequence"]));
  zip.file("calendar.txt", csvify(payload.services, ["service_id","monday","tuesday","wednesday","thursday","friday","saturday","sunday","start_date","end_date"]));
  if (payload.shapePts.length) {
    const rows = payload.shapePts.map(p => ({ shape_id: p.shape_id, shape_pt_lat: p.lat, shape_pt_lon: p.lon, shape_pt_sequence: p.seq }));
    zip.file("shapes.txt", csvify(rows, ["shape_id","shape_pt_lat","shape_pt_lon","shape_pt_sequence"]));
  }
  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, "gtfs.zip");
}

/** ---------- Map helpers ---------- */
function AddStopOnClick({ onAdd }: { onAdd: (lat: number, lon: number) => void }) {
  // Only fires when map itself is clicked (not markers)
  useMapEvents({ click(e) { onAdd(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)); } });
  return null;
}
function DrawShapeOnClick({ onPoint }: { onPoint: (lat: number, lon: number) => void }) {
  useMapEvents({ click(e) { onPoint(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)); } });
  return null;
}
// Force Leaflet to recalc size
function InvalidateSizeOnLoad() {
  const map = useMap();
  useEffect(() => {
    const kick = () => map.invalidateSize({ animate: false });
    const t = setTimeout(kick, 100);
    window.addEventListener("resize", kick);
    return () => { clearTimeout(t); window.removeEventListener("resize", kick); };
  }, [map]);
  return null;
}

/** ---------- App ---------- */
export default function App() {
  // Data
  const [agencies, setAgencies] = useState<Agency[]>([{
    agency_id: "agency_1",
    agency_name: "My Agency",
    agency_url: "https://example.com",
    agency_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Madrid",
  }]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [services, setServices] = useState<Service[]>([{
    service_id: "WKDY",
    monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
    start_date: toYYYYMMDD(new Date()),
    end_date: toYYYYMMDD(new Date(new Date().setFullYear(new Date().getFullYear() + 1))),
  }]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [stopTimes, setStopTimes] = useState<StopTime[]>([]);
  const [shapePts, setShapePts] = useState<ShapePt[]>([]);

  // UI
  const [selectedRoute, setSelectedRoute] = useState<string>("");
  const [selectedService, setSelectedService] = useState<string>("WKDY");
  const [selectedTrip, setSelectedTrip] = useState<string>("");
  const [nextStopName, setNextStopName] = useState<string>("");

  // Shapes UI
  const [activeShape, setActiveShape] = useState<string | null>(null);
  const [newShapeId, setNewShapeId] = useState<string>("");
  const [drawMode, setDrawMode] = useState<boolean>(false);

  // Stop selection (highlight in table when marker clicked)
  const [selectedStopUid, setSelectedStopUid] = useState<string | null>(null);

  // Validation & banner
  const [validation, setValidation] = useState<{ errors: Issue[]; warnings: Issue[] }>({ errors: [], warnings: [] });
  const [banner, setBanner] = useState<Banner>(null);

  // ---- Leaflet markers fix ----
  useEffect(() => {
    // @ts-ignore
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    });
  }, []);

  // -------- Persistence (localStorage) --------
  const STORAGE_KEY = "gtfs_builder_state_v1";
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        const loadedStops: Stop[] = (obj.stops || []).map((s: any) => ({
          uid: s.uid || uuidv4(),
          stop_id: s.stop_id,
          stop_name: s.stop_name,
          stop_lat: s.stop_lat,
          stop_lon: s.stop_lon,
        }));
        setAgencies(obj.agencies ?? []);
        setStops(loadedStops);
        setRoutes(obj.routes ?? []);
        setServices(obj.services ?? []);
        setTrips(obj.trips ?? []);
        setStopTimes(obj.stopTimes ?? []);
        setShapePts(obj.shapePts ?? []);
      }
    } catch { /* ignore */ }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save whenever data changes (but only after hydration)
  useEffect(() => {
    if (!hydrated) return;
    const snapshot: FeedState = { agencies, stops, routes, services, trips, stopTimes, shapePts };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* ignore */ }
  }, [hydrated, agencies, stops, routes, services, trips, stopTimes, shapePts]);

  // -------- Undo history (Ctrl/Cmd+Z) --------
  const historyRef = useRef<FeedState[]>([]);
  const historyLimit = 50;
  const lastHashRef = useRef<string>("");

  // Push to history on meaningful changes
  useEffect(() => {
    if (!hydrated) return;
    const snapshot: FeedState = { agencies, stops, routes, services, trips, stopTimes, shapePts };
    const hash = JSON.stringify(snapshot);
    if (hash !== lastHashRef.current) {
      historyRef.current.push(snapshot);
      if (historyRef.current.length > historyLimit) historyRef.current.shift();
      lastHashRef.current = hash;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencies, stops, routes, services, trips, stopTimes, shapePts, hydrated]);

  const undoOne = () => {
    // Need at least 2 states to go back (current + previous)
    if (historyRef.current.length < 2) return;
    // Drop current
    historyRef.current.pop();
    const prev = historyRef.current[historyRef.current.length - 1];
    // Apply previous snapshot
    setAgencies(prev.agencies);
    setStops(prev.stops);
    setRoutes(prev.routes);
    setServices(prev.services);
    setTrips(prev.trips);
    setStopTimes(prev.stopTimes);
    setShapePts(prev.shapePts);
    // update hash
    lastHashRef.current = JSON.stringify(prev);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoOne();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Helpers
  function timeAddMinutes(hhmmss: string, minutes: number) {
    const [h, m, s] = hhmmss.split(":").map(Number);
    const total = h * 60 + m + minutes;
    const nh = Math.floor(total / 60);
    const nm = total % 60;
    return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}:${String(isNaN(s) ? 0 : s).padStart(2, '0')}`;
  }

  // Derived shapes index (sorted)
  const shapesIndex = useMemo(() => {
    const m = new Map<string, ShapePt[]>();
    for (const p of shapePts) {
      const a = m.get(p.shape_id) || [];
      a.push(p);
      m.set(p.shape_id, a);
    }
    for (const [k, arr] of m) { arr.sort((a, b) => a.seq - b.seq); m.set(k, arr); }
    return m;
  }, [shapePts]);

  // Actions
  const addStopFromMap = (lat: number, lon: number) => {
    // Only add when NOT drawing
    if (drawMode) return;
    const id = `S_${(stops.length + 1).toString().padStart(3, "0")}`;
    const newStop = { uid: uuidv4(), stop_id: id, stop_name: nextStopName || id, stop_lat: lat, stop_lon: lon };
    setStops(prev => [...prev, newStop]);
    setNextStopName("");
    setSelectedStopUid(newStop.uid);
  };
  const moveStop = (uid: string, lat: number, lon: number) => {
    setStops(prev => prev.map(s => s.uid === uid ? { ...s, stop_lat: lat, stop_lon: lon } : s));
  };

  const addRoute = () => {
    const id = `R_${(routes.length + 1).toString().padStart(3, "0")}`;
    setRoutes(r => [...r, { route_id: id, route_short_name: `${routes.length + 1}`, route_long_name: `Route ${routes.length + 1}`, route_type: 3, agency_id: agencies[0].agency_id }]);
    setSelectedRoute(id);
  };
  const addTrip = () => {
    if (!selectedRoute) return;
    const id = `T_${uuidv4().slice(0, 8)}`;
    setTrips(t => [...t, { route_id: selectedRoute, service_id: selectedService, trip_id: id }]);
    setSelectedTrip(id);
  };
  const deleteTrip = (trip_id: string) => {
    setTrips(t => t.filter(x => x.trip_id !== trip_id));
    setStopTimes(st => st.filter(x => x.trip_id !== trip_id));
    if (selectedTrip === trip_id) setSelectedTrip("");
  };

  const addStopTime = (trip_id: string, stop_id: string) => {
    if (!stop_id) return;
    const seq = Math.max(0, ...stopTimes.filter(s => s.trip_id === trip_id).map(s => s.stop_sequence)) + 1;
    const last = stopTimes.filter(s => s.trip_id === trip_id).sort((a, b) => a.stop_sequence - b.stop_sequence).slice(-1)[0];
    const base = last ? last.departure_time : "08:00:00";
    const next = timeAddMinutes(base, 5);
    setStopTimes(st => [...st, { trip_id, stop_id, arrival_time: base, departure_time: next, stop_sequence: seq }]);
  };
  const setStopTimeField = (trip_id: string, seq: number, field: keyof StopTime, value: string) => {
    setStopTimes(st => st.map(row => row.trip_id === trip_id && row.stop_sequence === seq ? { ...row, [field]: value } : row));
  };
  const removeStopTime = (trip_id: string, seq: number) => {
    setStopTimes(st => st
      .filter(row => !(row.trip_id === trip_id && row.stop_sequence === seq))
      .map(row => (row.trip_id === trip_id && row.stop_sequence > seq) ? { ...row, stop_sequence: row.stop_sequence - 1 } : row)
    );
  };

  // Shapes
  const createShape = () => {
    const id = newShapeId.trim() || `shape_${(shapesIndex.size + 1).toString().padStart(2, "0")}`;
    setActiveShape(id);
    setNewShapeId("");
  };
  const addShapePoint = (lat: number, lon: number) => {
    if (!activeShape || !drawMode) return;
    const nextSeq = (shapesIndex.get(activeShape)?.length || 0) + 1;
    setShapePts(prev => [...prev, { shape_id: activeShape, lat, lon, seq: nextSeq }]);
  };
  const clearActiveShape = () => {
    if (!activeShape) return;
    setShapePts(prev => prev.filter(p => p.shape_id !== activeShape));
  };

  // Project I/O
  const exportProject = () => {
    const blob = new Blob([JSON.stringify({ agencies, stops, routes, services, trips, stopTimes, shapePts }, null, 2)], { type: "application/json" });
    saveAs(blob, "gtfs_builder_project.json");
  };
  const importProject = async (file: File) => {
    const text = await file.text();
    const obj = JSON.parse(text);
    const loadedStops: Stop[] = (obj.stops || []).map((s: any) => ({
      uid: s.uid || uuidv4(),
      stop_id: s.stop_id, stop_name: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon
    }));
    setAgencies(obj.agencies || []);
    setStops(loadedStops);
    setRoutes(obj.routes || []);
    setServices(obj.services || []);
    setTrips(obj.trips || []);
    setStopTimes(obj.stopTimes || []);
    setShapePts(obj.shapePts || []);
  };

  const runValidation = () => {
    const res = validateFeed({ agencies, stops, routes, services, trips, stopTimes, shapePts });
    setValidation(res);
    if (res.errors.length === 0) {
      setBanner({ kind: "success", text: `Validation successful: ${res.errors.length} errors, ${res.warnings.length} warnings.` });
    } else {
      setBanner({ kind: "error", text: `Validation found ${res.errors.length} errors and ${res.warnings.length} warnings.` });
    }
    setTimeout(() => setBanner(null), 3500);
    return res;
  };

  const onExport = async () => {
    const { errors } = runValidation();
    if (errors.length) {
      alert("Fix validation errors before exporting (see Validation panel).");
      return;
    }
    await exportGTFSZip({ agencies, stops, routes, services, trips, stopTimes, shapePts });
  };

  const resetAll = () => {
    if (!confirm("Reset project? This will clear all data (and local cache).")) return;
    const empty: FeedState = {
      agencies: [{
        agency_id: "agency_1",
        agency_name: "My Agency",
        agency_url: "https://example.com",
        agency_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Madrid",
      }],
      stops: [],
      routes: [],
      services: [{
        service_id: "WKDY",
        monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
        start_date: toYYYYMMDD(new Date()),
        end_date: toYYYYMMDD(new Date(new Date().setFullYear(new Date().getFullYear() + 1))),
      }],
      trips: [],
      stopTimes: [],
      shapePts: []
    };
    setAgencies(empty.agencies);
    setStops(empty.stops);
    setRoutes(empty.routes);
    setServices(empty.services);
    setTrips(empty.trips);
    setStopTimes(empty.stopTimes);
    setShapePts(empty.shapePts);
    setSelectedStopUid(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    historyRef.current = [empty]; // reset history
    lastHashRef.current = JSON.stringify(empty);
    setBanner({ kind: "info", text: "Project reset." });
    setTimeout(() => setBanner(null), 2000);
  };

  /** ---------- UI ---------- */
  return (
    <div className="app">
      {/* LEFT COLUMN */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <h1 className="h1">GTFS Builder <span className="pill">Validation + Shapes</span></h1>

        {/* Controls */}
        <div className="toolbar">
          <div className="field" style={{ minWidth: 220 }}>
            <label className="muted">Next stop name</label>
            <input className="input" value={nextStopName} onChange={e => setNextStopName(e.target.value)} placeholder="optional" />
          </div>

          <button className="btn" onClick={exportProject}>Export project JSON</button>

          <label className="file-btn">
            Import project JSON
            <input type="file" accept="application/json" style={{ display: "none" }}
                   onChange={e => { const f = e.target.files?.[0]; if (f) importProject(f); }} />
          </label>

          <button className="btn btn-primary" onClick={onExport}>Export GTFS .zip</button>
        </div>

        {/* Map card */}
        <div className="card section">
          <div className="card-body">
            <div className={`map-shell ${drawMode ? "is-drawing" : ""}`} style={{ height: 520, minHeight: 520, width: "100%", borderRadius: 12, overflow: "hidden" }}>
              <MapContainer center={[40.4168, -3.7038]} zoom={6} style={{ height: "100%", width: "100%" }}>
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap contributors" />
                {!drawMode && <AddStopOnClick onAdd={addStopFromMap} />}
                {drawMode && <DrawShapeOnClick onPoint={addShapePoint} />}
                <InvalidateSizeOnLoad />

                {stops.map(s => (
                  <Marker
                    key={s.uid}
                    position={[s.stop_lat, s.stop_lon]}
                    draggable
                    eventHandlers={{
                      click: () => setSelectedStopUid(s.uid), // highlight in table
                      dragend: (e) => {
                        const m = e.target as L.Marker<any>;
                        const pos = m.getLatLng();
                        moveStop(s.uid, +pos.lat.toFixed(6), +pos.lng.toFixed(6));
                      }
                    }}
                  />
                ))}
                {[...shapesIndex.entries()].map(([sid, pts]) => (
                  <Polyline key={sid} positions={pts.map(p => [p.lat, p.lon]) as [number, number][]} />
                ))}
              </MapContainer>
            </div>
          </div>
        </div>

        {/* Shapes */}
        <div className="card section">
          <div className="card-body">
            <h3 className="card-title">Shapes / Patterns</h3>
            <div className="row">
              <input className="input" placeholder="new shape_id (optional)" value={newShapeId} onChange={e => setNewShapeId(e.target.value)} style={{ minWidth: 240 }} />
              <button className="btn" onClick={createShape}>Create / Select</button>

              <div className="field" style={{ minWidth: 180 }}>
                <label className="muted">Active</label>
                <select className="select" value={activeShape ?? ""} onChange={e => setActiveShape(e.target.value || null)}>
                  <option value="">(none)</option>
                  {[...shapesIndex.keys()].map(sid => <option key={sid} value={sid}>{sid}</option>)}
                </select>
              </div>

              {/* Draw mode toggle */}
              <label className="row" style={{ gap: 8, padding: "6px 10px", borderRadius: 10, border: "1px solid var(--border)", background: drawMode ? "#eff6ff" : "transparent", boxShadow: drawMode ? "0 0 0 3px var(--ring)" : "none" }}>
                <input
                  type="checkbox"
                  checked={drawMode}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setDrawMode(on);
                    if (on && !activeShape) {
                      const autoId = `shape_${(shapesIndex.size + 1).toString().padStart(2, "0")}`;
                      setActiveShape(autoId);
                      setBanner({ kind: "info", text: `Draw mode on — created & selected "${autoId}". Click the map to add points.` });
                      setTimeout(() => setBanner(null), 3000);
                    }
                  }}
                />
                <span><strong>Draw mode</strong></span>
              </label>

              <button className="btn" onClick={clearActiveShape} disabled={!activeShape}>Clear active shape</button>
              {activeShape && <div className="muted">Points: {shapesIndex.get(activeShape)?.length || 0}</div>}
            </div>
          </div>
        </div>

        {/* Stops (disabled while drawing), plus Delete Selected */}
        <div className="card section" style={{ opacity: drawMode ? 0.55 : 1 }}>
          <div className="card-body">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 className="card-title">Stops</h3>
              <button
                className="btn"
                disabled={!selectedStopUid || drawMode}
                onClick={() => {
                  if (!selectedStopUid) return;
                  setStops(p => p.filter(s => s.uid !== selectedStopUid));
                  setSelectedStopUid(null);
                }}
              >
                Delete selected stop
              </button>
            </div>

            {drawMode && (
              <div style={{ borderRadius: 8, padding: "8px 10px", marginBottom: 8, background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", fontSize: 13 }}>
                Draw mode is active. Click the map to add <b>shape points</b>. To edit stops again, turn <b>Draw mode</b> off.
              </div>
            )}

            <table className="table">
              <thead><tr><th>ID</th><th>Name</th><th>Lat</th><th>Lon</th><th></th></tr></thead>
              <tbody>
                {stops.map((s, idx) => (
                  <tr
                    key={s.uid}
                    style={{
                      background: selectedStopUid === s.uid ? "#eef2ff" : "transparent",
                      outline: selectedStopUid === s.uid ? "2px solid #93c5fd" : "none",
                      outlineOffset: -2
                    }}
                    onClick={() => setSelectedStopUid(s.uid)}
                  >
                    <td>
                      <input className="input" value={s.stop_id} disabled={drawMode}
                             onChange={e => setStops(p => p.map((x,i)=>i===idx?{...x, stop_id:e.target.value}:x))} />
                    </td>
                    <td>
                      <input className="input" value={s.stop_name} disabled={drawMode}
                             onChange={e => setStops(p => p.map((x,i)=>i===idx?{...x, stop_name:e.target.value}:x))} />
                    </td>
                    <td>
                      <input className="input" type="number" step="0.000001" value={s.stop_lat} disabled={drawMode}
                             onChange={e => setStops(p => p.map((x,i)=>i===idx?{...x, stop_lat:Number(e.target.value)}:x))} />
                    </td>
                    <td>
                      <input className="input" type="number" step="0.000001" value={s.stop_lon} disabled={drawMode}
                             onChange={e => setStops(p => p.map((x,i)=>i===idx?{...x, stop_lon:Number(e.target.value)}:x))} />
                    </td>
                    <td>
                      <button className="btn" disabled={drawMode}
                              onClick={(ev) => { ev.stopPropagation(); setStops(p => p.filter((_,i)=>i!==idx)); if (selectedStopUid === s.uid) setSelectedStopUid(null); }}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

          </div>
        </div>

        {/* Routes & Service */}
        <div className="section" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="card">
            <div className="card-body">
              <h3 className="card-title">Routes</h3>
              <button className="btn" onClick={addRoute}>+ Add route</button>
              <table className="table" style={{ marginTop: 8 }}>
                <thead><tr><th>ID</th><th>Short</th><th>Long</th><th>Type</th><th>Agency</th></tr></thead>
                <tbody>
                  {routes.map((r, idx) => (
                    <tr key={r.route_id} style={{ background: selectedRoute===r.route_id ? "#f8fafc" : "transparent" }}
                        onClick={() => setSelectedRoute(r.route_id)}>
                      <td><input className="input" value={r.route_id} onChange={e => setRoutes(p=>p.map((x,i)=>i===idx?{...x, route_id:e.target.value}:x))} /></td>
                      <td><input className="input" value={r.route_short_name} onChange={e => setRoutes(p=>p.map((x,i)=>i===idx?{...x, route_short_name:e.target.value}:x))} /></td>
                      <td><input className="input" value={r.route_long_name} onChange={e => setRoutes(p=>p.map((x,i)=>i===idx?{...x, route_long_name:e.target.value}:x))} /></td>
                      <td><input className="input" type="number" value={r.route_type} onChange={e => setRoutes(p=>p.map((x,i)=>i===idx?{...x, route_type:Number(e.target.value)}:x))} /></td>
                      <td><input className="input" value={r.agency_id} onChange={e => setRoutes(p=>p.map((x,i)=>i===idx?{...x, agency_id:e.target.value}:x))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-body">
              <h3 className="card-title">Service calendar</h3>
              <button className="btn" onClick={() => setServices(s => [...s, {
                service_id: `SVC_${s.length + 1}`, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
                start_date: toYYYYMMDD(new Date()), end_date: toYYYYMMDD(new Date(new Date().setFullYear(new Date().getFullYear() + 1)))
              }])}>+ Add service</button>

              <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
                {services.map((svc, idx) => (
                  <div key={svc.service_id} className="card" style={{ borderColor: "var(--border)", boxShadow: "none" }}>
                    <div className="card-body">
                      <div className="field-row">
                        <div className="field"><label className="muted">ID</label>
                          <input className="input" value={svc.service_id}
                            onChange={e => setServices(p=>p.map((x,i)=>i===idx?{...x, service_id:e.target.value}:x))} />
                        </div>
                        <div className="field"><label className="muted">Start date</label>
                          <input className="input" type="date"
                            value={`${svc.start_date.slice(0,4)}-${svc.start_date.slice(4,6)}-${svc.start_date.slice(6,8)}`}
                            onChange={e => setServices(p=>p.map((x,i)=>i===idx?{...x, start_date: toYYYYMMDD(e.target.value)}:x))} />
                        </div>
                        <div className="field"><label className="muted">End date</label>
                          <input className="input" type="date"
                            value={`${svc.end_date.slice(0,4)}-${svc.end_date.slice(4,6)}-${svc.end_date.slice(6,8)}`}
                            onChange={e => setServices(p=>p.map((x,i)=>i===idx?{...x, end_date: toYYYYMMDD(e.target.value)}:x))} />
                        </div>
                        <div className="field"><label className="muted">Days</label>
                          <div className="row" style={{ gap: 6 }}>
                            {["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].map((d) => (
                              <label key={d} className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                <input type="checkbox" checked={(svc as any)[d]===1}
                                  onChange={(e)=>setServices(p=>p.map((x,i)=>i===idx?{...x, [d]: e.target.checked?1:0}:x))} />
                                {d.slice(0,3).toUpperCase()}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

            </div>
          </div>
        </div>

        {/* Trips */}
        <div className="card section">
          <div className="card-body">
            <h3 className="card-title">Trips & stop times</h3>

            <div className="field-row-3" style={{ alignItems: "end", marginBottom: 8 }}>
              <div className="field">
                <label className="muted">Route</label>
                <select className="select" value={selectedRoute} onChange={e => setSelectedRoute(e.target.value)}>
                  <option value="">(select)</option>
                  {routes.map(r => <option key={r.route_id} value={r.route_id}>{r.route_short_name || r.route_id}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="muted">Service</label>
                <select className="select" value={selectedService} onChange={e => setSelectedService(e.target.value)}>
                  {services.map(s => <option key={s.service_id} value={s.service_id}>{s.service_id}</option>)}
                </select>
              </div>
              <div className="field">
                <button className="btn" onClick={addTrip} disabled={!selectedRoute}>+ Add trip</button>
              </div>
            </div>

            {trips.filter(t => !selectedRoute || t.route_id === selectedRoute).map((t) => (
              <div key={t.trip_id} className="card" style={{ boxShadow: "none", marginTop: 8 }}>
                <div className="card-body">
                  <div className="field-row-3" style={{ alignItems: "end" }}>
                    <div className="field"><label className="muted">Trip ID</label>
                      <input className="input" value={t.trip_id}
                        onChange={e => setTrips(p => p.map(x => x.trip_id===t.trip_id ? { ...x, trip_id: e.target.value } : x))} />
                    </div>
                    <div className="field"><label className="muted">Headsign</label>
                      <input className="input" value={t.trip_headsign || ""}
                        onChange={e => setTrips(p => p.map(x => x.trip_id===t.trip_id ? { ...x, trip_headsign: e.target.value } : x))} />
                    </div>
                    <div className="field"><label className="muted">Shape</label>
                      <select className="select" value={t.shape_id || ""}
                        onChange={e => setTrips(p => p.map(x => x.trip_id===t.trip_id ? { ...x, shape_id: e.target.value || undefined } : x))}>
                        <option value="">(none)</option>
                        {[...shapesIndex.keys()].map(sid => <option key={sid} value={sid}>{sid}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="field" style={{ marginTop: 10 }}>
                    <label className="muted">Add stop</label>
                    <select className="select" onChange={(e) => { if (e.target.value) { addStopTime(t.trip_id, e.target.value); e.currentTarget.selectedIndex = 0; } }}>
                      <option value="">(choose stop)</option>
                      {stops.map(s => <option key={s.uid} value={s.stop_id}>{s.stop_name} ({s.stop_id})</option>)}
                    </select>
                  </div>

                  <table className="table" style={{ marginTop: 8 }}>
                    <thead><tr><th>Seq</th><th>Stop</th><th>Arr</th><th>Dep</th><th></th></tr></thead>
                    <tbody>
                      {stopTimes.filter(s => s.trip_id === t.trip_id).sort((a, b) => a.stop_sequence - b.stop_sequence).map(st => (
                        <tr key={`${t.trip_id}_${st.stop_sequence}`}>
                          <td>{st.stop_sequence}</td>
                          <td>
                            <select className="select" value={st.stop_id}
                              onChange={(e) => setStopTimeField(t.trip_id, st.stop_sequence, "stop_id", e.target.value)}>
                              {stops.map(s => <option key={s.uid} value={s.stop_id}>{s.stop_name} ({s.stop_id})</option>)}
                            </select>
                          </td>
                          <td><input className="input" value={st.arrival_time}
                                     onChange={e => setStopTimeField(t.trip_id, st.stop_sequence, "arrival_time", e.target.value)}
                                     placeholder="HH:MM:SS" /></td>
                          <td><input className="input" value={st.departure_time}
                                     onChange={e => setStopTimeField(t.trip_id, st.stop_sequence, "departure_time", e.target.value)}
                                     placeholder="HH:MM:SS" /></td>
                          <td><button className="btn" onClick={() => removeStopTime(t.trip_id, st.stop_sequence)}>✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Agency */}
        <div className="card section">
          <div className="card-body">
            <h3 className="card-title">Agency</h3>
            {agencies.map((a, idx) => (
              <div key={a.agency_id} className="field-row">
                <div className="field"><label className="muted">ID</label>
                  <input className="input" value={a.agency_id} onChange={e => setAgencies(p=>p.map((x,i)=>i===idx?{...x, agency_id:e.target.value}:x))} />
                </div>
                <div className="field"><label className="muted">Name</label>
                  <input className="input" value={a.agency_name} onChange={e => setAgencies(p=>p.map((x,i)=>i===idx?{...x, agency_name:e.target.value}:x))} />
                </div>
                <div className="field"><label className="muted">URL</label>
                  <input className="input" value={a.agency_url} onChange={e => setAgencies(p=>p.map((x,i)=>i===idx?{...x, agency_url:e.target.value}:x))} />
                </div>
                <div className="field"><label className="muted">Timezone</label>
                  <input className="input" value={a.agency_timezone} onChange={e => setAgencies(p=>p.map((x,i)=>i===idx?{...x, agency_timezone:e.target.value}:x))} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT COLUMN: Validation + Reset */}
      <div className="card right-pane">
        <div className="card-body">
          <h3 className="card-title">Validation</h3>

          {banner && (
            <div style={{
              borderRadius: 10, padding: "10px 12px", marginBottom: 10,
              color: banner.kind === "error" ? "#991b1b" : banner.kind === "success" ? "#065f46" : "#1f2937",
              background: banner.kind === "error" ? "#fee2e2" : banner.kind === "success" ? "#d1fae5" : "#e5e7eb",
              border: "1px solid rgba(0,0,0,0.05)"
            }}>
              {banner.text}
            </div>
          )}

          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={runValidation}>Run validation</button>
            <button className="btn btn-primary" onClick={onExport}>Export GTFS .zip</button>
            <button className="btn" onClick={undoOne} title="Undo (⌘/Ctrl+Z)">Undo</button>
            <button className="btn" onClick={resetAll} title="Reset all data">Reset</button>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <strong>Errors:</strong> {validation.errors.length} <span> | </span> <strong>Warnings:</strong> {validation.warnings.length}
          </div>

          {validation.errors.length > 0 && (
            <>
              <h4>Errors</h4>
              <ul>
                {validation.errors.map((e, i) => <li key={`e${i}`}><code>{e.file}{e.row ? `:${e.row}` : ""}</code> — {e.message}</li>)}
              </ul>
            </>
          )}
          {validation.warnings.length > 0 && (
            <>
              <h4>Warnings</h4>
              <ul>
                {validation.warnings.map((w, i) => <li key={`w${i}`}><code>{w.file}{w.row ? `:${w.row}` : ""}</code> — {w.message}</li>)}
              </ul>
            </>
          )}

          <p className="muted" style={{ marginTop: 8 }}>
            Export is blocked when there are <strong>errors</strong>. You can export with <strong>warnings</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}
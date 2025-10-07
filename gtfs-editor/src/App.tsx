import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import { v4 as uuidv4 } from "uuid";

/** ---------- Misc ---------- */
const defaultTZ: string = String(
  Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Madrid"
);

/** ---------- Types ---------- */
type Stop = { uid: string; stop_id: string; stop_name: string; stop_lat: number; stop_lon: number };
type RouteRow = { route_id: string; route_short_name: string; route_long_name: string; route_type: number; agency_id: string };
type Service = {
  service_id: string;
  monday: number; tuesday: number; wednesday: number; thursday: number; friday: number; saturday: number; sunday: number;
  start_date: string; end_date: string;
};
type Trip = { route_id: string; service_id: string; trip_id: string; trip_headsign?: string; shape_id?: string };
type StopTime = { trip_id: string; arrival_time: string; departure_time: string; stop_id: string; stop_sequence: number };
type ShapePt = { shape_id: string; lat: number; lon: number; seq: number };
type Agency = { agency_id: string; agency_name: string; agency_url: string; agency_timezone: string };

type Issue = { level: "error" | "warning"; file: string; row?: number; message: string };
type Banner = { kind: "success" | "error"; text: string } | null;

/** ---------- Small helpers ---------- */
function toYYYYMMDD(d: string | Date) {
  const date = typeof d === "string" ? new Date(d) : d;
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${y}${m}${day}`;
}
function csvify<T extends Record<string, any>>(rows: T[], headerOrder?: string[]) {
  if (!rows || !rows.length) return "";
  const headers = headerOrder?.length ? headerOrder : Object.keys(rows[0]);
  const out = [headers.join(",")];
  for (const r of rows) out.push(headers.map(h => String(r[h] ?? "")).join(","));
  return out.join("\n");
}

/** ---------- Export GTFS (zip) ---------- */
async function exportGTFSZip(payload: {
  agencies: Agency[]; stops: Stop[]; routes: RouteRow[]; services: Service[];
  trips: Trip[]; stopTimes: StopTime[]; shapePts: ShapePt[];
}) {
  const zip = new JSZip();

  zip.file("agency.txt", csvify(payload.agencies, ["agency_id","agency_name","agency_url","agency_timezone"]));
  zip.file("stops.txt", csvify(
    payload.stops.map(s => ({ stop_id: s.stop_id, stop_name: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon })),
    ["stop_id","stop_name","stop_lat","stop_lon"]
  ));
  zip.file("routes.txt", csvify(payload.routes, ["route_id","route_short_name","route_long_name","route_type","agency_id"]));
  zip.file("calendar.txt", csvify(payload.services, ["service_id","monday","tuesday","wednesday","thursday","friday","saturday","sunday","start_date","end_date"]));
  zip.file("trips.txt", csvify(payload.trips, ["route_id","service_id","trip_id","trip_headsign","shape_id"]));
  zip.file("stop_times.txt", csvify(payload.stopTimes, ["trip_id","arrival_time","departure_time","stop_id","stop_sequence"]));
  zip.file("shapes.txt", csvify(
    payload.shapePts.map(p => ({ shape_id: p.shape_id, shape_pt_lat: p.lat, shape_pt_lon: p.lon, shape_pt_sequence: p.seq })),
    ["shape_id","shape_pt_lat","shape_pt_lon","shape_pt_sequence"]
  ));

  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, "gtfs.zip");
}

/** ---------- Map bits ---------- */
function AddStopOnClick({ onAdd }: { onAdd: (latlng: { lat: number; lng: number }) => void }) {
  useMapEvents({ click(e) { onAdd(e.latlng); } });
  return null;
}
function DrawShapeOnClick({ onPoint, onFinish }: { onPoint: (latlng: { lat: number; lng: number }) => void; onFinish: () => void }) {
  const map = useMap();
  useEffect(() => {
    const onClick = (e: any) => onPoint(e.latlng);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter") onFinish(); };
    map.on("click", onClick); window.addEventListener("keydown", onKey);
    return () => { map.off("click", onClick); window.removeEventListener("keydown", onKey); };
  }, [map, onPoint, onFinish]);
  return null;
}

/** ---------- Advanced filter parsing ---------- */
// Detect if a query uses advanced operators
function looksAdvanced(q: string) {
  return /(&&|\|\||==|!=|>=|<=|>|<|~=|!~=)/.test(q);
}
function tryNumber(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normalizeValue(raw: any): string {
  if (raw === null || raw === undefined) return "";
  return String(raw);
}
function parseValueToken(tok: string): string {
  const t = tok.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
type Cond = { field: string; op: string; value: string };

// Split by top-level ||, then each by &&
function splitByLogical(expr: string): string[][] {
  // very small, safe splitter (no parentheses support to keep it simple)
  const orParts = expr.split(/\|\|/);
  return orParts.map(part => part.split(/&&/));
}
function parseCond(raw: string): Cond | null {
  const m = raw.match(/^\s*([a-zA-Z0-9_]+)\s*(==|!=|>=|<=|>|<|~=|!~=)\s*(.+?)\s*$/);
  if (!m) return null;
  const [, field, op, rhs] = m;
  return { field, op, value: parseValueToken(rhs) };
}
function cmp(op: string, left: any, right: any): boolean {
  const lstr = normalizeValue(left);
  const rstr = normalizeValue(right);
  const ln = tryNumber(lstr);
  const rn = tryNumber(rstr);

  const bothNums = ln !== null && rn !== null;

  switch (op) {
    case "==": return bothNums ? ln === rn : lstr === rstr;
    case "!=": return bothNums ? ln !== rn : lstr !== rstr;
    case ">":  return bothNums ? ln > rn : lstr > rstr;
    case "<":  return bothNums ? ln < rn : lstr < rstr;
    case ">=": return bothNums ? ln >= rn : lstr >= rstr;
    case "<=": return bothNums ? ln <= rn : lstr <= rstr;
    case "~=": return lstr.toLowerCase().includes(rstr.toLowerCase());
    case "!~=": return !lstr.toLowerCase().includes(rstr.toLowerCase());
    default: return false;
  }
}
function matchesAdvancedRow(row: Record<string, any>, expr: string): boolean {
  const orGroups = splitByLogical(expr);
  for (const andGroup of orGroups) {
    let ok = true;
    for (let raw of andGroup) {
      const c = parseCond(raw);
      if (!c) { ok = false; break; }
      const val = row[c.field];
      if (!cmp(c.op, val, c.value)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** ---------- Paginated + Searchable table with advanced filtering ---------- */
function PaginatedEditableTable<T extends Record<string, any>>({
  title, rows, onChange,
  visibleIndex,
  initialPageSize = 5,
  onRowClick,
}: {
  title: string;
  rows: T[];
  onChange: (next: T[]) => void;
  visibleIndex?: number[];
  initialPageSize?: 5|10|20|50|100;
  onRowClick?: (row: T) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<5|10|20|50|100>(initialPageSize);
  const [query, setQuery] = useState("");

  const baseIdx = useMemo(
    () => (visibleIndex && visibleIndex.length ? visibleIndex.slice() : rows.map((_, i) => i)),
    [visibleIndex, rows]
  );

  const cols = useMemo<string[]>(
    () => (rows.length ? Object.keys(rows[0] as object) : []),
    [rows]
  );

  const filteredIdx = useMemo(() => {
    const q = query.trim();
    if (!q) return baseIdx;

    if (looksAdvanced(q)) {
      const out: number[] = [];
      for (const gi of baseIdx) {
        const r = rows[gi] as Record<string, any>;
        if (matchesAdvancedRow(r, q)) out.push(gi);
      }
      return out;
    }

    // fallback: free-text across columns
    const ql = q.toLowerCase();
    const out: number[] = [];
    for (const gi of baseIdx) {
      const r = rows[gi] as Record<string, any>;
      if (cols.some(c => String(r[c] ?? "").toLowerCase().includes(ql))) out.push(gi);
    }
    return out;
  }, [query, baseIdx, rows, cols]);

  const pageCount = Math.max(1, Math.ceil(filteredIdx.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageIdx = filteredIdx.slice(start, start + pageSize);

  useEffect(() => { setPage(1); }, [pageSize, query, visibleIndex, rows]);

  const edit = (globalIndex: number, key: string, v: string) => {
    const next = rows.slice();
    next[globalIndex] = { ...next[globalIndex], [key]: v };
    onChange(next);
  };

  return (
    <div className="card section" style={{ marginTop: 12 }}>
      <div className="card-body">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <h3 style={{ margin: 0 }}>
            {title}{" "}
            <span style={{ opacity: .6, fontWeight: 400 }}>
              ({rows.length} rows{filteredIdx.length !== rows.length ? ` | filtered: ${filteredIdx.length}` : ""})
            </span>
          </h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search…  (e.g. route_id == "18" && service_id == "6")`}
              style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e3e3e3", width: 320 }}
            />
            <label style={{ fontSize: 13, opacity: .75 }}>Show</label>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value) as any)}
              style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e3e3e3" }}
            >
              {[5,10,20,50,100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-auto" style={{ borderRadius: 12, border: "1px solid #eee", marginTop: 8 }}>
          <table style={{ width: "100%", fontSize: 13, minWidth: 800 }}>
            <thead>
              <tr>{cols.map(c => <th key={c} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {pageIdx.length ? pageIdx.map((gi) => {
                const r = rows[gi];
                return (
                  <tr key={gi} onClick={onRowClick ? () => onRowClick(r) : undefined} style={{ cursor: onRowClick ? "pointer" : "default" }}>
                    {cols.map(c => (
                      <td key={c} style={{ borderBottom: "1px solid #f3f3f3", padding: 4 }}>
                        <input
                          value={(r as any)[c] ?? ""}
                          onChange={e => edit(gi, c, e.target.value)}
                          style={{ width: "100%", outline: "none", border: "1px solid #e8e8e8", padding: "4px 6px", borderRadius: 8 }}
                        />
                      </td>
                    ))}
                  </tr>
                );
              }) : (
                <tr><td colSpan={Math.max(1, cols.length)} style={{ padding: 12, opacity: .6 }}>No rows.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, alignItems: "center" }}>
          <div style={{ fontSize: 12, opacity: .7 }}>
            Page {pageIdx.length ? safePage : 1} of {pageCount}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" disabled={safePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Prev</button>
            <button className="btn" disabled={safePage >= pageCount} onClick={() => setPage(p => Math.min(pageCount, p + 1))}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** ---------- App ---------- */
export default function App() {
  /** Leaflet icons (only needed if you still use default Markers elsewhere) */
  useEffect(() => {
    // @ts-ignore
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    });
  }, []);

  /** Data */
  const [agencies, setAgencies] = useState<Agency[]>([{
    agency_id: "agency_1",
    agency_name: "My Agency",
    agency_url: "https://example.com",
    agency_timezone: defaultTZ,
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

  /** UI */
  const [drawMode, setDrawMode] = useState(false);
  const [nextStopName, setNextStopName] = useState<string>("");
  const [showRoutes, setShowRoutes] = useState<boolean>(true);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  /** Validation & banner */
  const [validation, setValidation] = useState<{ errors: Issue[]; warnings: Issue[] }>({ errors: [], warnings: [] });
  const [banner, setBanner] = useState<Banner>(null);

  /** Persistence */
  const STORAGE_KEY = "gtfs_builder_state_v1";
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        setAgencies(obj.agencies ?? []);
        setStops((obj.stops ?? []).map((s: any) => ({ uid: s.uid || uuidv4(), ...s })));
        setRoutes(obj.routes ?? []);
        setServices(obj.services ?? []);
        setTrips(obj.trips ?? []);
        setStopTimes(obj.stopTimes ?? []);
        setShapePts(obj.shapePts ?? []);
      }
    } catch {/* ignore */}
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ agencies, stops, routes, services, trips, stopTimes, shapePts }));
    } catch {/* ignore */}
  }, [hydrated, agencies, stops, routes, services, trips, stopTimes, shapePts]);

  /** Colors */
  function hashCode(str: string) { let h = 0; for (let i=0;i<str.length;i++) h = ((h<<5)-h) + str.charCodeAt(i) | 0; return h; }
  const PALETTE = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"];
  const routeColor = (routeId: string) => PALETTE[Math.abs(hashCode(routeId)) % PALETTE.length];

  /** Add stop by clicking map */
  const addStopFromMap = (latlng: { lat: number; lng: number }) => {
    const base = nextStopName?.trim() || "Stop";
    const num = (stops.length + 1).toString().padStart(3, "0");
    setStops([...stops, { uid: uuidv4(), stop_id: `S_${num}`, stop_name: `${base} ${num}`, stop_lat: latlng.lat, stop_lon: latlng.lng }]);
  };

  /** Project import/export (JSON) */
  const exportProject = () => {
    const blob = new Blob([JSON.stringify({ agencies, stops, routes, services, trips, stopTimes, shapePts }, null, 2)], { type: "application/json" });
    saveAs(blob, "project.json");
  };
  const importProject = async (file: File) => {
    try {
      const obj = JSON.parse(await file.text());
      setAgencies(obj.agencies ?? []);
      setStops((obj.stops ?? []).map((s: any) => ({ uid: s.uid || uuidv4(), ...s })));
      setRoutes(obj.routes ?? []);
      setServices(obj.services ?? []);
      setTrips(obj.trips ?? []);
      setStopTimes(obj.stopTimes ?? []);
      setShapePts(obj.shapePts ?? []);
      setBanner({ kind: "success", text: "Project imported." });
      setTimeout(() => setBanner(null), 2200);
    } catch {
      setBanner({ kind: "error", text: "Invalid project JSON." });
      setTimeout(() => setBanner(null), 3200);
    }
  };

  /** Import GTFS .zip */
  const importGTFSZip = async (file: File) => {
    try {
      const zip = await JSZip.loadAsync(file);
      const tables: Record<string, string> = {};
      for (const entry of Object.values(zip.files)) {
        const f = entry as any;
        if (f.dir) continue;
        if (!f.name?.toLowerCase().endsWith(".txt")) continue;
        tables[f.name.replace(/\.txt$/i, "")] = await f.async("string");
      }
      const parse = (text: string) => (Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true }).data as any[]) || [];

      if (tables["agency"]) {
        setAgencies(parse(tables["agency"]).map((r: any) => ({
          agency_id: String(r.agency_id ?? ""), agency_name: String(r.agency_name ?? ""),
          agency_url: String(r.agency_url ?? ""), agency_timezone: String(r.agency_timezone ?? defaultTZ)
        })));
      }
      if (tables["stops"]) {
        setStops(parse(tables["stops"]).map((r: any) => ({
          uid: uuidv4(),
          stop_id: String(r.stop_id ?? ""), stop_name: String(r.stop_name ?? ""),
          stop_lat: Number(r.stop_lat ?? r.stop_latitude ?? r.lat ?? 0),
          stop_lon: Number(r.stop_lon ?? r.stop_longitude ?? r.lon ?? 0),
        })));
      }
      if (tables["routes"]) {
        setRoutes(parse(tables["routes"]).map((r: any) => ({
          route_id: String(r.route_id ?? ""), route_short_name: String(r.route_short_name ?? ""),
          route_long_name: String(r.route_long_name ?? ""), route_type: Number(r.route_type ?? 3),
          agency_id: String(r.agency_id ?? ""),
        })));
      }
      if (tables["calendar"]) {
        setServices(parse(tables["calendar"]).map((r: any) => ({
          service_id: String(r.service_id ?? ""),
          monday: Number(r.monday ?? 0), tuesday: Number(r.tuesday ?? 0), wednesday: Number(r.wednesday ?? 0),
          thursday: Number(r.thursday ?? 0), friday: Number(r.friday ?? 0), saturday: Number(r.saturday ?? 0), sunday: Number(r.sunday ?? 0),
          start_date: String(r.start_date ?? ""), end_date: String(r.end_date ?? ""),
        })));
      }
      if (tables["trips"]) {
        setTrips(parse(tables["trips"]).map((r: any) => ({
          route_id: String(r.route_id ?? ""), service_id: String(r.service_id ?? ""), trip_id: String(r.trip_id ?? ""),
          trip_headsign: r.trip_headsign != null ? String(r.trip_headsign) : undefined,
          shape_id: r.shape_id != null ? String(r.shape_id) : undefined,
        })));
      }
      if (tables["stop_times"]) {
        setStopTimes(parse(tables["stop_times"]).map((r: any) => ({
          trip_id: String(r.trip_id ?? ""), arrival_time: String(r.arrival_time ?? ""),
          departure_time: String(r.departure_time ?? ""), stop_id: String(r.stop_id ?? ""),
          stop_sequence: Number(r.stop_sequence ?? 0),
        })));
      }
      if (tables["shapes"]) {
        setShapePts(parse(tables["shapes"]).map((r: any) => ({
          shape_id: String(r.shape_id ?? ""),
          lat: Number(r.shape_pt_lat ?? r.lat ?? 0), lon: Number(r.shape_pt_lon ?? r.lon ?? 0),
          seq: Number(r.shape_pt_sequence ?? r.seq ?? 0),
        })));
      }

      setBanner({ kind: "success", text: "GTFS zip imported." });
      setTimeout(() => setBanner(null), 2200);
    } catch (e) {
      console.error(e);
      setBanner({ kind: "error", text: "Failed to import GTFS zip." });
      setTimeout(() => setBanner(null), 3200);
    }
  };

  /** ---------- Derived maps/indices for route visual + selection ---------- */
  const stopsById = useMemo(() => {
    const m = new Map<string, Stop>();
    for (const s of stops) m.set(s.stop_id, s);
    return m;
  }, [stops]);

  const shapesById = useMemo(() => {
    const m = new Map<string, ShapePt[]>();
    for (const p of shapePts) {
      const arr = m.get(p.shape_id) ?? [];
      arr.push(p);
      m.set(p.shape_id, arr);
    }
    for (const [k, arr] of m) m.set(k, arr.slice().sort((a,b)=>a.seq-b.seq));
    return m;
  }, [shapePts]);

  const stopTimesByTrip = useMemo(() => {
    const m = new Map<string, StopTime[]>();
    for (const st of stopTimes) {
      const arr = m.get(st.trip_id) ?? [];
      arr.push(st);
      m.set(st.trip_id, arr);
    }
    for (const [k, arr] of m) m.set(k, arr.slice().sort((a,b)=>a.stop_sequence-b.stop_sequence));
    return m;
  }, [stopTimes]);

  const tripsByRoute = useMemo(() => {
    const m = new Map<string, Trip[]>();
    for (const t of trips) {
      const arr = m.get(t.route_id) ?? [];
      arr.push(t);
      m.set(t.route_id, arr);
    }
    return m;
  }, [trips]);

  /** representative polyline per route (shapes-first, else stop→stop straight lines) */
  const routePolylines = useMemo(() => {
    const out = new Map<string, [number, number][]>();

    for (const r of routes) {
      const rTrips = tripsByRoute.get(r.route_id) ?? [];

      // Try shapes
      let bestShape: [number, number][] | null = null;
      for (const t of rTrips) {
        if (!t.shape_id) continue;
        const pts = shapesById.get(t.shape_id);
        if (!pts || pts.length < 2) continue;
        const coords = pts.map(p => [p.lat, p.lon] as [number, number]);
        if (!bestShape || coords.length > bestShape.length) bestShape = coords;
      }
      if (bestShape) { out.set(r.route_id, bestShape); continue; }

      // Fallback: first trip with stop_times
      let fallback: [number, number][] | null = null;
      for (const t of rTrips) {
        const sts = stopTimesByTrip.get(t.trip_id);
        if (!sts || sts.length < 2) continue;
        const coords: [number, number][] = [];
        for (const st of sts) {
          const s = stopsById.get(st.stop_id);
          if (s) coords.push([s.stop_lat, s.stop_lon]);
        }
        if (coords.length >= 2) { fallback = coords; break; }
      }
      if (fallback) out.set(r.route_id, fallback);
    }

    return out;
  }, [routes, tripsByRoute, shapesById, stopTimesByTrip, stopsById]);

  /** ---------- Selection-based filtering (indices) ---------- */
  const selectedTripsSet = useMemo(() => {
    if (!selectedRouteId) return null;
    const ids = new Set<string>();
    for (const t of trips) if (t.route_id === selectedRouteId) ids.add(t.trip_id);
    return ids;
  }, [selectedRouteId, trips]);

  const selectedShapeSet = useMemo(() => {
    if (!selectedRouteId) return null;
    const ids = new Set<string>();
    for (const t of trips) if (t.route_id === selectedRouteId && t.shape_id) ids.add(t.shape_id);
    return ids;
  }, [selectedRouteId, trips]);

  const routesVisibleIdx = useMemo(() => {
    if (!selectedRouteId) return routes.map((_, i) => i);
    return routes.map((r,i)=>[r,i]).filter(([r])=> (r as RouteRow).route_id===selectedRouteId).map(([_,i])=>i as number);
  }, [routes, selectedRouteId]);

  const tripsVisibleIdx = useMemo(() => {
    if (!selectedRouteId) return trips.map((_, i) => i);
    return trips.map((t,i)=>[t,i]).filter(([t])=> (t as Trip).route_id===selectedRouteId).map(([_,i])=>i as number);
  }, [trips, selectedRouteId]);

  const stopTimesVisibleIdx = useMemo(() => {
    if (!selectedTripsSet) return stopTimes.map((_, i) => i);
    return stopTimes.map((st,i)=>[st,i]).filter(([st])=> selectedTripsSet.has((st as StopTime).trip_id)).map(([_,i])=>i as number);
  }, [stopTimes, selectedTripsSet]);

  const shapesVisibleIdx = useMemo(() => {
    if (!selectedShapeSet) return shapePts.map((_, i) => i);
    return shapePts.map((p,i)=>[p,i]).filter(([p])=> selectedShapeSet.has((p as ShapePt).shape_id)).map(([_,i])=>i as number);
  }, [shapePts, selectedShapeSet]);

  const stopsVisibleIdx = useMemo(() => {
    if (!selectedTripsSet) return stops.map((_, i) => i);
    const stopIdSet = new Set<string>();
    for (const st of stopTimes) if (selectedTripsSet.has(st.trip_id)) stopIdSet.add(st.stop_id);
    return stops.map((s,i)=>[s,i]).filter(([s])=> stopIdSet.has((s as Stop).stop_id)).map(([_,i])=>i as number);
  }, [stops, stopTimes, selectedTripsSet]);

  /** ---------- Validation ---------- */
  function validateFeed(ctx: {
    agencies: Agency[]; stops: Stop[]; routes: RouteRow[]; services: Service[];
    trips: Trip[]; stopTimes: StopTime[]; shapePts: ShapePt[];
  }) {
    const errors: Issue[] = [];
    const warnings: Issue[] = [];

    const req = <T, K extends keyof T>(rows: T[], key: K, file: string) => {
      rows.forEach((r, i) => { const v = (r as any)[key]; if (v === undefined || v === null || v === "") errors.push({ level: "error", file, row: i + 1, message: `Missing ${String(key)}` }); });
    };
    req(ctx.agencies, "agency_id", "agency.txt");
    req(ctx.stops, "stop_id", "stops.txt");
    req(ctx.routes, "route_id", "routes.txt");
    req(ctx.services, "service_id", "calendar.txt");
    req(ctx.trips, "trip_id", "trips.txt");
    req(ctx.stopTimes, "trip_id", "stop_times.txt");

    const dup = <T, K extends keyof T>(rows: T[], key: K, file: string) => {
      const seen = new Set<any>();
      rows.forEach((r, i) => { const k = (r as any)[key]; if (seen.has(k)) errors.push({ level: "error", file, row: i + 1, message: `Duplicate ${String(key)}: ${k}` }); seen.add(k); });
    };
    dup(ctx.stops, "stop_id", "stops.txt");
    dup(ctx.routes, "route_id", "routes.txt");
    dup(ctx.trips, "trip_id", "trips.txt");
    dup(ctx.services, "service_id", "calendar.txt");

    return { errors, warnings };
  }
  const runValidation = () => {
    const res = validateFeed({ agencies, stops, routes, services, trips, stopTimes, shapePts });
    setValidation(res);
    setBanner(res.errors.length ? { kind: "error", text: `Validation found ${res.errors.length} errors and ${res.warnings.length} warnings.` }
                                : { kind: "success", text: res.warnings.length ? `Validation OK with ${res.warnings.length} warnings.` : "Validation OK." });
    setTimeout(() => setBanner(null), 3200);
    return res;
  };

  const onExportGTFS = async () => {
    const { errors } = runValidation();
    if (errors.length) { alert("Fix validation errors before exporting."); return; }
    await exportGTFSZip({ agencies, stops, routes, services, trips, stopTimes, shapePts });
  };

  const resetAll = () => {
    if (!confirm("Reset project?")) return;
    setAgencies([]); setStops([]); setRoutes([]); setServices([]); setTrips([]); setStopTimes([]); setShapePts([]);
    localStorage.removeItem(STORAGE_KEY);
    setSelectedRouteId(null);
  };

  return (
    <div className="container" style={{ padding: 16 }}>
      <h1>GTFS Builder · V1 + Editor</h1>

      {banner && (
        <div
          className={`banner ${banner.kind === "error" ? "banner-error" : "banner-success"}`}
          style={{ margin: "8px 0 12px", padding: "8px 12px", borderRadius: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}
        >
          {banner.text}
        </div>
      )}

      {/* Toolbar */}
      <div className="card section" style={{ marginBottom: 12 }}>
        <div className="card-body" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label>Next stop name:</label>
            <input className="input" value={nextStopName} onChange={e => setNextStopName(e.target.value)} placeholder="optional" />
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={showRoutes} onChange={e => setShowRoutes(e.target.checked)} />
            Show routes
          </label>

          {selectedRouteId && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#f6f7f9", padding: "6px 10px", borderRadius: 10 }}>
              Selected route: <b>{selectedRouteId}</b>
              <button className="btn" onClick={() => setSelectedRouteId(null)}>Clear</button>
            </div>
          )}

          <button className="btn" onClick={exportProject}>Export project JSON</button>

          <label className="file-btn">
            Import project JSON
            <input type="file" accept="application/json" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) importProject(f); }} />
          </label>

          <label className="file-btn">
            Import GTFS .zip
            <input type="file" accept=".zip" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) importGTFSZip(f); }} />
          </label>

          <button className="btn btn-primary" onClick={onExportGTFS}>Export GTFS .zip</button>
          <button className="btn" onClick={runValidation}>Validate</button>
          <button className="btn btn-danger" onClick={resetAll}>Reset</button>
        </div>
      </div>

      {/* Map */}
      <div className="card section">
        <div className="card-body">
          <div className={`map-shell ${drawMode ? "is-drawing" : ""}`} style={{ height: 520, width: "100%", borderRadius: 12, overflow: "hidden", position: "relative" }}>
            <MapContainer center={[40.4168, -3.7038]} zoom={6} style={{ height: "100%", width: "100%" }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap contributors" />

              {!drawMode && <AddStopOnClick onAdd={addStopFromMap} />}
              {drawMode && <DrawShapeOnClick onPoint={() => { /* add points to active shape if you use draw mode */ }} onFinish={() => setDrawMode(false)} />}

              {/* Tiny circular stop markers */}
              {stops.map(s => (
                <CircleMarker
                  key={s.uid}
                  center={[s.stop_lat, s.stop_lon]}
                  radius={3}
                  color="#222"
                  weight={1}
                  fillColor="#fff"
                  fillOpacity={1}
                />
              ))}

              {/* Route polylines */}
              {showRoutes && Array.from(routePolylines.entries()).map(([route_id, coords]) => (
                <Polyline
                  key={route_id}
                  positions={coords as any}
                  pathOptions={{
                    color: routeColor(route_id),
                    weight: selectedRouteId === route_id ? 6 : 3,
                    opacity: selectedRouteId && selectedRouteId !== route_id ? 0.25 : 0.9
                  }}
                  eventHandlers={{ click: () => setSelectedRouteId(route_id) }}
                />
              ))}
            </MapContainer>
          </div>
        </div>
      </div>

      {/* ===== Editor tables (now support advanced filters) ===== */}
      {(agencies.length || routes.length || stops.length || trips.length || services.length || stopTimes.length || shapePts.length) ? (
        <>
          <PaginatedEditableTable
            title="routes.txt"
            rows={routes}
            onChange={setRoutes}
            visibleIndex={routesVisibleIdx}
            initialPageSize={5}
            onRowClick={(r) => setSelectedRouteId((r as RouteRow).route_id)}
          />

          <PaginatedEditableTable
            title="trips.txt"
            rows={trips}
            onChange={setTrips}
            visibleIndex={tripsVisibleIdx}
            initialPageSize={5}
          />

          <PaginatedEditableTable
            title="stop_times.txt"
            rows={stopTimes}
            onChange={setStopTimes}
            visibleIndex={stopTimesVisibleIdx}
            initialPageSize={5}
          />

          <PaginatedEditableTable
            title="shapes.txt"
            rows={shapePts.map(p => ({ shape_id: p.shape_id, shape_pt_lat: p.lat, shape_pt_lon: p.lon, shape_pt_sequence: p.seq })) as any}
            onChange={(next) => {
              setShapePts(next.map((r: any) => ({
                shape_id: r.shape_id, lat: Number(r.shape_pt_lat), lon: Number(r.shape_pt_lon), seq: Number(r.shape_pt_sequence)
              })));
            }}
            visibleIndex={shapesVisibleIdx}
            initialPageSize={5}
          />

          <PaginatedEditableTable
            title="stops.txt"
            rows={stops.map(s => ({ stop_id: s.stop_id, stop_name: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon })) as any}
            onChange={(next) => {
              const byId = new Map(stops.map(s => [s.stop_id, s]));
              const merged = next.map((r: any) => {
                const prev = byId.get(r.stop_id);
                return { uid: prev?.uid ?? uuidv4(), stop_id: r.stop_id, stop_name: r.stop_name, stop_lat: Number(r.stop_lat), stop_lon: Number(r.stop_lon) };
              });
              setStops(merged);
            }}
            visibleIndex={stopsVisibleIdx}
            initialPageSize={5}
          />

          <PaginatedEditableTable
            title="agency.txt"
            rows={agencies}
            onChange={setAgencies}
            initialPageSize={5}
          />

          <PaginatedEditableTable
            title="calendar.txt"
            rows={services}
            onChange={setServices}
            initialPageSize={5}
          />
        </>
      ) : null}

      {/* Validation summary */}
      <div className="card section" style={{ marginTop: 12 }}>
        <div className="card-body">
          <h3>Validation</h3>
          <div className="muted" style={{ marginTop: 10 }}>
            <strong>Errors:</strong> {validation.errors.length} &nbsp; | &nbsp;
            <strong>Warnings:</strong> {validation.warnings.length}
          </div>
          {validation.errors.length > 0 && (
            <>
              <h4>Errors</h4>
              <ul>{validation.errors.map((e, i) => <li key={`e${i}`}><code>{e.file}{e.row ? `:${e.row}` : ""}</code> — {e.message}</li>)}</ul>
            </>
          )}
          {validation.warnings.length > 0 && (
            <>
              <h4>Warnings</h4>
              <ul>{validation.warnings.map((w, i) => <li key={`w${i}`}><code>{w.file}{w.row ? `:${w.row}` : ""}</code> — {w.message}</li>)}</ul>
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
import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, useMapEvents, useMap, Pane } from "react-leaflet";
import L from "leaflet";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import * as Papa from "papaparse";
import { v4 as uuidv4 } from "uuid";

/** ---------- Misc ---------- */
const defaultTZ: string = String(Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Madrid");
const MIN_ADD_ZOOM = 15;
const DIM_ROUTE_COLOR = "#2b2b2b"; // single gray for all non-selected routes

/** ---------- Types ---------- */
type Stop = { uid: string; stop_id: string; stop_name: string; stop_lat: number; stop_lon: number };
type RouteRow = { route_id: string; route_short_name: string; route_long_name: string; route_type: number; agency_id: string };
type Service = {
  service_id: string;
  monday: number; tuesday: number; wednesday: number; thursday: number; friday: number; saturday: number; sunday: number;
  start_date: string; end_date: string;
};
type Trip = { route_id: string; service_id: string; trip_id: string; trip_headsign?: string; shape_id?: string; direction_id?: string };
type StopTime = { trip_id: string; arrival_time: string; departure_time: string; stop_id: string; stop_sequence: number | string };
type ShapePt = { shape_id: string; lat: number; lon: number; seq: number };
type Agency = { agency_id: string; agency_name: string; agency_url: string; agency_timezone: string };

type Issue = { level: "error" | "warning"; file: string; row?: number; message: string };
type Banner = { kind: "success" | "error" | "info"; text: string } | null;

/** ---------- Helpers ---------- */
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
const num = (x: any, def = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
};
function timeToSeconds(t?: string | null) {
  if (!t) return null;
  const m = String(t).match(/^\s*(\d+):(\d{2})(?::(\d{2}))?\s*$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10), s = parseInt(m[3] || "0", 10);
  return h*3600 + mi*60 + s;
}
function isMonotonicNonDecreasing(times: (string | undefined)[]) {
  const seq = times.map(timeToSeconds).filter(v => v !== null) as number[];
  for (let i = 1; i < seq.length; i++) if (seq[i-1] > seq[i]) return false;
  return true;
}

/** UI shows HH:MM, storage HH:MM:00 (or "" for empty) */
function uiFromGtfs(t: string | undefined): string {
  if (!t) return "";
  const m = t.match(/^\s*(\d+):(\d{2})(?::\d{2})?\s*$/);
  if (!m) return t;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}
function gtfsFromUi(t: string | undefined): string {
  if (!t) return "";
  const trimmed = t.trim();
  if (!trimmed) return ""; // empty allowed
  const m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return trimmed; // allow pasting full GTFS time too
  const hh = m[1].padStart(2, "0");
  const mm = m[2];
  return `${hh}:${mm}:00`;
}

/** ---------- Export GTFS (zip) ---------- */
async function exportGTFSZip(payload: {
  agencies: Agency[]; stops: Stop[]; routes: RouteRow[]; services: Service[];
  trips: Trip[]; stopTimes: StopTime[]; shapePts: ShapePt[];
}) {
  const zip = new JSZip();

  // Skip any stop_times rows where both times are blank
  const filteredStopTimes = payload.stopTimes.filter(
    st => !!(st.arrival_time?.trim() || st.departure_time?.trim())
  );

  zip.file("agency.txt", csvify(payload.agencies, ["agency_id","agency_name","agency_url","agency_timezone"]));
  zip.file("stops.txt", csvify(
    payload.stops.map(s => ({ stop_id: s.stop_id, stop_name: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon })),
    ["stop_id","stop_name","stop_lat","stop_lon"]
  ));
  zip.file("routes.txt", csvify(payload.routes, ["route_id","route_short_name","route_long_name","route_type","agency_id"]));
  zip.file("calendar.txt", csvify(payload.services, ["service_id","monday","tuesday","wednesday","thursday","friday","saturday","sunday","start_date","end_date"]));
  zip.file("trips.txt", csvify(payload.trips, ["route_id","service_id","trip_id","trip_headsign","shape_id","direction_id"]));
  zip.file("stop_times.txt", csvify(filteredStopTimes, ["trip_id","arrival_time","departure_time","stop_id","stop_sequence"]));
  zip.file("shapes.txt", csvify(
    payload.shapePts.map(p => ({ shape_id: p.shape_id, shape_pt_lat: p.lat, shape_pt_lon: p.lon, shape_pt_sequence: p.seq })),
    ["shape_id","shape_pt_lat","shape_pt_lon","shape_pt_sequence"]
  ));

  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, "gtfs.zip");
}

/** ---------- Map bits ---------- */
function AddStopOnClick({ onAdd, onTooFar }: { onAdd: (latlng: { lat: number; lng: number }) => void; onTooFar: () => void }) {
  const map = useMap();
  useMapEvents({
    click(e) {
      const z = map.getZoom();
      if (z >= MIN_ADD_ZOOM) onAdd(e.latlng);
      else onTooFar();
    }
  });
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
function looksAdvanced(q: string) { return /(&&|\|\||==|!=|>=|<=|>|<|~=|!~=)/.test(q); }
function tryNumber(v: string) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function normalizeValue(raw: any): string { return raw == null ? "" : String(raw); }
function parseValueToken(tok: string): string {
  const t = tok.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
type Cond = { field: string; op: string; value: string };
function splitByLogical(expr: string): string[][] {
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

/** ---------- Generic table ---------- */
function PaginatedEditableTable<T extends Record<string, any>>({
  title, rows, onChange,
  visibleIndex,
  initialPageSize = 5,
  onRowClick,
  selectedPredicate,
  selectedIcon = "✓",
  clearSignal = 0,
  onIconClick,
  selectOnCellFocus = false, // NEW: focusing a cell selects the row
}: {
  title: string;
  rows: T[];
  onChange: (next: T[]) => void;
  visibleIndex?: number[];
  initialPageSize?: 5|10|20|50|100;
  onRowClick?: (row: T) => void;
  selectedPredicate?: (row: T) => boolean;
  selectedIcon?: string;
  clearSignal?: number;
  onIconClick?: (row: T) => void;
  selectOnCellFocus?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<5|10|20|50|100>(initialPageSize);
  const [query, setQuery] = useState("");

  useEffect(() => { setQuery(""); setPage(1); }, [clearSignal]);

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
          <table style={{ width: "100%", fontSize: 13, minWidth: 820 }}>
            <thead>
              <tr>
                {!!selectedPredicate && <th style={{ width: 28 }}></th>}
                {cols.map(c => <th key={c} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {pageIdx.length ? pageIdx.map((gi) => {
                const r = rows[gi];
                const isSelected = selectedPredicate ? selectedPredicate(r) : false;
                return (
                  <tr
                    key={gi}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    style={{
                      cursor: onRowClick ? "pointer" : "default",
                      background: isSelected ? "rgba(232, 242, 255, 0.7)" : "transparent",
                      outline: isSelected ? "2px solid #7db7ff" : "none",
                      outlineOffset: -2
                    }}
                  >
                    {!!selectedPredicate && (
                      <td style={{ borderBottom: "1px solid #f3f3f3", padding: 4, textAlign: "center" }}>
                        {isSelected ? (
                          <button
                            title="Deselect"
                            onClick={(e) => { e.stopPropagation(); onIconClick && onIconClick(r); }}
                            style={{ border:"none", background:"transparent", cursor:"pointer", fontSize:14 }}
                          >
                            ✓
                          </button>
                        ) : ""}
                      </td>
                    )}
                    {cols.map(c => (
                      <td key={c} style={{ borderBottom: "1px solid #f3f3f3", padding: 4 }}>
                        <input
                          value={(r as any)[c] ?? ""}
                          onFocus={selectOnCellFocus && onRowClick ? () => onRowClick(r) : undefined}
                          onChange={e => edit(gi, c, e.target.value)}
                          // keep click propagation so full-row select still works when you click into inputs
                          style={{ width: "100%", outline: "none", border: "1px solid #e8e8e8", padding: "4px 6px", borderRadius: 8, background: "white" }}
                        />
                      </td>
                    ))}
                  </tr>
                );
              }) : (
                <tr><td colSpan={(selectedPredicate ? 1 : 0) + Math.max(1, cols.length)} style={{ padding: 12, opacity: .6 }}>No rows.</td></tr>
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

/** ---------- Pattern helpers ---------- */
function isSubsequence(small: string[], big: string[]) {
  if (!small.length) return true;
  let i = 0;
  for (const x of big) {
    if (x === small[i]) { i++; if (i === small.length) return true; }
  }
  return false;
}

/** ---------- Tiny chip ---------- */
function ServiceChip({
  svc, onToggle, active,
  days, range,
}: {
  svc: string; active: boolean; onToggle: () => void;
  days?: { mo:number; tu:number; we:number; th:number; fr:number; sa:number; su:number };
  range?: { start: string; end: string };
}) {
  const dayStr = days
    ? ["M","T","W","T","F","S","S"].map((d, i) => {
        const on = [days.mo,days.tu,days.we,days.th,days.fr,days.sa,days.su][i] ? 1 : 0;
        return `<span style="opacity:${on?1:.3}">${d}</span>`;
      }).join("")
    : "";
  const dateStr = range ? `${range.start.slice(4,6)}/${range.start.slice(6)}–${range.end.slice(4,6)}/${range.end.slice(6)}` : "";
  return (
    <button
      className="chip"
      onClick={onToggle}
      title={`service_id ${svc}`}
      style={{
        padding: "2px 6px",
        borderRadius: 999,
        border: "1px solid #e1e5ea",
        background: active ? "#e8f2ff" : "#fff",
        fontSize: 11,
        lineHeight: 1.2,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer"
      }}
    >
      <span style={{ fontWeight: 600 }}>{svc}</span>
      <span dangerouslySetInnerHTML={{ __html: dayStr }} />
      <span style={{ opacity: .6 }}>{dateStr}</span>
    </button>
  );
}

/** ---------- PATTERN VIEW (Excel-like) ---------- */
function PatternMatrix({
  route,
  trips,
  stops,
  stopTimes,
  services,
  activeServiceIds,
  onEditTime,
  onDeleteStopRow,
}: {
  route: RouteRow;
  trips: Trip[];
  stops: Stop[];
  stopTimes: StopTime[];
  services: Service[];
  activeServiceIds: Set<string>;
  onEditTime: (trip_id: string, stop_id: string, newTime: string) => void;
  onDeleteStopRow: (stop_id: string, affectedTripIds: string[]) => void;
}) {
  const stopName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of stops) m.set(s.stop_id, s.stop_name);
    return m;
  }, [stops]);

  const serviceById = useMemo(() => {
    const m = new Map<string, Service>();
    for (const s of services) m.set(s.service_id, s);
    return m;
  }, [services]);

  function daysString(svc?: Service) {
    if (!svc) return "";
    const flags = [svc.monday,svc.tuesday,svc.wednesday,svc.thursday,svc.friday,svc.saturday,svc.sunday];
    const chars = ["M","T","W","T","F","S","S"];
    return chars.map((c,i)=> flags[i] ? c : "·").join("");
  }

  function ymdDashed(yyyymmdd?: string) {
    if (!yyyymmdd || yyyymmdd.length !== 8) return "";
    return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
  }

  const stByTrip = useMemo(() => {
    const m = new Map<string, StopTime[]>();
    for (const st of stopTimes) {
      const arr = m.get(st.trip_id) ?? [];
      arr.push(st);
      m.set(st.trip_id, arr);
    }
    for (const [k, arr] of m) {
      arr.sort((a, b) => num(a.stop_sequence) - num(b.stop_sequence));
      m.set(k, arr);
    }
    return m;
  }, [stopTimes]);

  const seqByTrip = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of trips) {
      const seq: string[] = [];
      const seen = new Set<string>();
      const arr = stByTrip.get(t.trip_id) ?? [];
      for (const r of arr) {
        const sid = r.stop_id;
        if (!seen.has(sid)) { seen.add(sid); seq.push(sid); }
      }
      m.set(t.trip_id, seq);
    }
    return m;
  }, [trips, stByTrip]);

  const reps = useMemo(() => {
    const uniq: string[][] = [];
    for (const t of trips) {
      const s = seqByTrip.get(t.trip_id) ?? [];
      if (!uniq.some(u => u.length === s.length && u.every((x, i) => x === s[i]))) uniq.push(s);
    }
    const out: string[][] = [];
    for (const s of uniq) {
      let sub = false;
      for (const t of uniq) { if (s === t) continue; if (isSubsequence(s, t)) { sub = true; break; } }
    if (!sub) out.push(s);
    }
    return out.length ? out : uniq;
  }, [trips, seqByTrip]);

  const depMapByTrip = useMemo(() => {
    const m = new Map<string, Map<string, string>>();
    for (const t of trips) {
      const inner = new Map<string, string>();
      const rows = stByTrip.get(t.trip_id) ?? [];
      for (const r of rows) {
        const time = (r.departure_time && String(r.departure_time)) || (r.arrival_time && String(r.arrival_time)) || "";
        inner.set(r.stop_id, time);
      }
      m.set(t.trip_id, inner);
    }
    return m;
  }, [trips, stByTrip]);

  const headerFor = (t: Trip) => {
  const svc = serviceById.get(t.service_id);
  const days = daysString(svc);
  const range = svc ? `${ymdDashed(svc.start_date)}/${ymdDashed(svc.end_date)}` : "";
  return (
    <div style={{lineHeight:1.15, whiteSpace:"normal"}}>
      <div style={{fontWeight:700}}>{t.trip_id}</div>
      <div>{t.service_id}</div>
      <div style={{opacity:.7}}>
        {days || range ? `(${[days, range].filter(Boolean).join(" ")})` : ""}
      </div>
    </div>
  );
};

  const PatternBlock = ({ idx, seq, groupTrips }: { idx: number; seq: string[]; groupTrips: Trip[] }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [colOrder, setColOrder] = useState<string[] | null>(null);

    if (!seq.length || !groupTrips.length) return null;
    const first = seq[0];

    const filteredTrips = useMemo(
      () => groupTrips.filter(t => activeServiceIds.size ? activeServiceIds.has(t.service_id) : true),
      [groupTrips, activeServiceIds]
    );

    const baseSortedIds = useMemo(() => {
      const firstTimes = new Map<string, string>(); // trip_id -> HH:MM:SS or ""
      for (const t of filteredTrips) {
        const tm = depMapByTrip.get(t.trip_id)?.get(first) ?? "";
        firstTimes.set(t.trip_id, tm);
      }
      const ids = filteredTrips.map(t => t.trip_id);
      ids.sort((a, b) => {
        const ta = filteredTrips.find(t => t.trip_id === a)!;
        const tb = filteredTrips.find(t => t.trip_id === b)!;

        // 1) by service_id (string compare)
        if (ta.service_id !== tb.service_id) return ta.service_id.localeCompare(tb.service_id);

        // 2) by first departure time (empty times last)
        const fa = firstTimes.get(a) ?? "";
        const fb = firstTimes.get(b) ?? "";
        if (fa === "" && fb === "") return a.localeCompare(b);
        if (fa === "") return 1;
        if (fb === "") return -1;
        if (fa !== fb) return fa.localeCompare(fb);

        // 3) tie-breaker by trip_id
        return a.localeCompare(b);
      });
      return ids;
    }, [filteredTrips, depMapByTrip, first]);

    useEffect(() => { if (!isEditing) setColOrder(baseSortedIds); }, [isEditing, baseSortedIds]);

    let orderedTrips = useMemo(() => {
      const order = colOrder ?? [];
      const idxMap = new Map(order.map((id, i) => [id, i]));
      return filteredTrips.slice().sort((ta, tb) => (idxMap.get(ta.trip_id)! - idxMap.get(tb.trip_id)!));
    }, [filteredTrips, colOrder]);

    if (!isEditing) {
      orderedTrips = orderedTrips.filter(t => {
        const times = seq.map(sid => depMapByTrip.get(t.trip_id)?.get(sid));
        return isMonotonicNonDecreasing(times);
      });
      if (!orderedTrips.length) return null;
    }

    const TimeCell = ({ tripId, stopId }: { tripId: string; stopId: string }) => {
      const source = depMapByTrip.get(tripId)?.get(stopId) ?? "";
      const [draft, setDraft] = useState(uiFromGtfs(source));
      useEffect(() => { setDraft(uiFromGtfs(source)); }, [source]);

      const commit = () => {
        const gtfs = gtfsFromUi(draft); // "" allowed
        onEditTime(tripId, stopId, gtfs);
      };

      return (
        <input
          value={draft}
          onFocus={() => setIsEditing(true)}
          onBlur={() => { setIsEditing(false); commit(); }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } }}
          placeholder="HH:MM"
          style={{ width: 90, border: "1px solid #e8e8e8", padding: "3px 6px", borderRadius: 8 }}
        />
      );
    };

    const DeleteRowBtn = ({ stopId }: { stopId: string }) => (
      <button
        title="Delete stop from these trips"
        onClick={() => onDeleteStopRow(stopId, orderedTrips.map(t => t.trip_id))}
        style={{ border: "none", background: "transparent", cursor: "pointer", marginRight: 6 }}
      >🗑</button>
    );

    return (
      <div className="card section" style={{ marginTop: 10, borderColor: "#e9eef3" }}>
        <div className="card-body">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <h3 style={{ margin: 0 }}>
              Pattern p{idx} · {stopName.get(seq[0]) ?? seq[0]} → {stopName.get(seq[seq.length - 1]) ?? seq[seq.length - 1]}
              <span style={{ marginLeft: 8, fontSize: 12, opacity: .6 }}>({seq.length} stops · {orderedTrips.length} trips)</span>
            </h3>
          </div>

          <div className="overflow-auto" style={{ borderRadius: 12, border: "1px solid #eee", marginTop: 8 }}>
            <table style={{ width: "100%", fontSize: 13, minWidth: 940 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee", width: 32 }}></th>
                  <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee", width: 180 }}>stop_id</th>
                  <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee", width: 260 }}>stop_name</th>
                  {orderedTrips.map(t => (
                    <th key={t.trip_id} style={{ textAlign:"left", padding:8, borderBottom:"1px solid #eee", minWidth:150 }}>
                      {headerFor(t)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {seq.map((sid) => (
                  <tr key={sid}>
                    <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6, textAlign: "center" }}>
                      <DeleteRowBtn stopId={sid} />
                    </td>
                    <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}><code>{sid}</code></td>
                    <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{stopName.get(sid) ?? ""}</td>
                    {orderedTrips.map(t => (
                      <td key={t.trip_id} style={{ borderBottom: "1px solid #f3f3f3", padding: 6, whiteSpace: "nowrap" }}>
                        <TimeCell tripId={t.trip_id} stopId={sid} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </div>
      </div>
    );
  };

  const blocks = [];
  let pIndex = 1;
  for (let i = 0; i < reps.length; i++) {
    const seq = reps[i];
    const groupTrips = trips.filter(t => {
      const s = seqByTrip.get(t.trip_id) ?? [];
      return isSubsequence(s, seq);
    });
    if (!groupTrips.length || !seq.length) continue;
    blocks.push(<PatternBlock key={`p${i}`} idx={pIndex++} seq={seq} groupTrips={groupTrips} />);
  }

  if (!blocks.length) return (
    <div className="card section" style={{ marginTop: 12 }}>
      <div className="card-body">
        <h3 style={{ margin: 0 }}>Patterns</h3>
        <p style={{ opacity: .7, marginTop: 6 }}>No trips/stop_times available for this route (or all trips filtered / non-monotonic).</p>
      </div>
    </div>
  );

  return (
    <div className="card section" style={{ marginTop: 12 }}>
      <div className="card-body">
        <h2 style={{ marginTop: 0 }}>Excel-like Patterns for route <code>{route.route_id}</code></h2>
        {blocks}
      </div>
    </div>
  );
}

/** ---------- App ---------- */
export default function App() {
  /** Leaflet icons */
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
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);

  /** Filters / clearing */
  const [activeServiceIds, setActiveServiceIds] = useState<Set<string>>(new Set());
  const [clearSignal, setClearSignal] = useState(0);

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
    const numStr = (stops.length + 1).toString().padStart(3, "0");
    setStops([...stops, { uid: uuidv4(), stop_id: `S_${numStr}`, stop_name: `${base} ${numStr}`, stop_lat: latlng.lat, stop_lon: latlng.lng }]);
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
          direction_id: r.direction_id != null ? String(r.direction_id) : undefined,
        })));
      }
      if (tables["stop_times"]) {
        setStopTimes(parse(tables["stop_times"]).map((r: any) => ({
          trip_id: String(r.trip_id ?? ""), arrival_time: String(r.arrival_time ?? ""),
          departure_time: String(r.departure_time ?? ""), stop_id: String(r.stop_id ?? ""),
          stop_sequence: r.stop_sequence ?? 0,
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

  /** ---------- Derived maps for map drawing ---------- */
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
    for (const [k, arr] of m) m.set(k, arr.slice().sort((a,b)=>num(a.stop_sequence)-num(b.stop_sequence)));
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

  /** ---------- Selection & ordering ---------- */
  const routesVisibleIdx = useMemo(() => {
    const idxs = routes.map((_, i) => i);
    if (!selectedRouteId) return idxs;
    const selIdx = routes.findIndex(r => r.route_id === selectedRouteId);
    if (selIdx < 0) return idxs;
    return [selIdx, ...idxs.filter(i => i !== selIdx)];
  }, [routes, selectedRouteId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setSelectedRouteId(null); setSelectedStopId(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    setSelectedStopId(null);
    setActiveServiceIds(new Set());
    setClearSignal(x => x + 1);
  };

  /** Edit a time (updates stop_times), store HH:MM:00 or "" */
  const handleEditTime = (trip_id: string, stop_id: string, newTime: string) => {
    setStopTimes(prev => {
      const next = prev.map(r => ({ ...r }));

      // Blank time: don't create rows; if exists, blank BOTH arrival & departure
      if (!newTime || !newTime.trim()) {
        for (const r of next) {
          if (r.trip_id === trip_id && r.stop_id === stop_id) {
            r.departure_time = "";
            r.arrival_time = "";
            return next;
          }
        }
        return next;
      }

      // Non-empty time
      let found = false;
      for (const r of next) {
        if (r.trip_id === trip_id && r.stop_id === stop_id) {
          r.departure_time = newTime;
          if (!r.arrival_time) r.arrival_time = newTime;
          found = true;
          break;
        }
      }
      if (!found) {
        const seqs = next.filter(r => r.trip_id === trip_id).map(r => num(r.stop_sequence, 0));
        const newSeq = (seqs.length ? Math.max(...seqs) : 0) + 1;
        next.push({ trip_id, stop_id, departure_time: newTime, arrival_time: newTime, stop_sequence: newSeq });
      }
      return next;
    });
  };

  /** Delete an entire stop row from selected pattern block */
  const handleDeleteStopRow = (stop_id: string, affectedTripIds: string[]) => {
    if (!confirm(`Remove stop ${stop_id} from ${affectedTripIds.length} trip(s)?`)) return;
    setStopTimes(prev => prev.filter(st => !(st.stop_id === stop_id && affectedTripIds.includes(st.trip_id))));
  };

  /** Delete selected route (and its trips/stop_times/shapes) */
  const deleteSelectedRoute = () => {
    if (!selectedRouteId) return;
    if (!confirm(`Delete route ${selectedRouteId}? This removes its trips, stop_times, and shapes.`)) return;
    const rid = selectedRouteId;
    const remainingTrips = trips.filter(t => t.route_id !== rid);
    const remainingTripIds = new Set(remainingTrips.map(t => t.trip_id));
    setTrips(remainingTrips);
    setStopTimes(prev => prev.filter(st => remainingTripIds.has(st.trip_id)));
    setShapePts(prev => {
      const keptShapeIds = new Set(remainingTrips.map(t => t.shape_id).filter(Boolean) as string[]);
      return prev.filter(s => keptShapeIds.has(s.shape_id));
    });
    setRoutes(prev => prev.filter(r => r.route_id !== rid));
    setSelectedRouteId(null);
  };

  /** Delete selected stop (from stops + all stop_times) */
  const deleteSelectedStop = () => {
    if (!selectedStopId) return;
    if (!confirm(`Delete stop ${selectedStopId}? This removes it from stops and all stop_times.`)) return;
    const sid = selectedStopId;
    setStops(prev => prev.filter(s => s.stop_id !== sid));
    setStopTimes(prev => prev.filter(st => st.stop_id !== sid));
    setSelectedStopId(null);
  };

  /** ---------- Render ---------- */
  return (
    <div className="container" style={{ padding: 16 }}>
      <style>{`
        /* grayscale tiles only when a route is selected */
        .map-shell.bw .leaflet-tile { filter: grayscale(1) contrast(1.05) brightness(1.0); }

        /* robust pulsating halo */
        .route-halo-pulse {
          animation: haloPulse 1.8s ease-in-out infinite !important;
          filter: drop-shadow(0 0 4px rgba(255,255,255,0.9));
          stroke: #ffffff !important;
          stroke-linecap: round !important;
        }

        @keyframes haloPulse {
          0%   { stroke-opacity: 0.65 !important; stroke-width: 10px !important; }
          50%  { stroke-opacity: 0.20 !important; stroke-width: 16px !important; }
          100% { stroke-opacity: 0.65 !important; stroke-width: 10px !important; }
        }
      `}</style>

      <h1>GTFS Builder · V1 + Editor · Excel-like patterns</h1>

      {banner && (
        <div
          className={`banner ${banner.kind === "error" ? "banner-error" : banner.kind === "success" ? "banner-success" : "banner-info"}`}
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
              <button className="btn" onClick={() => setSelectedRouteId(null)} title="Deselect (Esc)">×</button>
              <button className="btn btn-danger" onClick={deleteSelectedRoute} title="Delete this route">Delete route</button>
            </div>
          )}

          {selectedStopId && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff4f4", padding: "6px 10px", borderRadius: 10 }}>
              Selected stop: <b>{selectedStopId}</b>
              <button className="btn" onClick={() => setSelectedStopId(null)} title="Deselect stop">×</button>
              <button className="btn btn-danger" onClick={deleteSelectedStop} title="Delete this stop">Delete stop</button>
            </div>
          )}

          <button className="btn" onClick={() => { setSelectedRouteId(null); setSelectedStopId(null); setActiveServiceIds(new Set()); setClearSignal(x => x + 1); }}>
            Clear filters & selection
          </button>

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
          <button className="btn" onClick={() => {
            const res = validateFeed({ agencies, stops, routes, services, trips, stopTimes, shapePts });
            setValidation(res);
            setBanner(res.errors.length ? { kind: "error", text: `Validation found ${res.errors.length} errors and ${res.warnings.length} warnings.` }
                                        : { kind: "success", text: res.warnings.length ? `Validation OK with ${res.warnings.length} warnings.` : "Validation OK." });
            setTimeout(() => setBanner(null), 3200);
          }}>Validate</button>

          <button className="btn btn-danger" onClick={resetAll}>Reset</button>
        </div>
      </div>

      {/* Map */}
      <div className="card section">
        <div className="card-body">
          <div className={`map-shell ${selectedRouteId ? "bw" : ""} ${drawMode ? "is-drawing" : ""}`} style={{ height: 520, width: "100%", borderRadius: 12, overflow: "hidden", position: "relative" }}>
            <MapContainer center={[40.4168, -3.7038]} zoom={6} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution="© OpenStreetMap contributors"
            />

            {/* Declare panes ONCE */}
            <Pane name="routeHalo" style={{ zIndex: 390 }} />
            <Pane name="routeLines" style={{ zIndex: 400 }} />
            <Pane name="stopsTop"  style={{ zIndex: 650 }} />

            {!drawMode && (
              <AddStopOnClick
                onAdd={addStopFromMap}
                onTooFar={() => setBanner({ kind: "info", text: `Zoom in to at least ${MIN_ADD_ZOOM} to add stops.` })}
              />
            )}
            {drawMode && <DrawShapeOnClick onPoint={() => {}} onFinish={() => setDrawMode(false)} />}

            {/* STOPS — render directly, just set pane="stopsTop" */}
            {stops.map(s => (
              <CircleMarker
                key={s.uid}
                center={[s.stop_lat, s.stop_lon]}
                pane="stopsTop"
                radius={selectedRouteId ? 3.5 : 3}
                color={selectedStopId === s.stop_id ? "#e11d48" : "#111"}
                weight={1.5}
                fillColor="#fff"
                fillOpacity={1}
                eventHandlers={{ click: () => setSelectedStopId(s.stop_id) }}
              />
            ))}

            {/* ROUTES — lines in routeLines; halo in routeHalo */}
            {Array.from(routePolylines.entries()).map(([route_id, coords]) => {
              const isSel = selectedRouteId === route_id;
              const hasSel = !!selectedRouteId;

              const color   = hasSel ? (isSel ? routeColor(route_id) : DIM_ROUTE_COLOR) : routeColor(route_id);
              const weight  = isSel ? 6 : 3;
              const opacity = hasSel ? (isSel ? 0.95 : 0.6) : 0.95;

              return (
                <div key={route_id}>
                  {isSel && (
                    <Polyline
                      positions={coords as any}
                      pane="routeHalo"
                      className="route-halo-pulse"                 // <-- add this
                      pathOptions={{ color: "#ffffff", weight: 10, opacity: 0.9, lineCap: "round" }}
                      eventHandlers={{ click: () => setSelectedRouteId(route_id) }}
                    />
                  )}
                  <Polyline
                    positions={coords as any}
                    pane="routeLines"
                    pathOptions={{ color, weight, opacity }}
                    eventHandlers={{ click: () => setSelectedRouteId(route_id) }}
                  />
                </div>
              );
            })}
          </MapContainer>
          </div>
        </div>
      </div>

      {/* routes.txt — selected route appears FIRST; click any field selects; ✓ deselects */}
      <PaginatedEditableTable
        title="routes.txt"
        rows={routes}
        onChange={setRoutes}
        visibleIndex={routesVisibleIdx}
        initialPageSize={10}
        onRowClick={(r) => setSelectedRouteId((r as RouteRow).route_id)}
        selectedPredicate={(r) => (r as RouteRow).route_id === selectedRouteId}
        selectedIcon="✓"
        clearSignal={clearSignal}
        onIconClick={() => setSelectedRouteId(null)}
        selectOnCellFocus // <— clicking/focusing any cell selects that route
      />

      {/* Service chips */}
      {selectedRouteId && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
          <span style={{ fontSize: 12, opacity: .7, marginRight: 4 }}>Services in route:</span>
          {Array.from(new Set((tripsByRoute.get(selectedRouteId) ?? []).map(t => t.service_id)))
            .sort()
            .map(sid => {
              const svc = services.find(s => s.service_id === sid);
              const active = activeServiceIds.has(sid);
              return (
                <ServiceChip
                  key={sid}
                  svc={sid}
                  active={active}
                  onToggle={() => {
                    setActiveServiceIds(prev => {
                      const next = new Set(prev);
                      if (next.has(sid)) next.delete(sid); else next.add(sid);
                      return next;
                    });
                  }}
                  days={svc ? {
                    mo: svc.monday, tu: svc.tuesday, we: svc.wednesday, th: svc.thursday, fr: svc.friday, sa: svc.saturday, su: svc.sunday
                  } : undefined}
                  range={svc ? { start: svc.start_date || "", end: svc.end_date || "" } : undefined}
                />
              );
            })}
          <button
            className="btn"
            onClick={() => setActiveServiceIds(new Set())}
            title="Clear service filters"
            style={{ padding: "2px 8px", fontSize: 11, height: 22 }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Patterns for selected route */}
      {selectedRouteId ? (
        <PatternMatrix
          route={routes.find(r => r.route_id === selectedRouteId)!}
          trips={(tripsByRoute.get(selectedRouteId) ?? [])}
          stops={stops}
          stopTimes={stopTimes.filter(st => (tripsByRoute.get(selectedRouteId) ?? []).some(t => t.trip_id === st.trip_id))}
          services={services}
          activeServiceIds={activeServiceIds}
          onEditTime={(trip_id, stop_id, newUiTime) => handleEditTime(trip_id, stop_id, gtfsFromUi(newUiTime))}
          onDeleteStopRow={handleDeleteStopRow}
        />
      ) : (
        <div className="card section" style={{ marginTop: 12 }}>
          <div className="card-body">
            <h3 style={{ margin: 0 }}>Select a route to view Excel-like patterns</h3>
            <p style={{ opacity: .7, marginTop: 6 }}>Click a polyline on the map or any cell in <strong>routes.txt</strong>. Press <kbd>Esc</kbd> to deselect.</p>
          </div>
        </div>
      )}

      {/* ---------- OTHER GTFS TABLES (editable) ---------- */}
      <div style={{ marginTop: 12 }}>
        <PaginatedEditableTable
          title="agency.txt"
          rows={agencies}
          onChange={setAgencies}
          initialPageSize={5}
        />
        <PaginatedEditableTable
          title="stops.txt"
          rows={stops.map(s => ({ stop_id: s.stop_id, stop_name: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon }))}
          onChange={(next) => {
            // merge back into stops (keep uid)
            const uidById = new Map(stops.map(s => [s.stop_id, s.uid]));
            setStops(next.map((r: any) => ({
              uid: uidById.get(r.stop_id) || uuidv4(),
              stop_id: r.stop_id, stop_name: r.stop_name, stop_lat: Number(r.stop_lat), stop_lon: Number(r.stop_lon)
            })));
          }}
          initialPageSize={5}
        />
        <PaginatedEditableTable
          title="calendar.txt"
          rows={services}
          onChange={setServices}
          initialPageSize={5}
        />
        <PaginatedEditableTable
          title="trips.txt"
          rows={trips}
          onChange={setTrips}
          initialPageSize={10}
        />
        <PaginatedEditableTable
          title="stop_times.txt"
          rows={stopTimes}
          onChange={setStopTimes}
          initialPageSize={10}
        />
        <PaginatedEditableTable
          title="shapes.txt"
          rows={shapePts.map(s => ({ shape_id: s.shape_id, shape_pt_lat: s.lat, shape_pt_lon: s.lon, shape_pt_sequence: s.seq }))}
          onChange={(next) => {
            setShapePts(next.map((r: any) => ({ shape_id: r.shape_id, lat: Number(r.shape_pt_lat), lon: Number(r.shape_pt_lon), seq: Number(r.shape_pt_sequence) })));
          }}
          initialPageSize={10}
        />
      </div>

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
            Export skips any <code>stop_times</code> row where both arrival and departure are blank.
          </p>
        </div>
      </div>
    </div>
  );
}
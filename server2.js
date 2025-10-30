// server.js
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

let lastResult = null;
const history = [];
const MAX_HISTORY = 200;

const PI_ROOM = "pi";

// --- constants shared with UI logic ---
const BIN_HEIGHT_CM = 80;
const NEAR_TOP_CM = 12;

// ---------------- Socket.IO ----------------
io.on("connection", (socket) => {
  console.log("🔌 client connected:", socket.id);

  socket.on("pi:hello", (info) => {
    console.log("🤝 Pi joined:", info);
    socket.join(PI_ROOM);
    socket.emit("server:ack", { ok: true });
  });

  socket.on("pi:sensors", (payload = {}) => {
    const entry = {
      source: "sio-sensors",
      kind: "sensors",
      bin_id: safeStr(payload.bin_id),
      timestamp: payload.timestamp || new Date().toISOString(),
      sensors: normalizeSensors(payload.sensors || payload),
    };
    storeAndBroadcast(entry);
  });

  socket.on("pi:vision", (payload = {}) => {
    const entry = normalizeClassification("sio-vision", payload);
    storeAndBroadcast(entry);
  });

  if (lastResult) socket.emit("pi:update", lastResult);
  socket.on("disconnect", () => console.log("🔌 client disconnected:", socket.id));
});

// ---------------- Routes (existing) ----------------
app.get("/", (_, res) => res.send("Smart Bin API ✅ (Socket.IO enabled)"));

app.post("/update", (req, res) => {
  const b = req.body || {};
  const isClassification = "label" in b || "recyclable" in b || "override" in b;

  const entry = isClassification
    ? normalizeClassification("http-update", b)
    : {
        source: "http-update",
        kind: "sensors",
        bin_id: safeStr(b.bin_id),
        timestamp: b.timestamp || new Date().toISOString(),
        sensors: normalizeSensors(b.sensors || b),
      };

  storeAndBroadcast(entry);
  return res.json({ ok: true });
});

app.get("/data", (_, res) => res.json({ lastResult, history }));

// Classifications-only history
app.get("/history/classifications", (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 20));
  const items = history
    .filter((e) => e && (e.kind === "classification" || e.label != null || e.recyclable != null))
    .slice(-limit)
    .reverse();
  res.json({ items });
});

app.post("/cmd/:action", (req, res) => {
  const action = String(req.params.action || "").trim();
  if (!action) return res.status(400).json({ ok: false, error: "Missing action" });

  const payload = req.body && Object.keys(req.body).length ? req.body : undefined;
  io.to(PI_ROOM).emit("pi:cmd", { action, payload, ts: Date.now() });
  return res.json({ ok: true, sent: action });
});

app.post("/override", (req, res) => {
  const body = req.body || {};
  const entry = normalizeClassification("web-override", {
    ...body,
    recyclable: "no",
    override: 1,
    timestamp: body.timestamp || new Date().toISOString(),
  });

  io.to(PI_ROOM).emit("pi:cmd", { action: "override", payload: entry, ts: Date.now() });
  return res.json({ ok: true });
});

// ---------------- New: Company admin page ----------------

// Serve the company dashboard HTML
app.get("/company", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "company.html"))
);

// Latest status per bin (for the Live Bin Status table)
app.get("/api/company/bins", (_req, res) => {
  const perBin = latestPerBin(history);
  // You can replace location with a real lookup (GIS/DB). Placeholder for now.
  const rows = Object.values(perBin).map((e) => ({
    bin_id: e.bin_id || "—",
    location: guessedLocation(e.bin_id),
    fill_pct: computeFillPctFromEntry(e),
    deposit: e.label || "—",
    contamination: e.recyclable === "contaminated" ? (e.label || "Contaminated") : (e.recyclable === "no" ? e.label || "—" : "—"),
    timestamp: e.timestamp,
  }));
  res.json({ items: rows.sort((a,b)=> String(a.bin_id).localeCompare(String(b.bin_id))) });
});

// KPI + analytics for charts
app.get("/api/company/summary", (_req, res) => {
  const perBin = latestPerBin(history);
  const items = history.filter(Boolean);

  // Recycling/contamination rates from classification events (last 200)
  const cls = items.filter((e) => e.kind === "classification" || e.recyclable != null);
  const totalCls = cls.length || 1;
  const recycling = cls.filter((e) => e.recyclable === "yes").length / totalCls;
  const contamination = cls.filter((e) => e.recyclable === "contaminated").length / totalCls;

  // Class mix (for the pie)
  const mix = countBy(cls, (e) => (e.label || "Other").toString());
  const mixTop = topN(mix, 4); // group others
  const otherSum = Object.entries(mix)
    .filter(([k]) => !(k in mixTop))
    .reduce((s, [,v]) => s + v, 0);
  if (otherSum) mixTop["Other"] = (mixTop["Other"] || 0) + otherSum;

  // Mis-sorts by weekday (count non-"yes" recyclables as mis-sorts)
  const misSorts = Array(7).fill(0);
  cls.forEach((e) => {
    const d = new Date(e.timestamp || Date.now());
    const isMis = e.recyclable !== "yes";
    if (isMis) misSorts[d.getDay()]++;
  });

  // Predictive: naive time-to-full estimate (median across bins based on fill slope)
  const ttfDays = estimateTimeToFullDays(history, BIN_HEIGHT_CM);

  res.json({
    kpis: {
      recycling_rate: roundPct(recycling),          // 0..1
      contamination_rate: roundPct(contamination),  // 0..1
      collections_per_day: estimateCollectionsPerDay(items),
      time_to_full_days: ttfDays
    },
    mix: mixTop,               // { label: count }
    mis_sorts_by_weekday: misSorts, // 0..6 Sun..Sat
    bins: Object.keys(perBin).length
  });
});

// ---------------- Helpers ----------------
function storeAndBroadcast(entry) {
  if (!entry || !entry.timestamp) return;
  lastResult = entry;
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
  io.emit("pi:update", entry);
}

function normalizeClassification(source, p = {}) {
  const confidence = numOrNull(p.confidence);
  const time_ms = numOrNull(p.time_ms);
  const override = p.override === 1 || p.override === "1" ? 1 : Number(p.override) || 0;
  const recyRaw = (p.recyclable ?? "").toString().trim().toLowerCase();
  const recyclable =
    recyRaw === "yes" || recyRaw === "no" || recyRaw === "contaminated" ? recyRaw : undefined;

  return {
    source,
    kind: "classification",
    bin_id: safeStr(p.bin_id),
    label: safeStr(p.label),
    confidence: isFiniteNum(confidence) ? confidence : null,
    time_ms: isFiniteNum(time_ms) ? time_ms : null,
    timestamp: p.timestamp || new Date().toISOString(),
    recyclable,
    sensors: normalizeSensors(p.sensors) || undefined,
    override,
  };
}

function normalizeSensors(s = {}) {
  const recycleSrc =
    s.recycle || s.recyclable || s.blue || s.comp1 || s["recyclable"] || s["recycle"];
  const generalSrc =
    s.general || s["non-recyclable"] || s.trash || s.black || s.comp2 || s["nonrecycle"];

  const out = {};

  if (recycleSrc && typeof recycleSrc === "object") {
    const u = numOrNull(recycleSrc.ultrasonic ?? recycleSrc.distance ?? recycleSrc.dist);
    const w = numOrNull(recycleSrc.weight);
    out.recycle = {};
    if (isFiniteNum(u)) out.recycle.ultrasonic = u;
    if (isFiniteNum(w)) out.recycle.weight = w;
  }

  if (generalSrc && typeof generalSrc === "object") {
    const u = numOrNull(generalSrc.ultrasonic ?? generalSrc.distance ?? generalSrc.dist);
    const w = numOrNull(generalSrc.weight);
    out.general = {};
    if (isFiniteNum(u)) out.general.ultrasonic = u;
    if (isFiniteNum(w)) out.general.weight = w;
  }

  // legacy flat fallback (single compartment -> map to recycle)
  const uFlat = numOrNull(s.ultrasonic ?? s.distance ?? s.dist);
  const wFlat = numOrNull(s.weight);
  if (!out.recycle && !out.general && (isFiniteNum(uFlat) || isFiniteNum(wFlat))) {
    out.recycle = {};
    if (isFiniteNum(uFlat)) out.recycle.ultrasonic = uFlat;
    if (isFiniteNum(wFlat)) out.recycle.weight = wFlat;
  }

  return out;
}

function safeStr(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
function numOrNull(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.+-Ee]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// ------- Analytics helpers for company page -------
function computeFillPctFromEntry(e) {
  // Prefer recycle ultrasonic, else general
  const u =
    e?.sensors?.recycle?.ultrasonic ??
    e?.sensors?.general?.ultrasonic ??
    null;
  if (!isFiniteNum(u) || BIN_HEIGHT_CM <= 0) return null;
  const d = Math.max(0, Math.min(u, BIN_HEIGHT_CM * 1.25));
  const pct = Math.round((1 - d / BIN_HEIGHT_CM) * 100);
  return Math.max(0, Math.min(100, pct));
}

function latestPerBin(items) {
  const map = {};
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    const id = e.bin_id || "bin-unknown";
    // keep the latest by timestamp
    if (!map[id] || new Date(e.timestamp) > new Date(map[id].timestamp)) {
      map[id] = e;
    }
  }
  return map;
}

function countBy(arr, fn) {
  const m = {};
  arr.forEach((x) => {
    const k = fn(x);
    m[k] = (m[k] || 0) + 1;
  });
  return m;
}
function topN(obj, n) {
  const entries = Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0, n-1);
  const out = {};
  entries.forEach(([k,v]) => (out[k] = v));
  return out;
}
function roundPct(x) {
  return Math.round((x || 0) * 1000) / 1000; // 3dp as fraction
}
function estimateCollectionsPerDay(items) {
  // naive: count times any bin crosses from >=90% to <=20% within 24h window
  // (works with limited history as a soft heuristic)
  let count = 0;
  const perBin = {};
  items.forEach((e) => {
    const id = e.bin_id || "bin-unknown";
    perBin[id] = perBin[id] || [];
    perBin[id].push(e);
  });
  Object.values(perBin).forEach((list) => {
    list.sort((a,b)=> new Date(a.timestamp) - new Date(b.timestamp));
    let lastHigh = null;
    list.forEach((e) => {
      const pct = computeFillPctFromEntry(e);
      if (pct == null) return;
      if (pct >= 90) lastHigh = new Date(e.timestamp);
      if (lastHigh && pct <= 20) {
        const dt = (new Date(e.timestamp) - lastHigh) / 86400000;
        if (dt <= 1.5) count++;
        lastHigh = null;
      }
    });
  });
  // scale to per-day over the span we have (fallback 1 day)
  const spanDays = spanInDays(items);
  return Math.max(0, Math.round((count / Math.max(1, spanDays)) * 10) / 10);
}
function spanInDays(items) {
  if (!items.length) return 1;
  const t = items.map((e)=> new Date(e.timestamp).getTime()).filter(Number.isFinite);
  if (!t.length) return 1;
  const days = (Math.max(...t) - Math.min(...t)) / 86400000;
  return Math.max(1, days);
}
function estimateTimeToFullDays(items, binHeight) {
  // crude: average last known fill% slope per bin; return median days to reach 100%
  const perBin = {};
  items.forEach((e)=> {
    const id = e.bin_id || "bin-unknown";
    perBin[id] = perBin[id] || [];
    perBin[id].push(e);
  });
  const estimates = [];
  Object.values(perBin).forEach((list)=> {
    list.sort((a,b)=> new Date(a.timestamp) - new Date(b.timestamp));
    const pts = list.map((e)=> ({ t: new Date(e.timestamp).getTime()/86400000, y: computeFillPctFromEntry(e) }))
                   .filter(p=> p.y!=null);
    if (pts.length < 2) return;
    // simple slope using first/last
    const dy = pts[pts.length-1].y - pts[0].y;
    const dt = pts[pts.length-1].t - pts[0].t;
    if (dt <= 0) return;
    const slopePerDay = dy / dt; // pct/day
    if (slopePerDay <= 0) return;
    const remain = 100 - pts[pts.length-1].y;
    if (remain <= 0) return;
    estimates.push(remain / slopePerDay);
  });
  if (!estimates.length) return null;
  estimates.sort((a,b)=>a-b);
  return Math.round(estimates[Math.floor(estimates.length/2)] * 10) / 10;
}

// Placeholder location guesser (replace with real DB/GIS)
function guessedLocation(binId) {
  const map = {
    "#102": "Park St. 1",
    "#209": "Elm Ave. 2",
    "#156": "3rd Ave. 3",
    "#248": "Hill Rd. 1",
  };
  return map[String(binId)] || "—";
}

// ---------------- Boot ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Smart Bin running on http://localhost:${PORT}`));

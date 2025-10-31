// server.js
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const readline = require("readline");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

let lastResult = null;
const history = [];
const MAX_HISTORY = 200;

const PI_ROOM = "pi";

// ===================== NEW: simple flat-file "storage" =====================
const BIN_HEIGHT_CM = 75; // distance sensor: 30cm == empty, 0cm == full
const DATA_DIR = path.join(process.cwd(), "data");
const LOG_FILE = path.join(DATA_DIR, "bin_log.jsonl");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "");

// per-bin time series (last 30d) Map<binId, Array<{t:number, distance_cm:number}>>
const binSeries = new Map();

// optional postal mapping (used by /api/bins and snapshot)
const postalMap = new Map(Object.entries({
  "BIN-001": "238895",
  "BIN-002": "178903",
  "BIN-003": "520117",
  "BIN-004": "409051",
  "BIN-005": "069120",
  "BIN-006": "149729",
  "BIN-007": "546080",
  "BIN-008": "310158",
  "BIN-009": "650221",
}));
const idToPostal = (id) => postalMap.get(id) ?? null;

const percentFull = (distance, height = BIN_HEIGHT_CM) => {
  if (!Number.isFinite(distance)) return null;
  const d = Math.max(0, Math.min(distance, height));
  return Math.round((1 - d / height) * 100);
};
const colourFromPct = (pct) => (pct == null ? "gray" : pct >= 90 ? "red" : pct >= 70 ? "orange" : "green");
const stateFromPct = (pct) => (pct == null ? "unknown" : pct >= 90 ? "full" : pct >= 70 ? "getting_full" : "ok");

const tsISO = () => new Date().toISOString();

function getDistanceFromSensors(s) {
  if (!s || typeof s !== "object") return null;
  // prefer recycle ultrasonic, else general ultrasonic, else flat legacy
  const tryNums = [];
  if (s.recycle && typeof s.recycle === "object") tryNums.push(s.recycle.ultrasonic);
  if (s.general && typeof s.general === "object") tryNums.push(s.general.ultrasonic);
  tryNums.push(s.ultrasonic, s.distance, s.dist);
  for (const v of tryNums) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
function appendLog(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  const { id, distance_cm, timestamp } = entry;
  if (!id || !Number.isFinite(distance_cm)) return;
  const t = new Date(timestamp).getTime();
  if (!binSeries.has(id)) binSeries.set(id, []);
  const arr = binSeries.get(id);
  arr.push({ t, distance_cm });
  // keep last 30 days in memory
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}
async function loadLog() {
  const rl = readline.createInterface({
    input: fs.createReadStream(LOG_FILE),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.id && Number.isFinite(row.distance_cm) && row.timestamp) {
        appendLog(row); // reuse to populate the in-memory series
      }
    } catch { /* ignore bad lines */ }
  }
}
loadLog();



// ============================ Socket.IO ====================================
io.on("connection", (socket) => {
  console.log("🔌 client connected:", socket.id);

  socket.on("pi:hello", (info) => {
    console.log("🤝 Pi joined:", info);
    socket.join(PI_ROOM);
    socket.emit("server:ack", { ok: true });
  });

  // Sensors tick (supports nested recycle/general or flat)
  socket.on("pi:sensors", (payload = {}) => {
    const entry = {
      source: "sio-sensors",
      kind: "sensors",
      bin_id: safeStr(payload.bin_id),
      timestamp: payload.timestamp || tsISO(),
      sensors: normalizeSensors(payload.sensors || payload),
    };
    storeAndBroadcast(entry);
  });

  // Vision/classification
  socket.on("pi:vision", (payload = {}) => {
    const entry = normalizeClassification("sio-vision", payload);
    storeAndBroadcast(entry);
  });

  if (lastResult) socket.emit("pi:update", lastResult);
  socket.on("disconnect", () => console.log("🔌 client disconnected:", socket.id));
});

// =============================== Routes =====================================
app.get("/", (_, res) => res.send("Smart Bin API ✅ (Socket.IO enabled)"));

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Accept HTTP updates (either sensors or classification)
app.post("/update", (req, res) => {
  const b = req.body || {};
  const isClassification = "label" in b || "recyclable" in b || "override" in b;

  const entry = isClassification
    ? normalizeClassification("http-update", b)
    : {
      source: "http-update",
      kind: "sensors",
      bin_id: safeStr(b.bin_id),
      timestamp: b.timestamp || tsISO(),
      sensors: normalizeSensors(b.sensors || b),
    };

  storeAndBroadcast(entry);
  return res.json({ ok: true });
});

app.get("/data", (_, res) => res.json({ lastResult, history }));
app.get("/data.csv", (_, res) => {
  try {
    if (!history.length) {
      return res.status(200).send("No data available\n");
    }

    const rows = [];
    const headers = [
      "source", "kind", "bin_id", "label", "confidence", "time_ms",
      "timestamp", "recyclable", "override", "id",
      "recycle_ultrasonic", "general_ultrasonic", "weight"
    ];
    rows.push(headers.join(","));

    for (const e of history) {
      const s = e.sensors || {};
      const recycle = s.recycle || {};
      const general = s.general || {};

      const row = [
        e.source ?? "",
        e.kind ?? "",
        e.bin_id ?? "",
        e.label ?? "",
        e.confidence ?? "",
        e.time_ms ?? "",
        e.timestamp ?? "",
        e.recyclable ?? "",
        e.override ?? "",
        e.id ?? "",
        recycle.ultrasonic ?? "",
        general.ultrasonic ?? "",
        e.weight ?? ""
      ].map(v => '"' + String(v).replace(/"/g, '""') + '"');

      rows.push(row.join(","));
    }

    const csv = rows.join("\n");
    res.header("Content-Type", "text/csv");
    res.attachment("smartbin_data.csv");
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating CSV");
  }
});

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
    timestamp: body.timestamp || tsISO(),
  });

  io.to(PI_ROOM).emit("pi:cmd", { action: "override", payload: entry, ts: Date.now() });
  storeAndBroadcast(entry);
  return res.json({ ok: true });
});

// NEW: acknowledge endpoint — tell the Pi and remove the item from history
app.post("/acknowledge", (req, res) => {
  const body = req.body || {};
  const id = safeStr(body.id);
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

  // tell the device
  const payload = {
    id,
    bin_id: safeStr(body.bin_id),
    timestamp: body.timestamp || tsISO(),
  };
  io.to(PI_ROOM).emit("pi:cmd", { action: "acknowledge", payload, ts: Date.now() });

  // remove from history
  const idx = history.findIndex((e) => e && e.id === id);
  if (idx !== -1) history.splice(idx, 1);

  // if it was the lastResult, shift it
  if (lastResult && lastResult.id === id) {
    lastResult = history[history.length - 1] || null;
  }

  return res.json({ ok: true, removed: id });
});

app.get("/company", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "company-admin.html"))
);

app.get("/dashboard/data", (req, res) => {
  try {
    const hoursParam = Number(req.query.hours);
    const hours = Math.max(1, Math.min(24 * 30, Number.isFinite(hoursParam) ? hoursParam : 168));

    // CSV helpers
    function esc(v) {
      const s = v == null ? "" : String(v);
      return '"' + s.replace(/"/g, '""') + '"';
    }

    const headers = [
      "kind",          // snapshot | history
      "bin_id",
      "postal_code",
      "timestamp_iso",
      "percent_full",
      "distance_cm"
    ];

    const rows = [];
    rows.push(headers.map(esc).join(","));

    for (const binId of PREGEN_BINS) {
      const series = getOrGenerateHistory(binId, hours) || [];
      const postal = idToPostal(binId) || "";

      // Snapshot (latest point)
      const last = series.length ? series[series.length - 1] : null;
      if (last) {
        const dist = Math.round(BIN_HEIGHT_CM * (1 - last.percent_full / 100));
        rows.push([
          "snapshot",
          binId,
          postal,
          last.timestamp,
          last.percent_full,
          dist
        ].map(esc).join(","));
      } else {
        rows.push([
          "snapshot",
          binId,
          postal,
          "",
          "",
          ""
        ].map(esc).join(","));
      }

      // History rows
      for (const pt of series) {
        const dist = Math.round(BIN_HEIGHT_CM * (1 - pt.percent_full / 100));
        rows.push([
          "history",
          binId,
          postal,
          pt.timestamp,
          pt.percent_full,
          dist
        ].map(esc).join(","));
      }
    }

    const csv = rows.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=smartbin_pregen_and_history_${hours}h.csv`);
    res.status(200).send(csv);
  } catch (err) {
    console.error("Error generating /dashboard/data CSV:", err);
    res.status(500).json({ ok: false, error: "Failed to generate CSV" });
  }
});


// =================== Bins: demo + live merge + predictions ==================

// --- PREGEN bins we want to simulate ---
const PREGEN_BINS = [
  "BIN-001", "BIN-002", "BIN-003", "BIN-004", "BIN-005",
  "BIN-006", "BIN-007", "BIN-008", "BIN-009"
];

// Simulated historical + predicted data
const BIN_HISTORY = {}; // In-memory cache: { [binId]: Array<{timestamp, percent_full}> }

// Tunables for simulation realism
const HOURS_DEFAULT = 72;           // generate 72h by default
const EMPTY_THRESHOLD = 85;         // when >= this, more likely to be emptied
const EMPTY_PROB_HIGH = 0.15;       // probability per hour to empty when above threshold
const EMPTY_PROB_LOW = 0.01;        // probability per hour to empty when below threshold
const RESET_MIN = 5;                // % full after empty
const RESET_MAX = 20;               // % full after empty
const DRIFT_MIN = 0.2;              // typical fill rate per hour (min)
const DRIFT_MAX = 2.0;              // typical fill rate per hour (max)
const NOISE = 0.8;                  // random noise amplitude (+/-)

// Generate (or extend) history for the last `hours` hours with possible emptying events
function getOrGenerateHistory(binId, hours = HOURS_DEFAULT) {
  const now = Date.now();

  // If we already have some history, extend it to cover the requested window.
  let arr = BIN_HISTORY[binId] || [];

  const haveFrom = arr.length ? new Date(arr[0].timestamp).getTime() : null;
  const wantFrom = now - hours * 3600 * 1000;

  // If cache exists but does not go far enough back, regenerate from scratch for simplicity.
  if (!arr.length || (haveFrom != null && haveFrom - wantFrom > 6 * 3600 * 1000)) {

    arr = [];
    // Start between 10–60%
    let pct = Math.random() * 50 + 10;

    for (let i = hours - 1; i >= 0; i--) {
      const t = new Date(now - i * 3600 * 1000);

      // probability of emptying this hour
      const pEmpty = pct >= EMPTY_THRESHOLD ? EMPTY_PROB_HIGH : EMPTY_PROB_LOW;
      if (Math.random() < pEmpty) {
        // emptied (collection happened)
        pct = rand(RESET_MIN, RESET_MAX);
      } else {
        // normal filling with noise
        const drift = rand(DRIFT_MIN, DRIFT_MAX);       // base increase per hour
        const noise = rand(-NOISE, NOISE);              // jitter
        pct = clamp(pct + drift + noise, 0, 100);
      }

      arr.push({
        timestamp: t.toISOString(),
        percent_full: Math.round(pct),
      });
    }
    BIN_HISTORY[binId] = arr;
  } else {
    // We have enough history; just slice to the requested window.
    arr = arr.filter(d => new Date(d.timestamp).getTime() >= wantFrom);
  }

  return arr;
}

// helpers
function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ==== PRE-GENERATE 10 BINS ON START (7 days of hourly history) ====
(async function pregenAll() {
  const HOURS_7D = 24 * 7;
  PREGEN_BINS.forEach(id => {
    getOrGenerateHistory(id, HOURS_7D);
  });
})();

// Simple ingest for sensors if you don't want to go through Socket.IO
app.post("/api/bins/snapshot", (req, res) => {
  const { id, distance_cm, postalCode } = req.body || {};
  if (!id || !Number.isFinite(distance_cm)) {
    return res.status(400).json({ error: "Provide {id, distance_cm}. Optional: postalCode" });
  }
  if (postalCode) postalMap.set(id, String(postalCode));
  const entry = {
    id,
    distance_cm,
    timestamp: tsISO(),
  };
  appendLog(entry); // persist + in-memory series
  // also emit a synthetic sensors event for UI parity
  const sensorsEntry = {
    source: "http-bins-snapshot",
    kind: "sensors",
    bin_id: id,
    timestamp: entry.timestamp,
    sensors: { recycle: { ultrasonic: distance_cm } },
  };
  storeAndBroadcast(sensorsEntry);

  const pct = percentFull(distance_cm);
  return res.json({
    ok: true,
    bin: {
      id,
      postalCode: idToPostal(id),
      distance_cm,
      percent_full: pct,
      colour: colourFromPct(pct),
      state: stateFromPct(pct),
      last_updated: entry.timestamp,
      bin_height_cm: BIN_HEIGHT_CM,
    },
  });
});

// Latest status per bin — now from pre-generated/simulated history
app.get("/api/bins", async (_req, res) => {
  const nowIso = tsISO();

  // Build latest snapshot from our pre-generated/simulated history
  const out = PREGEN_BINS.map(id => {
    const series = getOrGenerateHistory(id, 168);
    const last = series[series.length - 1] || { percent_full: 0, timestamp: nowIso };
    const pct = last.percent_full;
    const dist = Math.round(BIN_HEIGHT_CM * (1 - pct / 100));
    return {
      id,
      postalCode: idToPostal(id),
      distance_cm: dist,
      percent_full: pct,
      colour: colourFromPct(pct),
      state: stateFromPct(pct),
      last_updated: last.timestamp,
      bin_height_cm: BIN_HEIGHT_CM,
    };
  });

  res.json({
    bins: out,
    meta: {
      bin_height_default_cm: BIN_HEIGHT_CM,
      thresholds: { orange_from_pct: 70, red_from_pct: 90 },
      note: "percent_full is simulated and derived from generated history",
    },
  });
});

// Historical data endpoint (shape expected by dashboard)
app.get("/api/bins/:id/history", (req, res) => {
  const binId = req.params.id;
  const hours = Math.max(1, Math.min(24 * 30, Number(req.query.hours ?? 72)));

  const data = getOrGenerateHistory(binId, hours);

  const series = data.map(d => ({
    timeISO: d.timestamp,
    percent_full: d.percent_full,
    distance_cm: Math.round(BIN_HEIGHT_CM * (1 - d.percent_full / 100)),
  }));

  res.json({ id: binId, hours, series });
});

// Predicted data endpoint using Moving Average (now with ETA 100%)
app.get("/api/bins/:id/predict", (req, res) => {
  const binId = req.params.id;
  const hours = Math.max(1, Math.min(240, Number(req.query.hours ?? 72)));
  const hist = getOrGenerateHistory(binId, 72);
  const windowSize = 5; // average over last 5 readings
  const points = [];

  if (hist.length === 0) {
    return res.json({
      id: binId,
      hours,
      points: [],
      slope_per_hr: null,
      eta90_iso: null,
      eta100_iso: null,
    });
  }

  // compute moving average for recent readings
  const movingAvg = [];
  for (let i = 0; i < hist.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = hist.slice(start, i + 1);
    const avg = slice.reduce((s, p) => s + p.percent_full, 0) / slice.length;
    movingAvg.push(avg);
  }

  // derive slope from last two moving averages
  let slope_per_hr = null;
  if (movingAvg.length >= 2) {
    const last = movingAvg[movingAvg.length - 1];
    const prev = movingAvg[movingAvg.length - 2];
    slope_per_hr = last - prev; // percent per hour (approx)
  }

  // forecast next few hours using moving average continuation
  const lastPct = movingAvg[movingAvg.length - 1] ?? 0;
  let current = lastPct;
  for (let h = 1; h <= hours; h++) {
    current += slope_per_hr ?? 0.5; // if slope unknown, assume gentle increase
    current = Math.min(100, Math.max(0, current));
    points.push({
      timeISO: new Date(Date.now() + h * 3600 * 1000).toISOString(),
      percent_full: Math.round(current),
    });
  }

  // Estimate ETA to 90%
  let eta90_iso = null;
  if (slope_per_hr && slope_per_hr > 0 && lastPct < 90) {
    const hrs = (90 - lastPct) / slope_per_hr;
    if (isFinite(hrs) && hrs >= 0)
      eta90_iso = new Date(Date.now() + hrs * 3600000).toISOString();
  }

  // Estimate ETA to 100% (Pickup)
  let eta100_iso = null;
  if (slope_per_hr && slope_per_hr > 0 && lastPct < 100) {
    const hrs = (100 - lastPct) / slope_per_hr;
    if (isFinite(hrs) && hrs >= 0)
      eta100_iso = new Date(Date.now() + hrs * 3600000).toISOString();
  }

  res.json({ id: binId, hours, points, slope_per_hr, eta90_iso, eta100_iso });
});

// Pickup schedule: soonest ETA 100% first
app.get("/api/pickups", async (req, res) => {
  const horizonHours = Math.max(1, Math.min(24 * 7, Number(req.query.hours ?? 168)));

  const items = PREGEN_BINS.map(bin_id => {
    const h = getOrGenerateHistory(bin_id, 72);
    const last = h.at(-1);
    const lastPct = last ? last.percent_full : 0;

    // moving average slope (same as predict)
    const windowSize = 5;
    const movingAvg = h.map((_, i) => {
      const start = Math.max(0, i - windowSize + 1);
      const slice = h.slice(start, i + 1);
      return slice.reduce((s, p) => s + p.percent_full, 0) / slice.length;
    });
    const lastMA = movingAvg.at(-1) ?? lastPct;
    const prevMA = movingAvg.at(-2) ?? lastPct;
    const slope_per_hr = (movingAvg.length >= 2) ? (lastMA - prevMA) : 0.5;

    let eta100_iso = null, eta90_iso = null;
    if (slope_per_hr > 0) {
      const to90 = lastMA < 90 ? (90 - lastMA) / slope_per_hr : 0;
      const to100 = lastMA < 100 ? (100 - lastMA) / slope_per_hr : 0;
      if (isFinite(to90) && to90 >= 0) eta90_iso = new Date(Date.now() + to90 * 3600e3).toISOString();
      if (isFinite(to100) && to100 >= 0) eta100_iso = new Date(Date.now() + to100 * 3600e3).toISOString();
    }

    const dist = Math.round(BIN_HEIGHT_CM * (1 - lastPct / 100));
    const status = slope_per_hr <= 0 ? "stalled" : "ok";

    return {
      bin_id,
      postalCode: idToPostal(bin_id),
      current_percent: lastPct,
      current_distance_cm: dist,
      slope_per_hr,
      eta90_iso,
      eta100_iso,
      forecast_status: status
    };
  })
    .filter(x => x.eta100_iso) // keep those with a pickup time
    .sort((a, b) => new Date(a.eta100_iso) - new Date(b.eta100_iso)); // soonest first

  res.json({ items, horizon_hours: horizonHours });
});

// ============================== Helpers =====================================
function makeId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

function storeAndBroadcast(entry) {
  if (!entry.id) entry.id = makeId(); // ensure every entry has an id
  lastResult = entry;
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
  io.emit("pi:update", entry);

  // NEW: if it's a sensors entry and we can extract a distance, log it
  if (entry.kind === "sensors") {
    const distance = getDistanceFromSensors(entry.sensors);
    if (entry.bin_id && Number.isFinite(distance)) {
      appendLog({ id: entry.bin_id, distance_cm: distance, timestamp: entry.timestamp || tsISO() });
    }
  }
}

function normalizeClassification(source, p = {}) {
  const confidence = numOrNull(p.confidence);
  const time_ms = numOrNull(p.time_ms);
  const override = p.override === 1 || p.override === "1" ? 1 : Number(p.override) || 0;
  const recyRaw = (p.recyclable ?? "").toString().trim().toLowerCase();
  const recyclable =
    recyRaw === "recyclable" || recyRaw === "non-recyclable" || recyRaw === "contaminated" ? recyRaw : undefined;

  return {
    source,
    kind: "classification",
    bin_id: safeStr(p.bin_id),
    label: safeStr(p.label),
    confidence: isFiniteNum(confidence) ? confidence : null,
    time_ms: isFiniteNum(time_ms) ? time_ms : null,
    timestamp: p.timestamp || tsISO(),
    recyclable,
    sensors: normalizeSensors(p.sensors) || undefined,
    override,
  };
}

function normalizeSensors(s = {}) {
  // nested aliases
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
    const n = Number(v.replace(/[^0-9.+-Ee]/g, "")); // preserve signs/exp
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Smart Bin running on http://localhost:${PORT}`));

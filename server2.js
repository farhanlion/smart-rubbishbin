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
const BIN_HEIGHT_CM = 30; // distance sensor: 30cm == empty, 0cm == full
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

// simple linear regression y = a + b x (x in hours since first point)
function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / n;
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  if (den === 0) return null;
  const b = num / den;
  const a = my - b * mx;
  return { a, b };
}
function forecastPercentFull(id, hoursAhead = 48) {
  const arr = binSeries.get(id) ?? [];
  if (arr.length < 2) return { points: [], slope_per_hr: null, eta90_iso: null };
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // use last 7 days
  const recent = arr.filter(p => p.t >= cutoff);
  if (recent.length < 2) return { points: [], slope_per_hr: null, eta90_iso: null };

  const t0 = recent[0].t;
  const xs = recent.map(p => (p.t - t0) / 3600000);
  const ys = recent.map(p => percentFull(p.distance_cm, BIN_HEIGHT_CM));
  const lr = linearRegression(xs, ys);
  if (!lr) return { points: [], slope_per_hr: null, eta90_iso: null };

  const { a, b } = lr;
  const nowMs = Date.now();
  const nowHr = (nowMs - t0) / 3600000;

  const points = [];
  for (let h = 1; h <= hoursAhead; h++) {
    const x = nowHr + h;
    let y = a + b * x;
    y = Math.max(0, Math.min(100, y));
    points.push({ timeISO: new Date(nowMs + h * 3600000).toISOString(), percent_full: Math.round(y) });
  }

  // ETA to 90%
  let eta90_iso = null;
  const yNow = Math.max(0, Math.min(100, a + b * nowHr));
  if (b > 0 && yNow < 90) {
    const hoursTo90 = (90 - yNow) / b;
    if (Number.isFinite(hoursTo90) && hoursTo90 >= 0) {
      eta90_iso = new Date(nowMs + hoursTo90 * 3600000).toISOString();
    }
  }
  return { points, slope_per_hr: b, eta90_iso };
}
// ===================== end NEW storage / forecast bits =====================


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

// =================== Bins: demo + live merge + predictions ==================

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

// Latest status per bin — prefers live sensor series; falls back to demo data
app.get("/api/bins", async (_req, res) => {
  const nowIso = tsISO();

  // demo fallback (your original)
  const binsRaw = [
    { id: "BIN-001", postalCode: "238895", distance_cm: 22.5 },
    { id: "BIN-002", postalCode: "178903", distance_cm: 2.5 },
    { id: "BIN-003", postalCode: "520117", distance_cm: 9.0 },
    { id: "BIN-004", postalCode: "409051", distance_cm: 15.0 },
    { id: "BIN-005", postalCode: "069120", distance_cm: 28.0 },
    { id: "BIN-006", postalCode: "149729", distance_cm: 6.0 },
    { id: "BIN-007", postalCode: "546080", distance_cm: 1.5 },
    { id: "BIN-008", postalCode: "310158", distance_cm: 18.5 },
  ];

  // overlay live distances if present
  const out = binsRaw.map((b) => {
    const liveArr = binSeries.get(b.id);
    const live = liveArr && liveArr.length ? liveArr[liveArr.length - 1] : null;
    const distance = live ? live.distance_cm : b.distance_cm;
    const pct = percentFull(distance, BIN_HEIGHT_CM);
    return {
      id: b.id,
      postalCode: idToPostal(b.id) || b.postalCode || null,
      distance_cm: distance,
      percent_full: pct,
      colour: colourFromPct(pct),
      state: stateFromPct(pct),
      last_updated: live ? new Date(live.t).toISOString() : nowIso,
      bin_height_cm: BIN_HEIGHT_CM,
    };
  });

  res.json({
    bins: out,
    meta: {
      bin_height_default_cm: BIN_HEIGHT_CM,
      thresholds: { orange_from_pct: 70, red_from_pct: 90 },
      note: "percent_full is derived from ultrasonic distance (0cm=100%, 30cm=0%)",
    },
  });
});

// Simulated historical + predicted data
const BIN_HISTORY = {}; // In-memory cache: { [binId]: Array<{timestamp, percent_full}> }

// Tunables for simulation realism
const HOURS_DEFAULT = 72;           // generate 72h by default
const EMPTY_THRESHOLD = 85;         // when >= this, more likely to be emptied
const EMPTY_PROB_HIGH = 0.15;       // probability per hour to empty when above threshold
const EMPTY_PROB_LOW = 0.01;       // probability per hour to empty when below threshold
const RESET_MIN = 5;                // % full after empty
const RESET_MAX = 20;               // % full after empty
const DRIFT_MIN = 0.2;              // typical fill rate per hour (min)
const DRIFT_MAX = 2.0;              // typical fill rate per hour (max)
const NOISE = 0.8;              // random noise amplitude (+/-)

// Generate (or extend) history for the last `hours` hours with possible emptying events
function getOrGenerateHistory(binId, hours = HOURS_DEFAULT) {
  const now = Date.now();

  // If we already have some history, extend it to cover the requested window.
  let arr = BIN_HISTORY[binId] || [];

  const haveFrom = arr.length ? new Date(arr[0].timestamp).getTime() : null;
  const wantFrom = now - hours * 3600 * 1000;

  // If cache exists but does not go far enough back, regenerate from scratch for simplicity.
  if (!arr.length || (haveFrom != null && haveFrom > wantFrom + 5 * 60 * 1000)) {
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


// Historical data endpoint
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


// Predicted data endpoint (shape expected by dashboard)
// Predicted data endpoint using Moving Average
app.get("/api/bins/:id/predict", (req, res) => {
  const binId = req.params.id;
  const hours = Math.max(1, Math.min(240, Number(req.query.hours ?? 72)));
  const history = getOrGenerateHistory(binId);
  const windowSize = 5; // average over last 5 readings
  const points = [];

  if (history.length === 0) {
    return res.json({
      id: binId,
      hours,
      points: [],
      slope_per_hr: null,
      eta90_iso: null,
    });
  }

  // compute moving average for recent readings
  const movingAvg = [];
  for (let i = 0; i < history.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = history.slice(start, i + 1);
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

  res.json({ id: binId, hours, points, slope_per_hr, eta90_iso });
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
    recyRaw === "yes" || recyRaw === "no" || recyRaw === "contaminated" ? recyRaw : undefined;

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

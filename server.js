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
      timestamp: payload.timestamp || new Date().toISOString(),
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
      ].map(v => `"${String(v).replace(/"/g, '""')}"`);

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
    timestamp: body.timestamp || new Date().toISOString(),
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
    timestamp: body.timestamp || new Date().toISOString(),
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

// Example only — swap with DB values
// Example only — swap with DB values
app.get("/api/bins", async (_req, res) => {
  const BIN_HEIGHT_CM = 30; // distance sensor: 30cm == empty, 0cm == full
  const nowIso = new Date().toISOString();

  // Raw snapshot distances (you can replace with live DB values)
  const binsRaw = [
    { id: "BIN-001", postalCode: "238895", distance_cm: 22.5 }, // ~25% full (green)
    { id: "BIN-002", postalCode: "178903", distance_cm: 2.5 }, // ~92% full (red)
    { id: "BIN-003", postalCode: "520117", distance_cm: 9.0 }, // ~70% full (orange threshold)
    { id: "BIN-004", postalCode: "409051", distance_cm: 15.0 }, // ~50% full (green)
    { id: "BIN-005", postalCode: "069120", distance_cm: 28.0 }, // ~7%  full (green)
    { id: "BIN-006", postalCode: "149729", distance_cm: 6.0 }, // ~80% full (orange)
    { id: "BIN-007", postalCode: "546080", distance_cm: 1.5 }, // ~95% full (red)
    { id: "BIN-008", postalCode: "310158", distance_cm: 18.5 }, // ~38% full (green)
  ];

  const percentFull = (distance, height = BIN_HEIGHT_CM) => {
    if (!Number.isFinite(distance)) return null;
    const d = Math.max(0, Math.min(distance, height));
    return Math.round((1 - d / height) * 100);
  };

  const colourFromPct = (pct) => {
    if (pct == null) return "gray";
    if (pct >= 90) return "red";
    if (pct >= 70) return "orange";
    return "green";
  };

  const stateFromPct = (pct) => {
    if (pct == null) return "unknown";
    if (pct >= 90) return "full";
    if (pct >= 70) return "getting_full";
    return "ok";
  };

  const bins = binsRaw.map((b) => {
    const pct = percentFull(b.distance_cm, BIN_HEIGHT_CM);
    const colour = colourFromPct(pct);
    const state = stateFromPct(pct);
    return {
      ...b,                                       // keep original fields
      percent_full: pct,                          // 0–100
      colour,                                     // green/orange/red
      state,                                      // ok/getting_full/full
      last_updated: nowIso,
      bin_height_cm: BIN_HEIGHT_CM,
    };
  });

  res.json({
    bins,
    meta: {
      bin_height_default_cm: BIN_HEIGHT_CM,
      thresholds: { orange_from_pct: 70, red_from_pct: 90 },
      note: "percent_full is derived from ultrasonic distance (0cm=100%, 30cm=0%)",
    },
  });
});



// --------------- Helpers ---------------
function makeId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

function storeAndBroadcast(entry) {
  if (!entry.id) entry.id = makeId(); // ensure every entry has an id
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
    const n = Number(v.replace(/[^0-9.+-Ee]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Smart Bin running on http://localhost:${PORT}`));

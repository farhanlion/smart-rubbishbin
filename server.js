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

// --------------- Helpers ---------------
function storeAndBroadcast(entry) {
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
    // image_b64_jpeg: p.image_b64_jpeg,
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

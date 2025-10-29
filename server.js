// server.js
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serve your dashboard

// In-memory store
let lastResult = null;
const history = [];
const MAX_HISTORY = 200;

// ---------- Socket.IO hub ----------
const PI_ROOM = "pi";

io.on("connection", (socket) => {
  console.log("🔌 client connected:", socket.id);

  // Pi identifies itself to receive commands
  socket.on("pi:hello", (info) => {
    console.log("🤝 Pi joined:", info);
    socket.join(PI_ROOM);
    socket.emit("server:ack", { ok: true });
  });

  // Pi -> server: periodic sensor stream
  socket.on("pi:sensors", (payload = {}) => {
    const entry = {
      source: "sio-sensors",
      timestamp: payload.timestamp || new Date().toISOString(),
      sensors: payload.sensors || {},
    };
    lastResult = entry;
    history.push(entry);
    if (history.length > MAX_HISTORY) history.shift();
    io.emit("pi:update", entry); // broadcast to dashboards
  });

  // Pi -> server: vision results (periodic or on-demand capture)
  socket.on("pi:vision", (payload = {}) => {
    const entry = {
      source: "sio-vision",
      timestamp: payload.timestamp || new Date().toISOString(),
      label: payload.label ?? null,
      confidence: typeof payload.confidence === "number" ? payload.confidence : null,
      time_ms: typeof payload.time_ms === "number" ? payload.time_ms : null,
      sensors: payload.sensors || undefined,
      // image_b64_jpeg: payload.image_b64_jpeg, // uncomment if you send thumbnails
    };
    lastResult = entry;
    history.push(entry);
    if (history.length > MAX_HISTORY) history.shift();
    io.emit("pi:update", entry);
  });

  // Send latest snapshot to any new dashboard client
  if (lastResult) socket.emit("pi:update", lastResult);

  socket.on("disconnect", () => console.log("🔌 client disconnected:", socket.id));
});

// ---------- REST endpoints ----------
app.get("/", (_, res) => res.send("Smart Bin API ✅ (Socket.IO enabled)"));

// Optional: legacy webhook (now lenient; keeps old Python HTTP sender working)
app.post("/update", (req, res) => {
  const { label, confidence, time_ms, timestamp, ...sensors } = req.body || {};

  const entry = {
    source: "http-update",
    timestamp: timestamp || new Date().toISOString(),
    label: typeof label === "string" ? label : null,
    confidence: typeof confidence === "number" ? confidence : null,
    time_ms: typeof time_ms === "number" ? time_ms : null,
    sensors: Object.keys(sensors).length ? sensors : undefined,
  };

  lastResult = entry;
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
  io.emit("pi:update", entry);

  return res.json({ ok: true });
});

// Charts / history
app.get("/data", (_, res) => res.json({ lastResult, history }));

// Webapp -> Pi: send a command (e.g., POST /cmd/capture)
app.post("/cmd/:action", (req, res) => {
  const action = String(req.params.action || "").trim();
  if (!action) return res.status(400).json({ ok: false, error: "Missing action" });
  io.to(PI_ROOM).emit("pi:cmd", { action, ts: Date.now() });
  return res.json({ ok: true, sent: action });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Smart Bin running on http://localhost:${PORT}`));

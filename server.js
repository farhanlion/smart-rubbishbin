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
const history = [];            // recent events for charts
const MAX_HISTORY = 200;

// WebSocket: send snapshot on connect
io.on("connection", (socket) => {
  console.log("🔌 client connected:", socket.id);
  if (lastResult) socket.emit("pi:update", lastResult);
  socket.on("disconnect", () => console.log("🔌 client disconnected:", socket.id));
});

// Health
app.get("/", (_, res) => res.send("Smart Bin API ✅"));

// Pi webhook (aligns with your Python payload)
app.post("/update", (req, res) => {
  const { label, confidence, time_ms, timestamp } = req.body || {};

  if (typeof label !== "string" || typeof confidence !== "number") {
    return res.status(400).json({ ok: false, error: "Invalid payload" });
  }

  lastResult = { label, confidence, time_ms: Number(time_ms) || null, timestamp: timestamp || new Date().toISOString() };

  history.push(lastResult);
  if (history.length > MAX_HISTORY) history.shift();

  // Broadcast to dashboards
  io.emit("pi:update", lastResult);

  return res.json({ ok: true });
});

// Optional: serve recent data for a Chart.js page
app.get("/data", (_, res) => res.json({ lastResult, history }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Smart Bin running on http://localhost:${PORT}`));

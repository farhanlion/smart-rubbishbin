// server.js
const express = require("express");
const path = require("path");
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serve static files

let bin = {
  fillLevel: 0.25,
  weightKg: 1.2,
  classification: "recyclable",
  led: "green",
  lastUpdated: new Date().toISOString(),
};

app.get("/api/status", (_, res) => res.json(bin));

app.post("/api/status", (req, res) => {
  const { fillLevel, weightKg, classification, led } = req.body || {};
  if (fillLevel !== undefined) bin.fillLevel = fillLevel;
  if (weightKg !== undefined) bin.weightKg = weightKg;
  if (classification) bin.classification = classification;
  if (led) bin.led = led;
  bin.lastUpdated = new Date().toISOString();
  res.json({ ok: true, bin });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart Bin running on http://localhost:${PORT}`));

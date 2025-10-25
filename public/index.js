// index.js — handles live updates for Smart Bin dashboard

const $ = (id) => document.getElementById(id);

const fillBar = $("fillBar");
const fillPct = $("fillPct");
const weightKg = $("weightKg");
const classif = $("classif");
const ledDot = $("ledDot");
const ledText = $("ledText");
const lastUpdated = $("lastUpdated");
const refreshBtn = $("refreshBtn");

function ledClass(led) {
  return led === "red" ? "red" : led === "yellow" ? "yellow" : "green";
}
function barClass(level) {
  return level >= 0.8 ? "red" : level >= 0.2 ? "yellow" : "green";
}

async function load() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const data = await res.json();

    const lvl = Math.max(0, Math.min(1, Number(data.fillLevel ?? 0)));
    const pct = Math.round(lvl * 100);

    // Fill level
    fillBar.style.width = pct + "%";
    fillBar.className = "bar " + barClass(lvl);
    fillPct.textContent = pct + "%";

    // Weight
    weightKg.textContent = (data.weightKg ?? 0).toFixed(2);

    // Classification
    classif.textContent = data.classification || "unknown";

    // LED
    const led = data.led || "green";
    ledDot.className = "led " + ledClass(led);
    ledText.textContent = "LED: " + led;

    // Last updated
    const t = data.lastUpdated ? new Date(data.lastUpdated) : new Date();
    lastUpdated.textContent = t.toLocaleString();
  } catch (e) {
    console.error("Failed to fetch bin status:", e);
  }
}

refreshBtn.addEventListener("click", load);
load();
setInterval(load, 2000);

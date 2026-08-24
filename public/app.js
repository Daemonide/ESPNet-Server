// Zero-dependency dashboard: plain WebSocket client + REST fetches + a
// small Web Audio synth for sirens/whistles (no audio files to ship).
// Mirrors the "client-side synthesized audio" approach already validated
// in the project's earlier MVP.

const state = { devices: [], match: null };

// ---------------------------------------------------------------- Web Audio

let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function tone(freq, startOffset, duration, type = "sine", gain = 0.25) {
  const c = ctx();
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = 0;
  osc.connect(g).connect(c.destination);
  const t0 = c.currentTime + startOffset;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
  g.gain.linearRampToValueAtTime(0, t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

const SFX = {
  goal_red: () => { tone(880, 0, 0.15); tone(1175, 0.15, 0.25); },
  goal_blue: () => { tone(660, 0, 0.15); tone(880, 0.15, 0.25); },
  kick_fired: () => tone(220, 0, 0.08, "square", 0.15),
  emp_fired: () => { tone(120, 0, 0.3, "sawtooth", 0.2); tone(90, 0.1, 0.3, "sawtooth", 0.2); },
  intense_start: () => { tone(440, 0, 0.1, "square", 0.1); tone(440, 0.2, 0.1, "square", 0.1); },
  intense_end: () => {},
  match_start: () => { tone(523, 0, 0.15); tone(659, 0.15, 0.15); tone(784, 0.3, 0.3); },
  match_end: () => {
    tone(784, 0, 0.2); tone(784, 0.25, 0.2); tone(784, 0.5, 0.4);
    tone(523, 1.0, 0.2); tone(659, 1.2, 0.2); tone(784, 1.4, 0.5);
  },
  warmup: () => {},
};

function playAudioEvent(event) {
  try { (SFX[event] || (() => {}))(); } catch { /* audio not unlocked yet */ }
}

// ---------------------------------------------------------------------- WS

let ws;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connectWs, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "state") {
      state.devices = msg.devices;
      state.match = msg.match;
      render();
    } else if (msg.type === "audio_event") {
      playAudioEvent(msg.event);
    } else if (msg.type === "history") {
      renderHistory(msg.entries);
    } else if (msg.type === "powerup_rejected") {
      console.warn("powerup rejected", msg);
    }
  };
}

function setConn(online) {
  const el = document.getElementById("conn-status");
  el.textContent = online ? "connected" : "reconnecting…";
  el.className = `pill ${online ? "online" : "offline"}`;
}

// ------------------------------------------------------------------ Render

function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function render() {
  const m = state.match;
  if (m) {
    document.getElementById("red-name").textContent = m.playerRedName;
    document.getElementById("blue-name").textContent = m.playerBlueName;
    document.getElementById("red-score").textContent = m.scoreRed;
    document.getElementById("blue-score").textContent = m.scoreBlue;
    document.getElementById("clock").textContent = fmtClock(m.timeRemainingMs);
    document.getElementById("intense-badge").classList.toggle("hidden", !m.isIntenseMode);
  }
  renderFleet();
  renderPairingOptions();
}

function deviceCard(d) {
  const div = document.createElement("div");
  div.className = "device-card" + (d.powerCutUntil && d.powerCutUntil > Date.now() ? " frozen" : "");
  const label = d.label || d.mac;
  div.innerHTML = `
    <div><span class="status-dot ${d.isOnline ? "online" : "offline"}"></span><strong>${label}</strong></div>
    <div class="mac">${d.mac}</div>
    <div class="meta">
      team: ${d.team ?? "—"} · batt: ${d.batteryPct ?? "?"}%
      ${d.nodeType === "controller" ? `· kick: ${d.kickerCooldownUntil && d.kickerCooldownUntil > Date.now() ? "cooldown" : "ready"} · emp: ${d.powerupEmpReady ? "READY" : "locked"}` : ""}
      ${d.pairedMac ? `· paired: ${d.pairedMac}` : ""}
    </div>`;
  return div;
}

function renderFleet() {
  const byType = { controller: [], truck: [], lighting: [] };
  for (const d of state.devices) {
    if (d.nodeType && byType[d.nodeType]) byType[d.nodeType].push(d);
  }
  for (const [type, elId] of [["controller", "controllers"], ["truck", "trucks"], ["lighting", "lighting"]]) {
    const el = document.getElementById(elId);
    el.innerHTML = "";
    for (const d of byType[type]) el.appendChild(deviceCard(d));
    if (byType[type].length === 0) el.innerHTML = '<div class="meta">none seen yet</div>';
  }
}

function renderPairingOptions() {
  const controllers = state.devices.filter((d) => d.nodeType === "controller");
  const trucks = state.devices.filter((d) => d.nodeType === "truck");
  fillSelect("pair-controller", controllers);
  fillSelect("pair-truck", trucks);

  const list = document.getElementById("pairing-list");
  list.innerHTML = "";
  for (const c of controllers) {
    if (!c.pairedMac) continue;
    const row = document.createElement("div");
    row.textContent = `${c.label || c.mac} ↔ ${c.pairedMac}`;
    list.appendChild(row);
  }
}

function fillSelect(id, devices) {
  const sel = document.getElementById(id);
  const prev = sel.value;
  sel.innerHTML = devices.map((d) => `<option value="${d.mac}">${d.label || d.mac}</option>`).join("");
  if (devices.some((d) => d.mac === prev)) sel.value = prev;
}

function renderHistory(entries) {
  const body = document.getElementById("history-body");
  body.innerHTML = "";
  for (const e of [...entries].reverse()) {
    const tr = document.createElement("tr");
    const ended = e.endedAt ? new Date(e.endedAt).toLocaleTimeString() : "—";
    tr.innerHTML = `<td>${ended}</td><td>${e.playerRedName}</td><td>${e.playerBlueName}</td><td>${e.scoreRed}–${e.scoreBlue}</td><td>${e.winner ?? "—"}</td>`;
    body.appendChild(tr);
  }
}

// -------------------------------------------------------------------- API

async function post(path, body) {
  await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

document.querySelectorAll(".goal-btn").forEach((btn) => {
  btn.addEventListener("click", () => post("/api/match/goal", { team: btn.dataset.team }));
});
document.getElementById("start-btn").addEventListener("click", () => post("/api/match/start"));
document.getElementById("pause-btn").addEventListener("click", () => post("/api/match/pause"));
document.getElementById("resume-btn").addEventListener("click", () => post("/api/match/resume"));
document.getElementById("reset-btn").addEventListener("click", () => post("/api/match/reset"));
document.getElementById("minus1-btn").addEventListener("click", () => post("/api/match/time", { deltaMs: -60000 }));
document.getElementById("plus1-btn").addEventListener("click", () => post("/api/match/time", { deltaMs: 60000 }));
document.getElementById("undo-btn").addEventListener("click", () => post("/api/match/undo"));
document.getElementById("pair-btn").addEventListener("click", () => {
  const controllerMac = document.getElementById("pair-controller").value;
  const truckMac = document.getElementById("pair-truck").value;
  if (controllerMac && truckMac) post("/api/pairing", { controllerMac, truckMac });
});

// Unlock audio on first user gesture (browser autoplay policy).
document.addEventListener("click", () => { try { ctx().resume(); } catch {} }, { once: true });

connectWs();
fetch("/api/match/history").then((r) => r.json()).then((d) => renderHistory(d.entries)).catch(() => {});

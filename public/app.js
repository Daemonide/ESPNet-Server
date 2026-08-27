// ================================================================
// RoboSoccer — Robo Arena Frontend
// Real server-connected UI
// WebSocket = live state
// REST     = referee commands / pairing
// ================================================================

const state = {
  devices: [],
  match: null,
  history: [],
};

let ws = null;
let reconnectTimer = null;

// ================================================================
// AUDIO
// ================================================================

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (
      window.AudioContext ||
      window.webkitAudioContext
    )();
  }

  return audioCtx;
}

function tone(
  freq,
  startOffset,
  duration,
  type = "sine",
  gain = 0.25
) {
  const c = getAudioContext();

  const osc = c.createOscillator();
  const g = c.createGain();

  osc.type = type;
  osc.frequency.value = freq;

  g.gain.value = 0;

  osc.connect(g).connect(c.destination);

  const t0 =
    c.currentTime +
    startOffset;

  g.gain.setValueAtTime(
    0,
    t0
  );

  g.gain.linearRampToValueAtTime(
    gain,
    t0 + 0.02
  );

  g.gain.linearRampToValueAtTime(
    0,
    t0 + duration
  );

  osc.start(t0);

  osc.stop(
    t0 +
    duration +
    0.05
  );
}

const SFX = {

  goal_red() {
    tone(880, 0, 0.15);
    tone(1175, 0.15, 0.25);
  },

  goal_blue() {
    tone(660, 0, 0.15);
    tone(880, 0.15, 0.25);
  },

  kick_fired() {
    tone(
      220,
      0,
      0.08,
      "square",
      0.15
    );
  },

  emp_fired() {
    tone(
      120,
      0,
      0.3,
      "sawtooth",
      0.2
    );

    tone(
      90,
      0.1,
      0.3,
      "sawtooth",
      0.2
    );
  },

  intense_start() {
    tone(
      440,
      0,
      0.1,
      "square",
      0.1
    );

    tone(
      440,
      0.2,
      0.1,
      "square",
      0.1
    );
  },

  intense_end() {},

  match_start() {
    tone(523, 0, 0.15);
    tone(659, 0.15, 0.15);
    tone(784, 0.3, 0.3);
  },

  match_end() {
    tone(784, 0, 0.2);
    tone(784, 0.25, 0.2);
    tone(784, 0.5, 0.4);

    tone(523, 1.0, 0.2);
    tone(659, 1.2, 0.2);
    tone(784, 1.4, 0.5);
  },

  warmup() {},
};

function playAudioEvent(event) {
  try {
    if (SFX[event]) {
      SFX[event]();
    }
  } catch (err) {
    console.warn(
      "Audio error:",
      err
    );
  }
}

// ================================================================
// HELPERS
// ================================================================

function $(id) {
  return document.getElementById(id);
}

function fmtClock(ms) {
  const total =
    Math.max(
      0,
      Math.round(
        Number(ms || 0) /
        1000
      )
    );

  const minutes =
    Math.floor(
      total / 60
    );

  const seconds =
    total % 60;

  return (
    String(minutes).padStart(
      2,
      "0"
    ) +
    ":" +
    String(seconds).padStart(
      2,
      "0"
    )
  );
}

function setTimer(text) {
  const timer =
    $("timer");

  if (!timer) return;

  const parts =
    String(text).split(":");

  timer.innerHTML =
    parts[0] +
    '<span class="colon">:</span>' +
    parts[1];
}

function scoreText(value) {
  return String(
    Number(value || 0)
  ).padStart(2, "0");
}

function safeText(value) {
  return value == null ||
    value === ""
    ? "—"
    : String(value);
}

// ================================================================
// CONNECTION
// ================================================================

function setConnectionStatus(online) {

  const oldStatus =
    $("conn-status");

  if (oldStatus) {

    oldStatus.textContent =
      online
        ? "connected"
        : "reconnecting…";

    oldStatus.className =
      `pill ${
        online
          ? "online"
          : "offline"
      }`;
  }

  const conn =
    document.querySelector(
      ".conn"
    );

  if (!conn) {
    return;
  }

  const devices =
    Array.isArray(
      state.devices
    )
      ? state.devices
      : [];

  const deviceCount =
    devices.length;

  const onlineCount =
    devices.filter(
      d => d.isOnline
    ).length;

  conn.innerHTML =
    `<span>● Arena ${
      online
        ? "online"
        : "offline"
    }</span>` +
    `<span>${
      onlineCount
    }/${deviceCount} devices</span>`;
}

// ================================================================
// WEBSOCKET
// ================================================================

function connectWs() {

  clearTimeout(
    reconnectTimer
  );

  const protocol =
    location.protocol === "https:"
      ? "wss"
      : "ws";

  const wsUrl =
    `${protocol}://${location.host}/ws`;

  console.log(
    "[WS] connecting:",
    wsUrl
  );

  try {

    ws =
      new WebSocket(
        wsUrl
      );

  } catch (error) {

    console.error(
      "[WS] creation error:",
      error
    );

    setConnectionStatus(
      false
    );

    reconnectTimer =
      setTimeout(
        connectWs,
        1500
      );

    return;
  }

  ws.onopen = () => {

    console.log(
      "[WS] connected"
    );

    setConnectionStatus(
      true
    );
  };

  ws.onclose = () => {

    console.warn(
      "[WS] disconnected"
    );

    setConnectionStatus(
      false
    );

    reconnectTimer =
      setTimeout(
        connectWs,
        1500
      );
  };

  ws.onerror = error => {

    console.warn(
      "[WS] error",
      error
    );

    setConnectionStatus(
      false
    );

    try {
      ws.close();
    } catch {}
  };

  ws.onmessage = event => {

    let msg;

    try {

      msg =
        JSON.parse(
          event.data
        );

    } catch {

      console.warn(
        "Invalid WebSocket message:",
        event.data
      );

      return;
    }

    console.log(
      "[WS]",
      msg
    );

    if (
      msg.type ===
      "state"
    ) {

      state.devices =
        Array.isArray(
          msg.devices
        )
          ? msg.devices
          : [];

      state.match =
        msg.match ||
        null;

      setConnectionStatus(
        true
      );

      render();

      return;
    }

    if (
      msg.type ===
      "audio_event"
    ) {

      playAudioEvent(
        msg.event
      );

      return;
    }

    if (
      msg.type ===
      "history"
    ) {

      state.history =
        Array.isArray(
          msg.entries
        )
          ? msg.entries
          : [];

      renderHistory(
        state.history
      );

      return;
    }

    if (
      msg.type ===
      "powerup_rejected"
    ) {

      console.warn(
        "Power-up rejected:",
        msg
      );

      return;
    }
  };
}

// ================================================================
// REST
// ================================================================

async function post(
  path,
  body = {}
) {

  try {

    const response =
      await fetch(
        path,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(
              body
            ),
        }
      );

    if (!response.ok) {

      console.error(
        `POST ${path} failed:`,
        response.status
      );

      return false;
    }

    return true;

  } catch (error) {

    console.error(
      `POST ${path} error:`,
      error
    );

    return false;
  }
}

// ================================================================
// MATCH DISPLAY
// ================================================================

function renderMatch() {

  const m =
    state.match;

  if (!m) {
    return;
  }

  const redName =
    m.playerRedName ||
    "Red";

  const blueName =
    m.playerBlueName ||
    "Blue";

  const redPlayer =
    document.querySelector(
      ".truckside.red .pname"
    );

  const bluePlayer =
    document.querySelector(
      ".truckside.blue .pname"
    );

  if (redPlayer) {
    redPlayer.textContent =
      redName;
  }

  if (bluePlayer) {
    bluePlayer.textContent =
      blueName;
  }

  const redScore =
    $("redscore");

  const blueScore =
    $("bluescore");

  if (redScore) {
    redScore.textContent =
      scoreText(
        m.scoreRed
      );
  }

  if (blueScore) {
    blueScore.textContent =
      scoreText(
        m.scoreBlue
      );
  }

  setTimer(
    fmtClock(
      m.timeRemainingMs
    )
  );

  const refScore =
    $("refScoreLine");

  if (refScore) {

    refScore.textContent =
      `${scoreText(
        m.scoreRed
      )} – ${scoreText(
        m.scoreBlue
      )}`;
  }

  const refClock =
    $("refClockLine");

  if (refClock) {

    refClock.textContent =
      fmtClock(
        m.timeRemainingMs
      );
  }

  const arena =
    $("arena");

  if (arena) {

    arena.classList.toggle(
      "intense",
      Boolean(
        m.isIntenseMode
      )
    );
  }

  const label =
    $("statelabel");

  const matchState =
    $("matchstate");

  const refState =
    $("refStateLine");

  let status =
    "Match ready";

  if (
    m.isIntenseMode
  ) {

    status =
      "Intense mode";

  } else if (
    m.isRunning ||
    m.status === "running" ||
    m.status === "live"
  ) {

    status =
      "Match live";

  } else if (
    m.status === "paused"
  ) {

    status =
      "Match paused";

  } else if (
    m.status === "ended" ||
    m.timeRemainingMs <= 0
  ) {

    status =
      "Match ended";
  }

  if (label) {
    label.textContent =
      status;
  }

  if (matchState) {

    matchState.textContent =
      status;

    matchState.classList.toggle(
      "live",
      status === "Match live" ||
      status === "Intense mode"
    );
  }

  if (refState) {
    refState.textContent =
      status;
  }

  const dot =
    $("statedot");

  if (dot) {

    dot.classList.toggle(
      "live",
      status === "Match live" ||
      status === "Intense mode"
    );
  }

  if ($("red-name")) {
    $("red-name").textContent =
      redName;
  }

  if ($("blue-name")) {
    $("blue-name").textContent =
      blueName;
  }

  if ($("red-score")) {
    $("red-score").textContent =
      m.scoreRed;
  }

  if ($("blue-score")) {
    $("blue-score").textContent =
      m.scoreBlue;
  }

  if ($("clock")) {
    $("clock").textContent =
      fmtClock(
        m.timeRemainingMs
      );
  }

  if ($("intense-badge")) {

    $("intense-badge")
      .classList.toggle(
        "hidden",
        !m.isIntenseMode
      );
  }
}

// ================================================================
// GOAL ANIMATION
// ================================================================

function burstConfetti() {

  const box =
    $("confetti");

  if (!box) {
    return;
  }

  box.innerHTML = "";

  const colors = [
    "#ff3b4e",
    "#2fb2ff",
    "#ffcf4d",
    "#ffffff"
  ];

  for (
    let i = 0;
    i < 28;
    i++
  ) {

    const piece =
      document.createElement(
        "i"
      );

    piece.style.left =
      `${Math.random() * 100}%`;

    piece.style.background =
      colors[
        i % colors.length
      ];

    piece.style.animationDelay =
      `${Math.random() * 0.4}s`;

    piece.style.animationDuration =
      `${1.2 + Math.random() * 0.8}s`;

    box.appendChild(
      piece
    );
  }
}

let ballTimers = [];

function triggerTruckKick(
  side
) {

  const truck =
    document.querySelector(
      `.truckside.${side}`
    );

  if (!truck) {
    return;
  }

  truck.classList.remove(
    "kicking"
  );

  void truck.offsetWidth;

  truck.classList.add(
    "kicking"
  );

  setTimeout(
    () =>
      truck.classList.remove(
        "kicking"
      ),
    650
  );
}

function kickBallTo(
  direction,
  side
) {

  const ballWrap =
    $("ballWrap");

  const goal =
    document.querySelector(
      `.goalpost.${direction}`
    );

  if (
    !ballWrap ||
    !goal
  ) {
    return;
  }

  ballTimers.forEach(
    timer =>
      clearTimeout(
        timer
      )
  );

  ballTimers = [];

  const ballRect =
    ballWrap.getBoundingClientRect();

  const goalRect =
    goal.getBoundingClientRect();

  const dx =
    (
      goalRect.left +
      goalRect.width / 2
    ) -
    (
      ballRect.left +
      ballRect.width / 2
    );

  ballWrap.style.setProperty(
    "--kick-dx",
    `${dx}px`
  );

  ballWrap.classList.remove(
    "returning"
  );

  ballWrap.classList.add(
    "kicking"
  );

  triggerTruckKick(
    side
  );

  ballTimers.push(
    setTimeout(
      () => {

        goal.classList.add(
          "flash"
        );

        setTimeout(
          () =>
            goal.classList.remove(
              "flash"
            ),
          550
        );

      },
      830
    )
  );

  ballTimers.push(
    setTimeout(
      () => {

        ballWrap.classList.remove(
          "kicking"
        );

        void ballWrap.offsetWidth;

        ballWrap.classList.add(
          "returning"
        );

      },
      900
    )
  );

  ballTimers.push(
    setTimeout(
      () => {

        ballWrap.classList.remove(
          "returning"
        );

      },
      1400
    )
  );
}

function animateGoal(
  team
) {

  const arena =
    $("arena");

  if (!arena) {
    return;
  }

  arena.classList.remove(
    "goal",
    "goal-red",
    "goal-blue"
  );

  void arena.offsetWidth;

  const goalText =
    $("goaltext");

  if (goalText) {

    goalText.textContent =
      team === "red"
        ? "RED SCORES!"
        : "BLUE SCORES!";
  }

  arena.classList.add(
    "goal",
    team === "red"
      ? "goal-red"
      : "goal-blue"
  );

  burstConfetti();

  kickBallTo(
    team === "red"
      ? "right"
      : "left",
    team
  );

  setTimeout(
    () => {

      arena.classList.remove(
        "goal",
        "goal-red",
        "goal-blue"
      );

    },
    1500
  );
}

// ================================================================
// REFEREE COMMANDS
// ================================================================

async function refStart() {

  await post(
    "/api/match/start"
  );
}

async function refPause() {

  await post(
    "/api/match/pause"
  );
}

async function refResume() {

  await post(
    "/api/match/resume"
  );
}

async function refReset() {

  if (
    !confirm(
      "Reset match? This clears the score and timer."
    )
  ) {
    return;
  }

  await post(
    "/api/match/reset"
  );
}

async function refGoal(
  team
) {

  const success =
    await post(
      "/api/match/goal",
      {
        team
      }
    );

  if (success) {
    animateGoal(
      team
    );
  }
}

async function refUndoGoal() {

  await post(
    "/api/match/undo"
  );
}

async function refAdjustTimer(
  deltaSeconds
) {

  await post(
    "/api/match/time",
    {
      deltaMs:
        deltaSeconds *
        1000
    }
  );
}

// ================================================================
// OLD SIMPLE UI BUTTONS
// ================================================================

function bindOldButtons() {

  document
    .querySelectorAll(
      ".goal-btn"
    )
    .forEach(
      button => {

        button.addEventListener(
          "click",
          () => {

            post(
              "/api/match/goal",
              {
                team:
                  button.dataset.team
              }
            );

          }
        );
      }
    );

  const oldStart =
    $("start-btn");

  if (oldStart) {
    oldStart.onclick =
      refStart;
  }

  const oldPause =
    $("pause-btn");

  if (oldPause) {
    oldPause.onclick =
      refPause;
  }

  const oldResume =
    $("resume-btn");

  if (oldResume) {
    oldResume.onclick =
      refResume;
  }

  const oldReset =
    $("reset-btn");

  if (oldReset) {
    oldReset.onclick =
      refReset;
  }

  const oldMinus =
    $("minus1-btn");

  if (oldMinus) {
    oldMinus.onclick =
      () =>
        refAdjustTimer(
          -60
        );
  }

  const oldPlus =
    $("plus1-btn");

  if (oldPlus) {
    oldPlus.onclick =
      () =>
        refAdjustTimer(
          60
        );
  }

  const oldUndo =
    $("undo-btn");

  if (oldUndo) {
    oldUndo.onclick =
      refUndoGoal;
  }
}

// ================================================================
// PREVIEW STATE
// ================================================================

function setState(
  stateName,
  button
) {

  document
    .querySelectorAll(
      ".toolbar button"
    )
    .forEach(
      b =>
        b.classList.remove(
          "active"
        )
    );

  if (button) {
    button.classList.add(
      "active"
    );
  }

  const arena =
    $("arena");

  if (!arena) {
    return;
  }

  arena.classList.remove(
    "intense",
    "goal",
    "goal-red",
    "goal-blue"
  );

  const dot =
    $("statedot");

  const label =
    $("statelabel");

  const matchState =
    $("matchstate");

  if (dot) {
    dot.classList.remove(
      "live"
    );
  }

  if (matchState) {
    matchState.classList.remove(
      "live"
    );
  }

  if (
    stateName ===
    "ready"
  ) {

    if (label) {
      label.textContent =
        "Match ready";
    }

    if (matchState) {
      matchState.textContent =
        "Match ready";
    }

    setTimer(
      "15:00"
    );
  }

  if (
    stateName ===
    "live"
  ) {

    if (dot) {
      dot.classList.add(
        "live"
      );
    }

    if (label) {
      label.textContent =
        "Match live";
    }

    if (matchState) {

      matchState.textContent =
        "Match live";

      matchState.classList.add(
        "live"
      );
    }
  }

  if (
    stateName ===
    "intense"
  ) {

    if (dot) {
      dot.classList.add(
        "live"
      );
    }

    if (label) {
      label.textContent =
        "Intense mode";
    }

    if (matchState) {

      matchState.textContent =
        "Intense mode";

      matchState.classList.add(
        "live"
      );
    }

    arena.classList.add(
      "intense"
    );

    setTimer(
      "00:44"
    );
  }

  if (
    stateName ===
    "goalred"
  ) {

    if (dot) {
      dot.classList.add(
        "live"
      );
    }

    if (label) {
      label.textContent =
        "Match live";
    }

    if (matchState) {

      matchState.textContent =
        "Match live";

      matchState.classList.add(
        "live"
      );
    }

    animateGoal(
      "red"
    );
  }

  if (
    stateName ===
    "goalblue"
  ) {

    if (dot) {
      dot.classList.add(
        "live"
      );
    }

    if (label) {
      label.textContent =
        "Match live";
    }

    if (matchState) {

      matchState.textContent =
        "Match live";

      matchState.classList.add(
        "live"
      );
    }

    animateGoal(
      "blue"
    );
  }

  if (
    stateName ===
    "ended"
  ) {

    if (label) {
      label.textContent =
        "Match ended";
    }

    if (matchState) {
      matchState.textContent =
        "Match ended";
    }

    setTimer(
      "00:00"
    );
  }
}

// ================================================================
// NAVIGATION
// ================================================================

function showScreen(
  name,
  button
) {

  document
    .querySelectorAll(
      ".nav button"
    )
    .forEach(
      b =>
        b.classList.remove(
          "active"
        )
    );

  if (button) {
    button.classList.add(
      "active"
    );
  }

  document
    .querySelectorAll(
      ".screen"
    )
    .forEach(
      screen =>
        screen.classList.remove(
          "active"
        )
    );

  const screen =
    $(`screen-${name}`);

  if (screen) {
    screen.classList.add(
      "active"
    );
  }
}

// ================================================================
// FLEET
// ================================================================

function renderFleet() {

  const byType = {
    controller: [],
    truck: [],
    lighting: [],
  };

  for (
    const device
    of state.devices
  ) {

    if (
      device.nodeType &&
      byType[
        device.nodeType
      ]
    ) {

      byType[
        device.nodeType
      ].push(
        device
      );
    }
  }

  const fleetScreen =
    $("screen-fleet");

  if (fleetScreen) {

    const cards =
      fleetScreen.querySelectorAll(
        ".grid3 > .card"
      );

    if (
      cards.length >= 3
    ) {

      renderFleetCard(
        cards[0],
        "Controllers",
        byType.controller
      );

      renderFleetCard(
        cards[1],
        "Trucks",
        byType.truck
      );

      renderFleetCard(
        cards[2],
        "Arena lighting",
        byType.lighting
      );
    }
  }

  renderOldFleet(
    "controllers",
    byType.controller
  );

  renderOldFleet(
    "trucks",
    byType.truck
  );

  renderOldFleet(
    "lighting",
    byType.lighting
  );
}

function renderFleetCard(
  card,
  title,
  devices
) {

  card.innerHTML =
    `<h4>${title}</h4>`;

  if (
    !devices.length
  ) {

    card.innerHTML +=
      `<div class="device">
        <div>
          <div class="meta">
            No devices detected
          </div>
        </div>
      </div>`;

    return;
  }

  devices.forEach(
    device => {

      const online =
        Boolean(
          device.isOnline
        );

      const label =
        safeText(
          device.label ||
          device.mac
        );

      const battery =
        device.batteryPct ==
        null
          ? "?"
          : device.batteryPct;

      let meta =
        `MAC ${safeText(
          device.mac
        )} · ${battery}% battery`;

      if (
        device.pairedMac
      ) {

        meta +=
          ` · paired → ${
            device.pairedMac
          }`;
      }

      if (
        device.nodeType ===
        "controller"
      ) {

        const kickReady =
          !device.kickerCooldownUntil ||
          device.kickerCooldownUntil <=
            Date.now();

        meta +=
          ` · Kicker ${
            kickReady
              ? "ready"
              : "cooldown"
          }`;

        meta +=
          ` · EMP ${
            device.powerupEmpReady
              ? "ready"
              : "locked"
          }`;
      }

      const row =
        document.createElement(
          "div"
        );

      row.className =
        "device";

      row.innerHTML = `
        <div>
          <div class="name">
            ${label}
          </div>

          <div class="meta">
            ${meta}
          </div>
        </div>

        <span class="${
          online
            ? "stat-online"
            : "stat-offline"
        }">
          ${
            online
              ? "Online"
              : "Offline"
          }
        </span>
      `;

      card.appendChild(
        row
      );
    }
  );
}

function renderOldFleet(
  elementId,
  devices
) {

  const el =
    $(elementId);

  if (!el) {
    return;
  }

  el.innerHTML = "";

  if (
    !devices.length
  ) {

    el.innerHTML =
      '<div class="meta">none seen yet</div>';

    return;
  }

  devices.forEach(
    d =>
      el.appendChild(
        createOldDeviceCard(
          d
        )
      )
  );
}

function createOldDeviceCard(
  d
) {

  const div =
    document.createElement(
      "div"
    );

  div.className =
    "device-card" +
    (
      d.powerCutUntil &&
      d.powerCutUntil >
        Date.now()
        ? " frozen"
        : ""
    );

  const label =
    d.label ||
    d.mac;

  div.innerHTML = `
    <div>
      <span class="status-dot ${
        d.isOnline
          ? "online"
          : "offline"
      }"></span>

      <strong>
        ${label}
      </strong>
    </div>

    <div class="mac">
      ${d.mac}
    </div>

    <div class="meta">
      team: ${
        d.team ?? "—"
      }

      · batt:
      ${
        d.batteryPct ??
        "?"
      }%

      ${
        d.pairedMac
          ? `· paired: ${d.pairedMac}`
          : ""
      }
    </div>
  `;

  return div;
}

// ================================================================
// PAIRING
// ================================================================

function fillSelect(
  id,
  devices
) {

  const select =
    $(id);

  if (!select) {
    return;
  }

  const previous =
    select.value;

  select.innerHTML =
    devices
      .map(
        device =>
          `<option value="${
            device.mac
          }">
            ${
              device.label ||
              device.mac
            }
          </option>`
      )
      .join("");

  if (
    devices.some(
      d =>
        d.mac ===
        previous
    )
  ) {

    select.value =
      previous;
  }
}

function renderPairingOptions() {

  const controllers =
    state.devices.filter(
      d =>
        d.nodeType ===
        "controller"
    );

  const trucks =
    state.devices.filter(
      d =>
        d.nodeType ===
        "truck"
    );

  fillSelect(
    "pair-controller",
    controllers
  );

  fillSelect(
    "pair-truck",
    trucks
  );

  renderPairingMatrix(
    controllers,
    trucks
  );
}

function renderPairingMatrix(
  controllers,
  trucks
) {

  const screen =
    $("screen-pairing");

  if (!screen) {
    return;
  }

  const card =
    screen.querySelector(
      ".card"
    );

  if (!card) {
    return;
  }

  card.innerHTML = "";

  if (
    !controllers.length
  ) {

    card.innerHTML =
      `<div class="meta">
        No controllers detected.
      </div>`;

    return;
  }

  controllers.forEach(
    controller => {

      const truck =
        trucks.find(
          t =>
            t.mac ===
            controller.pairedMac
        );

      const row =
        document.createElement(
          "div"
        );

      row.className =
        "pair-chain";

      row.innerHTML = `

        <div class="node">
          ${
            controller.label ||
            controller.mac
          }
        </div>

        <div class="arrow">
          →
        </div>

        <div class="node">
          ${
            truck
              ? (
                  truck.label ||
                  truck.mac
                )
              : (
                  controller.pairedMac
                    ? controller.pairedMac
                    : "Not paired"
                )
          }
        </div>

        <span class="${
          truck
            ? "stat-online"
            : "stat-offline"
        }">
          ${
            truck
              ? "Linked"
              : "Not paired"
          }
        </span>

      `;

      card.appendChild(
        row
      );
    }
  );
}

// ================================================================
// PAIR BUTTON
// ================================================================

async function pairSelectedDevices() {

  const controller =
    $("pair-controller");

  const truck =
    $("pair-truck");

  if (
    !controller ||
    !truck
  ) {
    return;
  }

  const controllerMac =
    controller.value;

  const truckMac =
    truck.value;

  if (
    !controllerMac ||
    !truckMac
  ) {
    return;
  }

  await post(
    "/api/pairing",
    {
      controllerMac,
      truckMac,
    }
  );
}

// ================================================================
// HISTORY
// ================================================================

function renderHistory(
  entries
) {

  state.history =
    Array.isArray(
      entries
    )
      ? entries
      : [];

  const body =
    $("history-body");

  if (body) {

    body.innerHTML = "";

    for (
      const entry
      of [
        ...state.history
      ].reverse()
    ) {

      const row =
        document.createElement(
          "tr"
        );

      const ended =
        entry.endedAt
          ? new Date(
              entry.endedAt
            ).toLocaleTimeString()
          : "—";

      row.innerHTML = `
        <td>
          ${ended}
        </td>

        <td>
          ${safeText(
            entry.playerRedName
          )}
        </td>

        <td>
          ${safeText(
            entry.playerBlueName
          )}
        </td>

        <td>
          ${entry.scoreRed}–
          ${entry.scoreBlue}
        </td>

        <td>
          ${safeText(
            entry.winner
          )}
        </td>
      `;

      body.appendChild(
        row
      );
    }
  }

  const historyBox =
    $("historyList");

  if (!historyBox) {
    return;
  }

  historyBox.innerHTML = "";

  state.history.forEach(
    entry => {

      const card =
        document.createElement(
          "div"
        );

      card.className =
        "match-card";

      const winner =
        entry.winner ===
        "draw"
          ? "Draw"
          : entry.winner
            ? `Winner: ${
                entry.winner ===
                "red"
                  ? "Red"
                  : "Blue"
              }`
            : "—";

      const date =
        entry.endedAt
          ? new Date(
              entry.endedAt
            ).toLocaleString()
          : "—";

      card.innerHTML = `

        <div class="side red">

          <div class="tn">
            Red
          </div>

          <div>
            ${safeText(
              entry.playerRedName
            )}
          </div>

          <div class="sc">
            ${scoreText(
              entry.scoreRed
            )}
          </div>

        </div>

        <div class="mid">

          Match

          ${
            entry.matchNum !=
            null
              ? "#" +
                entry.matchNum
              : ""
          }

          <br>

          ${date}

          <br>

          <span class="winner">
            ${winner}
          </span>

        </div>

        <div class="side blue">

          <div class="tn">
            Blue
          </div>

          <div>
            ${safeText(
              entry.playerBlueName
            )}
          </div>

          <div class="sc">
            ${scoreText(
              entry.scoreBlue
            )}
          </div>

        </div>

      `;

      historyBox.appendChild(
        card
      );
    }
  );
}

// ================================================================
// MAIN RENDER
// ================================================================

function render() {

  renderMatch();

  renderFleet();

  renderPairingOptions();
}

// ================================================================
// INITIAL API LOAD
// ================================================================

async function loadHistory() {

  try {

    const response =
      await fetch(
        "/api/match/history"
      );

    if (!response.ok) {
      return;
    }

    const data =
      await response.json();

    renderHistory(
      data.entries || []
    );

  } catch (error) {

    console.warn(
      "Could not load history:",
      error
    );
  }
}

// ================================================================
// BUTTON BINDINGS
// ================================================================

function bindControls() {

  const pairButton =
    $("pair-btn");

  if (pairButton) {

    pairButton.addEventListener(
      "click",
      pairSelectedDevices
    );
  }

  bindOldButtons();
}

// ================================================================
// AUDIO UNLOCK
// ================================================================

document.addEventListener(
  "click",
  () => {

    try {

      const audio =
        getAudioContext();

      audio.resume();

    } catch {}

  },
  {
    once: true,
  }
);

// ================================================================
// START
// ================================================================

bindControls();

connectWs();

loadHistory();

console.log(
  "[RoboSoccer] Arena frontend started"
);
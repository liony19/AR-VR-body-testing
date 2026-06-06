import { cleanRoom, getServerInfo, resolveRoom, RoomSocket, setRoomInUrl } from "./ws.js";

const video = document.querySelector("#cameraVideo");
const canvas = document.querySelector("#visionCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const roomInput = document.querySelector("#roomInput");
const socketStatus = document.querySelector("#socketStatus");
const startButton = document.querySelector("#startButton");
const sampleButton = document.querySelector("#sampleButton");
const colorModeButton = document.querySelector("#colorModeButton");
const motionModeButton = document.querySelector("#motionModeButton");
const gameShortcut = document.querySelector("#gameShortcut");
const colorSwatch = document.querySelector("#colorSwatch");
const targetColorLabel = document.querySelector("#targetColorLabel");
const sampleState = document.querySelector("#sampleState");
const toleranceRange = document.querySelector("#toleranceRange");
const motionRange = document.querySelector("#motionRange");
const trackingBadge = document.querySelector("#trackingBadge");
const modeBadge = document.querySelector("#modeBadge");
const commandBadge = document.querySelector("#commandBadge");
const peerCount = document.querySelector("#peerCount");
const xMetric = document.querySelector("#xMetric");
const yMetric = document.querySelector("#yMetric");
const areaMetric = document.querySelector("#areaMetric");
const energyMetric = document.querySelector("#energyMetric");
const refreshLinksButton = document.querySelector("#refreshLinksButton");
const cameraLinks = document.querySelector("#cameraLinks");

let room = resolveRoom();
let socket;
let stream;
let running = false;
let mode = "color";
let sampling = false;
let target = { r: 255, g: 80, b: 80 };
let tolerance = Number(toleranceRange.value);
let motionSensitivity = Number(motionRange.value);
let prevMotion = null;
let prevMotionSize = "";
let smoothX = 0;
let smoothY = 0;
let lastSend = 0;
let lastCentroid = null;
let actionCooldown = 0;
let actionUntil = 0;
let lastCommand = {
  present: false,
  x: 0,
  y: 0,
  zone: "idle",
  action: false,
  boost: false,
  area: 0,
  energy: 0
};

const keys = new Set();
const keyMap = new Map([
  ["ArrowLeft", "left"],
  ["KeyA", "left"],
  ["ArrowRight", "right"],
  ["KeyD", "right"],
  ["ArrowUp", "up"],
  ["KeyW", "up"],
  ["ArrowDown", "down"],
  ["KeyS", "down"],
  ["Space", "action"]
]);

roomInput.value = room;
gameShortcut.href = `/game?room=${encodeURIComponent(room)}`;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatNumber(value) {
  return Number(value || 0).toFixed(2);
}

function setSocketStatus(status) {
  socketStatus.textContent = status.label;
  socketStatus.classList.toggle("online", status.state === "open");
  socketStatus.classList.toggle("warn", status.state === "connecting");
  socketStatus.classList.toggle("error", status.state === "error" || status.state === "closed");
}

function connectSocket() {
  if (socket) socket.close();
  socket = new RoomSocket({ room, role: "camera" });
  socket.on("status", setSocketStatus);
  socket.on("room", (payload) => {
    const count = (payload.peers || []).length;
    peerCount.textContent = `${count} ${count === 1 ? "par" : "pares"}`;
  });
  socket.connect();
}

async function renderLinks() {
  cameraLinks.innerHTML = '<p class="muted-copy">buscando links...</p>';

  try {
    const info = await getServerInfo(room);
    cameraLinks.innerHTML = "";

    const rows = [
      { label: "Camera local", url: info.local.cameraUrl },
      { label: "Jogo local", url: info.local.gameUrl },
      ...info.network.map((entry) => ({ label: `Jogo ${entry.address}`, url: entry.gameUrl }))
    ];

    for (const row of rows) {
      const anchor = document.createElement("a");
      anchor.href = row.url;
      anchor.textContent = `${row.label}: ${row.url}`;
      cameraLinks.append(anchor);
    }
  } catch {
    cameraLinks.innerHTML = '<p class="muted-copy">Links indisponiveis.</p>';
  }
}

function updateTargetUi() {
  const value = `rgb(${target.r}, ${target.g}, ${target.b})`;
  colorSwatch.style.background = value;
  targetColorLabel.textContent = value;
}

function setMode(nextMode) {
  mode = nextMode;
  colorModeButton.classList.toggle("active", mode === "color");
  motionModeButton.classList.toggle("active", mode === "motion");
  modeBadge.textContent = mode === "color" ? "cor" : "movimento";
}

function drawIdle() {
  const width = canvas.width;
  const height = canvas.height;
  ctx.fillStyle = "#050607";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(24, 201, 183, 0.55)";
  ctx.lineWidth = 2;
  ctx.strokeRect(width * 0.08, height * 0.12, width * 0.84, height * 0.76);
  ctx.fillStyle = "#f6f3ec";
  ctx.font = "700 28px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("camera desligada", width / 2, height / 2);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    trackingBadge.textContent = "sem getUserMedia";
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user"
      }
    });

    video.srcObject = stream;
    await video.play();
    running = true;
    startButton.textContent = "camera ativa";
    startButton.disabled = true;
    requestAnimationFrame(processFrame);
  } catch (error) {
    trackingBadge.textContent = "permissao negada";
    console.error(error);
  }
}

function resizeCanvasToVideo() {
  if (!video.videoWidth || !video.videoHeight) return;
  if (canvas.width === video.videoWidth && canvas.height === video.videoHeight) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  prevMotion = null;
}

function analyzeColor(image, width, height) {
  const step = 5;
  const data = image.data;
  const limit = tolerance * tolerance;
  let count = 0;
  let total = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const dr = data[index] - target.r;
      const dg = data[index + 1] - target.g;
      const db = data[index + 2] - target.b;
      const distance = dr * dr + dg * dg + db * db;
      total += 1;

      if (distance <= limit) {
        count += 1;
        sumX += x;
        sumY += y;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const area = total ? count / total : 0;
  const present = count > 18 && area > 0.0008;

  return {
    present,
    cx: present ? sumX / count : width / 2,
    cy: present ? sumY / count : height / 2,
    area,
    energy: clamp(area * 7, 0, 1),
    bounds: present ? { minX, minY, maxX, maxY } : null
  };
}

function analyzeMotion(image, width, height) {
  const step = 7;
  const gridWidth = Math.floor(width / step);
  const gridHeight = Math.floor(height / step);
  const sizeKey = `${gridWidth}x${gridHeight}`;
  const data = image.data;

  if (!prevMotion || prevMotionSize !== sizeKey) {
    prevMotion = new Uint8Array(gridWidth * gridHeight);
    prevMotionSize = sizeKey;
  }

  let count = 0;
  let total = 0;
  let sumX = 0;
  let sumY = 0;
  let totalDiff = 0;
  let index = 0;

  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = gy * step;
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = gx * step;
      const pixel = (y * width + x) * 4;
      const gray = (data[pixel] * 0.299 + data[pixel + 1] * 0.587 + data[pixel + 2] * 0.114) | 0;
      const diff = Math.abs(gray - prevMotion[index]);
      prevMotion[index] = Math.round(prevMotion[index] * 0.68 + gray * 0.32);
      total += 1;

      if (diff > motionSensitivity) {
        count += 1;
        sumX += x;
        sumY += y;
        totalDiff += diff;
      }

      index += 1;
    }
  }

  const area = total ? count / total : 0;
  const energy = clamp(totalDiff / Math.max(1, total * 18), 0, 1);
  const present = count > 20 && area > 0.006;

  return {
    present,
    cx: present ? sumX / count : width / 2,
    cy: present ? sumY / count : height / 2,
    area,
    energy,
    bounds: null
  };
}

function zoneFrom(x, y, present) {
  if (!present) return "idle";
  if (Math.abs(x) < 0.2 && Math.abs(y) < 0.2) return "centro";
  if (Math.abs(x) > Math.abs(y)) return x < 0 ? "esquerda" : "direita";
  return y < 0 ? "baixo" : "cima";
}

function buildCommand(result, width, height, now) {
  const rawX = result.present ? clamp(((result.cx / width) - 0.5) * 2.2, -1, 1) : 0;
  const rawY = result.present ? clamp((0.5 - (result.cy / height)) * 2.2, -1, 1) : 0;
  const lerp = result.present ? 0.34 : 0.12;

  smoothX += (rawX - smoothX) * lerp;
  smoothY += (rawY - smoothY) * lerp;

  let action = false;
  if (result.present && lastCentroid) {
    const dt = Math.max(0.016, (now - lastCentroid.time) / 1000);
    const dx = (result.cx - lastCentroid.x) / width;
    const dy = (result.cy - lastCentroid.y) / height;
    const speed = Math.hypot(dx, dy) / dt;
    if (speed > 1.25 && now > actionCooldown) {
      action = true;
      actionUntil = now + 180;
      actionCooldown = now + 620;
    }
  }

  lastCentroid = result.present ? { x: result.cx, y: result.cy, time: now } : null;

  const command = {
    type: "vision",
    source: mode,
    present: result.present,
    x: Number(smoothX.toFixed(3)),
    y: Number(smoothY.toFixed(3)),
    zone: zoneFrom(smoothX, smoothY, result.present),
    action,
    boost: action || result.energy > 0.42,
    area: Number(result.area.toFixed(4)),
    energy: Number(result.energy.toFixed(4))
  };

  lastCommand = command;
  return command;
}

function sendCommand(command, now) {
  if (now - lastSend < 45) return;
  lastSend = now;
  socket?.send(command);
}

function drawOverlay(result, command, width, height) {
  ctx.save();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(width / 2, 0);
  ctx.lineTo(width / 2, height);
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  if (result.present) {
    ctx.strokeStyle = command.action || command.boost ? "#ffbe57" : "#18c9b7";
    ctx.fillStyle = command.action || command.boost ? "#ffbe57" : "#18c9b7";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(result.cx, result.cy, 28 + result.energy * 26, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(result.cx - 38, result.cy);
    ctx.lineTo(result.cx + 38, result.cy);
    ctx.moveTo(result.cx, result.cy - 38);
    ctx.lineTo(result.cx, result.cy + 38);
    ctx.stroke();

    if (result.bounds) {
      const { minX, minY, maxX, maxY } = result.bounds;
      ctx.strokeRect(minX, minY, Math.max(4, maxX - minX), Math.max(4, maxY - minY));
    }
  }

  if (nowMs() < actionUntil) {
    ctx.strokeStyle = "rgba(255, 190, 87, 0.82)";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.38, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function updateMetrics(command) {
  trackingBadge.textContent = command.present ? "alvo ativo" : "sem alvo";
  commandBadge.textContent = command.zone;
  commandBadge.classList.toggle("online", command.present);
  commandBadge.classList.toggle("warn", command.boost);
  xMetric.textContent = formatNumber(command.x);
  yMetric.textContent = formatNumber(command.y);
  areaMetric.textContent = `${Math.round(command.area * 100)}%`;
  energyMetric.textContent = `${Math.round(command.energy * 100)}%`;
}

function nowMs() {
  return performance.now();
}

function processFrame(now) {
  if (!running) return;

  resizeCanvasToVideo();
  const width = canvas.width;
  const height = canvas.height;

  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -width, 0, width, height);
  ctx.restore();

  const image = ctx.getImageData(0, 0, width, height);
  const result = mode === "color"
    ? analyzeColor(image, width, height)
    : analyzeMotion(image, width, height);
  const command = buildCommand(result, width, height, now);

  drawOverlay(result, command, width, height);
  updateMetrics(command);
  sendCommand(command, now);

  requestAnimationFrame(processFrame);
}

function sampleColorAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clamp(Math.round((clientX - rect.left) / rect.width * canvas.width), 0, canvas.width - 1);
  const y = clamp(Math.round((clientY - rect.top) / rect.height * canvas.height), 0, canvas.height - 1);
  const pixel = ctx.getImageData(x, y, 1, 1).data;
  target = { r: pixel[0], g: pixel[1], b: pixel[2] };
  updateTargetUi();
}

function sendManualCommand() {
  let x = 0;
  let y = 0;
  if (keys.has("left")) x -= 1;
  if (keys.has("right")) x += 1;
  if (keys.has("up")) y += 1;
  if (keys.has("down")) y -= 1;

  const hasManual = x !== 0 || y !== 0 || keys.has("action");
  if (!hasManual) return;

  const command = {
    type: "vision",
    source: "keyboard",
    present: true,
    x,
    y,
    zone: zoneFrom(x, y, true),
    action: keys.has("action"),
    boost: keys.has("action"),
    area: 1,
    energy: keys.has("action") ? 1 : 0.45
  };

  socket?.send(command);
  updateMetrics(command);
}

function manualLoop() {
  sendManualCommand();
  requestAnimationFrame(manualLoop);
}

startButton.addEventListener("click", startCamera);

sampleButton.addEventListener("click", () => {
  sampling = !sampling;
  sampleButton.textContent = sampling ? "amostragem ativa" : "amostrar cor";
  sampleState.textContent = sampling ? "aguardando ponto" : "amostra livre";
});

canvas.addEventListener("click", (event) => {
  if (!running) return;
  if (mode === "color" || sampling) {
    sampleColorAt(event.clientX, event.clientY);
    sampling = false;
    sampleButton.textContent = "amostrar cor";
    sampleState.textContent = "cor capturada";
  }
});

colorModeButton.addEventListener("click", () => setMode("color"));
motionModeButton.addEventListener("click", () => setMode("motion"));

toleranceRange.addEventListener("input", () => {
  tolerance = Number(toleranceRange.value);
});

motionRange.addEventListener("input", () => {
  motionSensitivity = Number(motionRange.value);
});

roomInput.addEventListener("change", () => {
  room = setRoomInUrl(cleanRoom(roomInput.value), true);
  roomInput.value = room;
  gameShortcut.href = `/game?room=${encodeURIComponent(room)}`;
  connectSocket();
  renderLinks();
});

refreshLinksButton.addEventListener("click", renderLinks);

window.addEventListener("keydown", (event) => {
  const mapped = keyMap.get(event.code);
  if (!mapped) return;
  keys.add(mapped);
  event.preventDefault();
});

window.addEventListener("keyup", (event) => {
  const mapped = keyMap.get(event.code);
  if (!mapped) return;
  keys.delete(mapped);
  event.preventDefault();
});

drawIdle();
updateTargetUi();
setMode("color");
connectSocket();
renderLinks();
manualLoop();

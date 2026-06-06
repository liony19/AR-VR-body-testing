import { resolveRoom, RoomSocket } from "./ws.js";

const canvas = document.querySelector("#gameCanvas");
const ctx = canvas.getContext("2d", { alpha: false });

const scorePill = document.querySelector("#scorePill");
const lifePill = document.querySelector("#lifePill");
const signalPill = document.querySelector("#signalPill");
const roomPill = document.querySelector("#roomPill");
const xrButton = document.querySelector("#xrButton");
const resetButton = document.querySelector("#resetButton");
const toast = document.querySelector("#toast");

const room = resolveRoom();
roomPill.textContent = room;

const socket = new RoomSocket({ room, role: "game" });

let viewWidth = 1;
let viewHeight = 1;
let dpr = 1;
let lastFrameTime = performance.now();
let lastPulseTime = 0;
let socketLabel = "offline";

const input = {
  x: 0,
  y: 0,
  present: false,
  boost: false,
  source: "idle",
  lastSeen: 0,
  local: false
};

const state = {
  time: 0,
  score: 0,
  lives: 3,
  combo: 1,
  spawnTimer: 0,
  invincible: 0,
  shake: 0,
  player: { x: 0, y: 0.72, r: 0.065 },
  hazards: [],
  bits: [],
  pulses: [],
  particles: []
};

const stars = Array.from({ length: 80 }, () => ({
  x: Math.random(),
  y: Math.random(),
  speed: 0.05 + Math.random() * 0.22,
  size: 0.6 + Math.random() * 1.8
}));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;
  const nextWidth = Math.floor(viewWidth * dpr);
  const nextHeight = Math.floor(viewHeight * dpr);

  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function sx(x) {
  return (x * 0.5 + 0.5) * viewWidth;
}

function sy(y) {
  return (y * 0.5 + 0.5) * viewHeight;
}

function sr(r) {
  return r * Math.min(viewWidth, viewHeight) * 0.5;
}

function distance(a, b) {
  const aspect = viewWidth / Math.max(1, viewHeight);
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

function resetGame() {
  state.score = 0;
  state.lives = 3;
  state.combo = 1;
  state.spawnTimer = 0;
  state.invincible = 0;
  state.shake = 0;
  state.hazards.length = 0;
  state.bits.length = 0;
  state.pulses.length = 0;
  state.particles.length = 0;
  state.player.x = 0;
  state.player.y = 0.72;
}

function spawnHazard() {
  const difficulty = clamp(state.time / 85, 0, 1);
  const isBit = Math.random() > 0.7;

  if (isBit) {
    state.bits.push({
      x: rand(-0.82, 0.82),
      y: -1.12,
      r: rand(0.032, 0.052),
      vy: rand(0.34, 0.54) + difficulty * 0.2,
      value: 20 + Math.round(difficulty * 20)
    });
    return;
  }

  state.hazards.push({
    x: rand(-0.86, 0.86),
    y: -1.16,
    r: rand(0.045, 0.082),
    vy: rand(0.36, 0.68) + difficulty * 0.28,
    spin: rand(-1, 1)
  });
}

function makeParticles(x, y, color, count = 12) {
  for (let index = 0; index < count; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(0.4, 1.2);
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: rand(0.35, 0.75),
      age: 0,
      color
    });
  }
}

function triggerPulse() {
  const now = performance.now();
  if (now - lastPulseTime < 260) return;
  lastPulseTime = now;

  const pulse = {
    x: state.player.x,
    y: state.player.y,
    age: 0,
    life: 0.45,
    r: 0.12
  };
  state.pulses.push(pulse);
  state.shake = Math.max(state.shake, 0.13);

  for (let index = state.hazards.length - 1; index >= 0; index -= 1) {
    const hazard = state.hazards[index];
    if (distance(hazard, state.player) < 0.55) {
      makeParticles(hazard.x, hazard.y, "#ffbe57", 10);
      state.hazards.splice(index, 1);
      state.score += 12 * state.combo;
      state.combo = Math.min(state.combo + 1, 8);
    }
  }
}

function handleHit(hazard) {
  if (state.invincible > 0) return;
  state.lives -= 1;
  state.combo = 1;
  state.invincible = 1.1;
  state.shake = 0.2;
  makeParticles(hazard.x, hazard.y, "#ef5a7a", 18);

  if (state.lives <= 0) {
    showToast("reinicio");
    resetGame();
  }
}

function updateInputFreshness(now) {
  const fresh = now - input.lastSeen < 900;
  if (!fresh && !input.local) {
    input.present = false;
    input.boost = false;
  }
}

function updatePlayer(dt) {
  const hasControl = input.present || input.local;
  const targetX = hasControl ? clamp(input.x * 0.86, -0.86, 0.86) : 0;
  const targetY = hasControl ? clamp(0.72 - input.y * 0.42, -0.72, 0.82) : 0.72;
  const speed = input.boost ? 12 : 7;
  const amount = clamp(dt * speed, 0, 1);

  state.player.x += (targetX - state.player.x) * amount;
  state.player.y += (targetY - state.player.y) * amount;
}

function updateObjects(dt) {
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0) {
    spawnHazard();
    const difficulty = clamp(state.time / 90, 0, 1);
    state.spawnTimer = rand(0.42, 0.84) - difficulty * 0.18;
  }

  for (const hazard of state.hazards) {
    hazard.y += hazard.vy * dt;
    hazard.spin += dt;
  }
  for (const bit of state.bits) bit.y += bit.vy * dt;

  for (let index = state.hazards.length - 1; index >= 0; index -= 1) {
    const hazard = state.hazards[index];
    if (hazard.y > 1.2) {
      state.hazards.splice(index, 1);
      continue;
    }
    if (distance(hazard, state.player) < hazard.r + state.player.r) {
      state.hazards.splice(index, 1);
      handleHit(hazard);
    }
  }

  for (let index = state.bits.length - 1; index >= 0; index -= 1) {
    const bit = state.bits[index];
    if (bit.y > 1.2) {
      state.bits.splice(index, 1);
      continue;
    }
    if (distance(bit, state.player) < bit.r + state.player.r + 0.02) {
      state.bits.splice(index, 1);
      state.score += bit.value * state.combo;
      state.combo = Math.min(state.combo + 1, 8);
      makeParticles(bit.x, bit.y, "#18c9b7", 8);
    }
  }

  for (const pulse of state.pulses) {
    pulse.age += dt;
    pulse.r += dt * 1.8;
  }
  state.pulses = state.pulses.filter((pulse) => pulse.age < pulse.life);

  for (const particle of state.particles) {
    particle.age += dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.96;
    particle.vy *= 0.96;
  }
  state.particles = state.particles.filter((particle) => particle.age < particle.life);
}

function update(dt, now) {
  state.time += dt;
  state.invincible = Math.max(0, state.invincible - dt);
  state.shake = Math.max(0, state.shake - dt);
  updateInputFreshness(now);
  updatePlayer(dt);
  updateObjects(dt);
}

function drawBackground() {
  const gradient = ctx.createLinearGradient(0, 0, viewWidth, viewHeight);
  gradient.addColorStop(0, "#0a0e0f");
  gradient.addColorStop(0.45, "#101214");
  gradient.addColorStop(1, "#160b10");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, viewWidth, viewHeight);

  ctx.save();
  ctx.globalAlpha = 0.72;
  for (const star of stars) {
    const y = ((star.y + state.time * star.speed) % 1) * viewHeight;
    const x = star.x * viewWidth;
    ctx.fillStyle = star.speed > 0.17 ? "rgba(24, 201, 183, 0.82)" : "rgba(246, 243, 236, 0.5)";
    ctx.fillRect(x, y, star.size, star.size * 2);
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.045)";
  ctx.lineWidth = 1;
  const gap = Math.max(38, Math.min(viewWidth, viewHeight) * 0.08);
  const offset = (state.time * 34) % gap;
  for (let y = -gap; y < viewHeight + gap; y += gap) {
    ctx.beginPath();
    ctx.moveTo(0, y + offset);
    ctx.lineTo(viewWidth, y + offset + gap * 0.28);
    ctx.stroke();
  }
}

function drawCircleObject(object, color, ring = false) {
  const radius = sr(object.r);
  ctx.beginPath();
  ctx.arc(sx(object.x), sy(object.y), radius, 0, Math.PI * 2);
  if (ring) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, radius * 0.18);
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawGame() {
  resizeCanvas();

  const shakeX = state.shake ? rand(-state.shake, state.shake) * 26 : 0;
  const shakeY = state.shake ? rand(-state.shake, state.shake) * 26 : 0;

  drawBackground();

  ctx.save();
  ctx.translate(shakeX, shakeY);

  for (const bit of state.bits) {
    ctx.save();
    ctx.translate(sx(bit.x), sy(bit.y));
    ctx.rotate(state.time * 2.2);
    const radius = sr(bit.r);
    ctx.fillStyle = "#18c9b7";
    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(radius, 0);
    ctx.lineTo(0, radius);
    ctx.lineTo(-radius, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  for (const hazard of state.hazards) {
    drawCircleObject(hazard, "rgba(239, 90, 122, 0.88)");
    drawCircleObject({ ...hazard, r: hazard.r * 1.4 }, "rgba(239, 90, 122, 0.34)", true);
  }

  for (const pulse of state.pulses) {
    const alpha = 1 - pulse.age / pulse.life;
    ctx.strokeStyle = `rgba(255, 190, 87, ${alpha})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(sx(pulse.x), sy(pulse.y), sr(pulse.r), 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const particle of state.particles) {
    const alpha = 1 - particle.age / particle.life;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(sx(particle.x), sy(particle.y), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = particle.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawPlayer();
  ctx.restore();
}

function drawPlayer() {
  const x = sx(state.player.x);
  const y = sy(state.player.y);
  const radius = sr(state.player.r);
  const flash = state.invincible > 0 && Math.floor(state.time * 18) % 2 === 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = input.boost ? "#ffbe57" : "#18c9b7";
  ctx.shadowBlur = input.boost ? 28 : 18;
  ctx.fillStyle = flash ? "rgba(246, 243, 236, 0.36)" : "#f6f3ec";
  ctx.beginPath();
  ctx.moveTo(0, -radius * 1.55);
  ctx.lineTo(radius * 1.15, radius * 1.15);
  ctx.lineTo(0, radius * 0.72);
  ctx.lineTo(-radius * 1.15, radius * 1.15);
  ctx.closePath();
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.fillStyle = input.boost ? "#ffbe57" : "#18c9b7";
  ctx.beginPath();
  ctx.arc(0, radius * 0.36, radius * 0.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function updateHud() {
  scorePill.textContent = String(Math.floor(state.score)).padStart(4, "0");
  lifePill.textContent = `vida ${state.lives}`;

  const fresh = performance.now() - input.lastSeen < 900 || input.local;
  signalPill.textContent = fresh
    ? `${input.source}${input.boost ? " boost" : ""}`
    : `camera ${socketLabel}`;
  signalPill.classList.toggle("online", fresh);
  signalPill.classList.toggle("warn", input.boost);
}

function frame(now) {
  const dt = clamp((now - lastFrameTime) / 1000, 0.001, 0.035);
  lastFrameTime = now;
  update(dt, now);
  drawGame();
  updateHud();
  requestAnimationFrame(frame);
}

function handleVision(payload) {
  input.x = clamp(Number(payload.x) || 0, -1, 1);
  input.y = clamp(Number(payload.y) || 0, -1, 1);
  input.present = Boolean(payload.present);
  input.boost = Boolean(payload.boost);
  input.source = payload.source || "camera";
  input.lastSeen = performance.now();
  input.local = false;

  if (payload.action) triggerPulse();
}

function setLocalInput(event) {
  const rect = canvas.getBoundingClientRect();
  input.local = true;
  input.present = true;
  input.source = "toque";
  input.lastSeen = performance.now();
  input.x = clamp(((event.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
  input.y = clamp((0.5 - (event.clientY - rect.top) / rect.height) * 2, -1, 1);
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  setLocalInput(event);
});

canvas.addEventListener("pointermove", (event) => {
  if (!input.local) return;
  setLocalInput(event);
});

canvas.addEventListener("pointerup", () => {
  input.local = false;
});

canvas.addEventListener("pointercancel", () => {
  input.local = false;
});

canvas.addEventListener("dblclick", triggerPulse);

resetButton.addEventListener("click", resetGame);

socket.on("vision", handleVision);
socket.on("status", (status) => {
  socketLabel = status.label;
});
socket.connect();

let xrSession = null;
let xrCanvas = null;
let xrGl = null;
let xrProgram = null;
let xrBuffer = null;
let xrRefSpace = null;

async function configureXrButton() {
  if (!navigator.xr) {
    xrButton.disabled = true;
    xrButton.textContent = "sem AR";
    return;
  }

  try {
    const supported = await navigator.xr.isSessionSupported("immersive-ar");
    xrButton.disabled = !supported;
    xrButton.textContent = supported ? "AR" : "sem AR";
  } catch {
    xrButton.disabled = true;
    xrButton.textContent = "sem AR";
  }
}

async function startXr() {
  if (xrSession) {
    xrSession.end();
    return;
  }

  try {
    xrSession = await navigator.xr.requestSession("immersive-ar", {
      optionalFeatures: ["local-floor", "dom-overlay"],
      domOverlay: { root: document.body }
    });

    xrCanvas = document.createElement("canvas");
    xrCanvas.className = "xr-canvas";
    document.body.append(xrCanvas);
    xrGl = xrCanvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      xrCompatible: true
    });

    await xrGl.makeXRCompatible();
    xrSession.updateRenderState({
      baseLayer: new XRWebGLLayer(xrSession, xrGl)
    });

    xrRefSpace = await xrSession.requestReferenceSpace("local-floor")
      .catch(() => xrSession.requestReferenceSpace("local"))
      .catch(() => xrSession.requestReferenceSpace("viewer"));

    setupXrGl();
    xrButton.textContent = "sair";
    showToast("AR");

    xrSession.addEventListener("end", () => {
      xrSession = null;
      xrRefSpace = null;
      xrGl = null;
      xrProgram = null;
      xrBuffer = null;
      xrCanvas?.remove();
      xrCanvas = null;
      xrButton.textContent = "AR";
    }, { once: true });

    xrSession.requestAnimationFrame(renderXrFrame);
  } catch (error) {
    xrSession = null;
    showToast("AR requer WebXR e HTTPS");
    console.error(error);
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Shader error");
  }
  return shader;
}

function setupXrGl() {
  const vertex = `
    attribute vec2 a_position;
    attribute vec4 a_color;
    varying vec4 v_color;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_color = a_color;
    }
  `;
  const fragment = `
    precision mediump float;
    varying vec4 v_color;
    void main() {
      gl_FragColor = v_color;
    }
  `;

  const vertexShader = compileShader(xrGl, xrGl.VERTEX_SHADER, vertex);
  const fragmentShader = compileShader(xrGl, xrGl.FRAGMENT_SHADER, fragment);
  xrProgram = xrGl.createProgram();
  xrGl.attachShader(xrProgram, vertexShader);
  xrGl.attachShader(xrProgram, fragmentShader);
  xrGl.linkProgram(xrProgram);

  if (!xrGl.getProgramParameter(xrProgram, xrGl.LINK_STATUS)) {
    throw new Error(xrGl.getProgramInfoLog(xrProgram) || "Program error");
  }

  xrBuffer = xrGl.createBuffer();
  xrGl.useProgram(xrProgram);
  xrGl.enable(xrGl.BLEND);
  xrGl.blendFunc(xrGl.SRC_ALPHA, xrGl.ONE_MINUS_SRC_ALPHA);
}

function pushVertex(vertices, x, y, color) {
  vertices.push(x, -y, color[0], color[1], color[2], color[3]);
}

function addCircle(vertices, x, y, radius, color, segments = 18) {
  for (let index = 0; index < segments; index += 1) {
    const a = index / segments * Math.PI * 2;
    const b = (index + 1) / segments * Math.PI * 2;
    pushVertex(vertices, x, y, color);
    pushVertex(vertices, x + Math.cos(a) * radius, y + Math.sin(a) * radius, color);
    pushVertex(vertices, x + Math.cos(b) * radius, y + Math.sin(b) * radius, color);
  }
}

function addDiamond(vertices, x, y, radius, color) {
  pushVertex(vertices, x, y - radius, color);
  pushVertex(vertices, x + radius, y, color);
  pushVertex(vertices, x, y + radius, color);
  pushVertex(vertices, x, y - radius, color);
  pushVertex(vertices, x, y + radius, color);
  pushVertex(vertices, x - radius, y, color);
}

function addPlayer(vertices) {
  const p = state.player;
  const r = p.r * 1.35;
  const color = input.boost ? [1, 0.75, 0.25, 0.95] : [0.94, 0.96, 0.93, 0.95];
  pushVertex(vertices, p.x, p.y - r * 1.25, color);
  pushVertex(vertices, p.x + r, p.y + r, color);
  pushVertex(vertices, p.x - r, p.y + r, color);
  addCircle(vertices, p.x, p.y + r * 0.32, r * 0.28, [0.09, 0.79, 0.72, 0.9], 12);
}

function buildXrVertices() {
  const vertices = [];

  for (const bit of state.bits) {
    addDiamond(vertices, bit.x, bit.y, bit.r * 1.2, [0.09, 0.79, 0.72, 0.88]);
  }

  for (const hazard of state.hazards) {
    addCircle(vertices, hazard.x, hazard.y, hazard.r, [0.94, 0.35, 0.48, 0.86], 18);
  }

  for (const pulse of state.pulses) {
    const alpha = 1 - pulse.age / pulse.life;
    addCircle(vertices, pulse.x, pulse.y, pulse.r, [1, 0.75, 0.25, Math.max(0, alpha) * 0.18], 28);
  }

  addPlayer(vertices);
  return vertices;
}

function renderXrFrame(time, frame) {
  if (!xrSession || !xrGl || !xrProgram || !xrRefSpace) return;
  const pose = frame.getViewerPose(xrRefSpace);
  const layer = xrSession.renderState.baseLayer;

  xrGl.bindFramebuffer(xrGl.FRAMEBUFFER, layer.framebuffer);
  xrGl.clearColor(0, 0, 0, 0);
  xrGl.clear(xrGl.COLOR_BUFFER_BIT);

  if (pose) {
    const vertices = new Float32Array(buildXrVertices());
    const positionLocation = xrGl.getAttribLocation(xrProgram, "a_position");
    const colorLocation = xrGl.getAttribLocation(xrProgram, "a_color");
    xrGl.bindBuffer(xrGl.ARRAY_BUFFER, xrBuffer);
    xrGl.bufferData(xrGl.ARRAY_BUFFER, vertices, xrGl.DYNAMIC_DRAW);
    xrGl.vertexAttribPointer(positionLocation, 2, xrGl.FLOAT, false, 24, 0);
    xrGl.vertexAttribPointer(colorLocation, 4, xrGl.FLOAT, false, 24, 8);
    xrGl.enableVertexAttribArray(positionLocation);
    xrGl.enableVertexAttribArray(colorLocation);

    for (const view of pose.views) {
      const viewport = layer.getViewport(view);
      xrGl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      xrGl.drawArrays(xrGl.TRIANGLES, 0, vertices.length / 6);
    }
  }

  xrSession.requestAnimationFrame(renderXrFrame);
}

xrButton.addEventListener("click", startXr);

window.addEventListener("resize", resizeCanvas);

configureXrButton();
resizeCanvas();
resetGame();
requestAnimationFrame(frame);

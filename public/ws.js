export function cleanRoom(value) {
  return String(value || "DEMO")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 18) || "DEMO";
}

export function randomRoom() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => letters[byte % letters.length]).join("");
}

export function resolveRoom() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("room");
  const fromStorage = localStorage.getItem("webxr-cv-room");
  const room = cleanRoom(fromUrl || fromStorage || randomRoom());
  localStorage.setItem("webxr-cv-room", room);
  setRoomInUrl(room, true);
  return room;
}

export function setRoomInUrl(room, replace = false) {
  const nextRoom = cleanRoom(room);
  const url = new URL(location.href);
  url.searchParams.set("room", nextRoom);
  const method = replace ? "replaceState" : "pushState";
  history[method]({}, "", url);
  localStorage.setItem("webxr-cv-room", nextRoom);
  return nextRoom;
}

export async function getServerInfo(room) {
  const response = await fetch(`/api/info?room=${encodeURIComponent(cleanRoom(room))}`, {
    cache: "no-store"
  });
  if (!response.ok) throw new Error("Server info unavailable");
  return response.json();
}

export function wsAddress(room, role) {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const query = new URLSearchParams({
    room: cleanRoom(room),
    role
  });
  return `${protocol}://${location.host}/ws?${query}`;
}

export class RoomSocket {
  constructor({ room, role }) {
    this.room = cleanRoom(room);
    this.role = role;
    this.listeners = new Map();
    this.socket = null;
    this.reconnectTimer = 0;
    this.reconnectDelay = 400;
    this.closedByUser = false;
  }

  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.listeners.get(type)?.delete(handler);
  }

  emit(type, payload) {
    for (const handler of this.listeners.get(type) || []) handler(payload);
    for (const handler of this.listeners.get("*") || []) handler(type, payload);
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    this.closedByUser = false;
    this.emit("status", { state: "connecting", label: "conectando" });

    const socket = new WebSocket(wsAddress(this.room, this.role));
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelay = 400;
      this.emit("status", { state: "open", label: "online" });
      this.send({ type: "ready", role: this.role });
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      this.emit("message", payload);
      if (payload.type) this.emit(payload.type, payload);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.emit("status", { state: "closed", label: "offline" });
      if (!this.closedByUser) this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.emit("status", { state: "error", label: "erro" });
    });
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.45, 3500);
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.close();
  }
}

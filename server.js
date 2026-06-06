const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8"
};

const rooms = new Map();

function cleanRoom(value) {
  return String(value || "DEMO")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 18) || "DEMO";
}

function getRoom(room) {
  const key = cleanRoom(room);
  if (!rooms.has(key)) rooms.set(key, new Set());
  return rooms.get(key);
}

function roomSnapshot(room) {
  return [...getRoom(room)].map((client) => ({
    id: client.id,
    role: client.role,
    connectedAt: client.connectedAt
  }));
}

function networkLinks(room) {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const baseUrl = `http://${entry.address}:${PORT}`;
      addresses.push({
        address: entry.address,
        cameraUrl: `${baseUrl}/camera?room=${encodeURIComponent(room)}`,
        gameUrl: `${baseUrl}/game?room=${encodeURIComponent(room)}`
      });
    }
  }

  return addresses;
}

function sendJson(client, payload) {
  if (!client.socket.writable) return;
  client.socket.write(encodeFrame(JSON.stringify(payload)));
}

function broadcast(room, payload, exceptClient = null) {
  for (const client of getRoom(room)) {
    if (client === exceptClient) continue;
    sendJson(client, payload);
  }
}

function broadcastRoomState(room) {
  broadcast(room, {
    type: "room",
    room,
    peers: roomSnapshot(room),
    serverTime: Date.now()
  });
}

function resolvePublicPath(urlPath) {
  let pathname = urlPath;

  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/camera") pathname = "/camera.html";
  if (pathname === "/game") pathname = "/game.html";

  const relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = path.normalize(path.join(PUBLIC_DIR, relativePath));
  const insidePublic = target === PUBLIC_DIR || target.startsWith(PUBLIC_DIR + path.sep);
  return insidePublic ? target : null;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/info") {
    const room = cleanRoom(url.searchParams.get("room"));
    const payload = {
      room,
      port: PORT,
      local: {
        cameraUrl: `http://localhost:${PORT}/camera?room=${encodeURIComponent(room)}`,
        gameUrl: `http://localhost:${PORT}/game?room=${encodeURIComponent(room)}`
      },
      network: networkLinks(room)
    };
    res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  const target = resolvePublicPath(url.pathname);
  if (!target) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

function encodeFrame(payload, opcode = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;

  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function parseFrame(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) throw new Error("WebSocket payload too large");
    length = low;
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    bytes: offset + length
  };
}

function removeClient(client) {
  if (client.closed) return;
  client.closed = true;
  const room = getRoom(client.room);
  room.delete(client);
  broadcastRoomState(client.room);
}

function handleMessage(client, text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    sendJson(client, { type: "error", message: "Invalid JSON" });
    return;
  }

  if (payload.type === "ping") {
    sendJson(client, { type: "pong", serverTime: Date.now() });
    return;
  }

  const message = {
    ...payload,
    room: client.room,
    sender: {
      id: client.id,
      role: client.role
    },
    serverTime: Date.now()
  };

  broadcast(client.room, message, client);
}

function handleSocketData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length > 0) {
    const parsed = parseFrame(client.buffer);
    if (!parsed) break;

    client.buffer = client.buffer.subarray(parsed.bytes);

    if (parsed.opcode === 0x8) {
      client.socket.end(encodeFrame(Buffer.alloc(0), 0x8));
      removeClient(client);
      return;
    }

    if (parsed.opcode === 0x9) {
      client.socket.write(encodeFrame(parsed.payload, 0xA));
      continue;
    }

    if (parsed.opcode !== 0x1) continue;
    handleMessage(client, parsed.payload.toString("utf8"));
  }
}

const server = http.createServer(serveStatic);

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    id: crypto.randomUUID(),
    room: cleanRoom(url.searchParams.get("room")),
    role: String(url.searchParams.get("role") || "guest").slice(0, 24),
    connectedAt: Date.now(),
    socket,
    buffer: Buffer.alloc(0),
    closed: false
  };

  getRoom(client.room).add(client);
  sendJson(client, {
    type: "hello",
    id: client.id,
    room: client.room,
    peers: roomSnapshot(client.room),
    serverTime: Date.now()
  });
  broadcastRoomState(client.room);

  socket.on("data", (chunk) => {
    try {
      handleSocketData(client, chunk);
    } catch (error) {
      sendJson(client, { type: "error", message: error.message });
      socket.destroy();
      removeClient(client);
    }
  });
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
});

server.listen(PORT, "0.0.0.0", () => {
  const room = cleanRoom(process.env.ROOM || "DEMO");
  console.log(`WebXR CV Game running on http://localhost:${PORT}`);
  console.log(`Camera: http://localhost:${PORT}/camera?room=${room}`);
  console.log("Phone game URLs:");
  for (const link of networkLinks(room)) {
    console.log(`- ${link.gameUrl}`);
  }
});

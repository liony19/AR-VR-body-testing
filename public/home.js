import { cleanRoom, getServerInfo, randomRoom, resolveRoom, setRoomInUrl } from "./ws.js";

const roomInput = document.querySelector("#roomInput");
const newRoomButton = document.querySelector("#newRoomButton");
const refreshLinksButton = document.querySelector("#refreshLinksButton");
const cameraLink = document.querySelector("#cameraLink");
const gameLink = document.querySelector("#gameLink");
const networkLinks = document.querySelector("#networkLinks");
const homeStatus = document.querySelector("#homeStatus");

let room = resolveRoom();
roomInput.value = room;

function setLinks() {
  const encoded = encodeURIComponent(room);
  cameraLink.href = `/camera?room=${encoded}`;
  gameLink.href = `/game?room=${encoded}`;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "copiado";
    setTimeout(() => {
      button.textContent = label;
    }, 900);
  } catch {
    button.textContent = "copie manual";
  }
}

async function renderNetworkLinks() {
  setLinks();
  networkLinks.innerHTML = '<p class="muted-copy">buscando IP local...</p>';
  homeStatus.textContent = "rede";

  try {
    const info = await getServerInfo(room);
    const rows = [];

    rows.push({
      label: "Notebook",
      url: info.local.cameraUrl
    });

    for (const entry of info.network) {
      rows.push({
        label: `Celular ${entry.address}`,
        url: entry.gameUrl
      });
    }

    networkLinks.innerHTML = "";
    for (const row of rows) {
      const wrapper = document.createElement("div");
      wrapper.className = "link-row";

      const label = document.createElement("strong");
      label.textContent = row.label;

      const anchor = document.createElement("a");
      anchor.href = row.url;
      anchor.textContent = row.url;

      const button = document.createElement("button");
      button.className = "icon-button";
      button.type = "button";
      button.textContent = "copiar";
      button.addEventListener("click", () => copyText(row.url, button));

      wrapper.append(label, anchor, button);
      networkLinks.append(wrapper);
    }

    if (rows.length === 1) {
      const empty = document.createElement("p");
      empty.className = "muted-copy";
      empty.textContent = "Nenhum IP de rede foi detectado alem do localhost.";
      networkLinks.append(empty);
    }
  } catch {
    networkLinks.innerHTML = '<p class="muted-copy">Servidor indisponivel.</p>';
    homeStatus.textContent = "offline";
  }
}

newRoomButton.addEventListener("click", () => {
  room = setRoomInUrl(randomRoom());
  roomInput.value = room;
  renderNetworkLinks();
});

roomInput.addEventListener("input", () => {
  const nextRoom = cleanRoom(roomInput.value);
  roomInput.value = nextRoom;
  room = setRoomInUrl(nextRoom, true);
  renderNetworkLinks();
});

refreshLinksButton.addEventListener("click", renderNetworkLinks);

renderNetworkLinks();

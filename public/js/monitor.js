/* Uebersichtstafel: welcher Patient wurde zuletzt in welchen Raum gerufen. */
"use strict";
const token = new URLSearchParams(location.search).get("token") || "";

const board = document.getElementById("board");
const conn = document.getElementById("conn");
/** Letzter Aufruf je Raum. */
const perRoom = new Map();
let rooms = [];

function tickClock() {
  document.getElementById("clock").textContent =
    new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}
tickClock();
setInterval(tickClock, 10000);

function relative(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function render(freshRoom) {
  board.replaceChildren();
  for (const room of rooms) {
    const call = perRoom.get(room.label);
    const tile = document.createElement("div");
    tile.className = "tile" + (freshRoom === room.label ? " fresh" : "");
    tile.style.setProperty("--room", room.color);

    const label = document.createElement("div");
    label.className = "room";
    label.textContent = room.label;

    const who = document.createElement("div");
    who.className = call ? "who" : "who empty";
    who.textContent = call ? call.headline : "frei";

    const when = document.createElement("div");
    when.className = "when";
    when.textContent = call ? relative(call.at) : "";

    tile.append(label, who, when);
    board.appendChild(tile);
  }
}

async function load() {
  try {
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    const [stateRes, configRes] = await Promise.all([
      fetch(`/api/display/state${q}`, { credentials: "same-origin" }),
      fetch(`/api/config`, { credentials: "same-origin" }),
    ]);
    const state = await stateRes.json();
    const config = await configRes.json();

    rooms = config.practice.rooms;
    document.getElementById("practiceName").textContent = state.practice.name || "Praxis";
    document.title = `Monitor – ${state.practice.name || "Praxis"}`;

    // Neueste Aufrufe zuerst eintragen, damit je Raum der jüngste gewinnt.
    for (const call of [...state.recent].reverse()) perRoom.set(call.room, call);
    render();
  } catch (err) {
    console.warn("[Monitor] Laden fehlgeschlagen:", err.message);
  }
}

const socket = io({ auth: { role: "display", token }, transports: ["websocket", "polling"] });
socket.on("connect", () => { conn.dataset.state = "on"; load(); });
socket.on("disconnect", () => { conn.dataset.state = "off"; });
socket.on("call:new", (payload) => {
  if (payload.call) {
    perRoom.set(payload.call.room, payload.call);
    render(payload.call.room);
  }
});
socket.on("display:refresh", () => { perRoom.clear(); load(); });

load();
setInterval(() => render(), 60000);

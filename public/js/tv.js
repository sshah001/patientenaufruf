/* Wartezimmer-Anzeige: Popup beim Aufruf, Laufband mit den letzten Aufrufen. */
"use strict";

const params = new URLSearchParams(window.location.search);
const displayToken = params.get("token") || "";

const dom = {
  practice: document.getElementById("practiceName"),
  clock: document.getElementById("clock"),
  welcome: document.getElementById("welcome"),
  lastcalls: document.getElementById("lastcalls"),
  ticker: document.getElementById("ticker"),
  popup: document.getElementById("popup"),
  popupName: document.getElementById("popupName"),
  popupRoom: document.getElementById("popupRoom"),
  popupTimer: document.getElementById("popupTimer"),
  message: document.getElementById("message"),
  messageText: document.getElementById("messageText"),
  messageTimer: document.getElementById("messageTimer"),
  conn: document.getElementById("conn"),
};

let popupTimeout = null;
let messageTimeout = null;
let settings = { popupSeconds: 18, tickerEnabled: true, tickerCount: 3 };

// -------------------------------------------------------------------- Uhr
function tickClock() {
  dom.clock.textContent = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}
tickClock();
setInterval(tickClock, 10000);

// ------------------------------------------------------------- Darstellung

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "gerade eben";
  if (seconds < 3600) return `vor ${Math.round(seconds / 60)} Min.`;
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function renderRecent(calls) {
  dom.lastcalls.replaceChildren();
  dom.ticker.replaceChildren();

  if (!calls || calls.length === 0) {
    dom.welcome.textContent = "Herzlich willkommen";
    dom.ticker.classList.add("paused");
    return;
  }
  dom.welcome.textContent = "Herzlich willkommen";
  dom.ticker.classList.toggle("paused", !settings.tickerEnabled);

  for (const call of calls) {
    // Liste in der Bildmitte
    const row = document.createElement("div");
    row.className = "lastcall";
    row.style.setProperty("--room", call.roomColor || "#2f6f9f");

    const who = document.createElement("span");
    who.className = "who";
    who.textContent = call.headline;

    const room = document.createElement("span");
    room.className = "room";
    room.textContent = call.room;

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = relativeTime(call.at);

    row.append(who, room, when);
    dom.lastcalls.appendChild(row);

    // Laufband unten
    if (settings.tickerEnabled) {
      const item = document.createElement("span");
      item.className = "item";
      item.style.setProperty("--room", call.roomColor || "#2f6f9f");

      const dot = document.createElement("span");
      dot.className = "dot";
      const text = document.createElement("span");
      text.textContent = call.headline;
      const roomText = document.createElement("span");
      roomText.className = "room";
      roomText.textContent = `→ ${call.room}`;

      item.append(dot, text, roomText);
      dom.ticker.appendChild(item);
    }
  }

  // Laufband neu starten, damit der neue Eintrag sofort erscheint.
  if (settings.tickerEnabled) {
    dom.ticker.style.animation = "none";
    void dom.ticker.offsetWidth;
    dom.ticker.style.animation = "";
  }
}

function showPopup(call) {
  const seconds = settings.popupSeconds || 18;
  const color = call.roomColor || "#2f6f9f";

  // Ein Patientenaufruf hat Vorrang vor einer noch stehenden Durchsage.
  // Ohne das bliebe der Aufruf hinter der Durchsage verborgen – der Ton
  // liefe, aber auf dem Fernseher wäre nichts zu sehen.
  dom.message.dataset.show = "0";
  clearTimeout(messageTimeout);

  dom.popup.style.setProperty("--room", color);
  dom.popupName.textContent = call.headline;
  dom.popupRoom.textContent = call.room;

  // Balkenanimation neu starten
  dom.popupTimer.style.animation = "none";
  void dom.popupTimer.offsetWidth;
  dom.popupTimer.style.animation = `timer ${seconds}s linear forwards`;

  dom.popup.dataset.show = "1";

  clearTimeout(popupTimeout);
  popupTimeout = setTimeout(() => {
    dom.popup.dataset.show = "0";
  }, seconds * 1000);
}

/** Freie Durchsage als Volltext einblenden. */
function showMessage(text, seconds) {
  const dauer = seconds || settings.popupSeconds || 18;

  dom.messageText.textContent = text;

  dom.messageTimer.style.animation = "none";
  void dom.messageTimer.offsetWidth;
  dom.messageTimer.style.animation = `timer ${dauer}s linear forwards`;

  // Eine Durchsage hat Vorrang vor einem noch stehenden Patientenaufruf.
  dom.popup.dataset.show = "0";
  clearTimeout(popupTimeout);

  dom.message.dataset.show = "1";
  clearTimeout(messageTimeout);
  messageTimeout = setTimeout(() => {
    dom.message.dataset.show = "0";
  }, dauer * 1000);
}

// -------------------------------------------------------------- Verbindung

const socket = io({
  auth: { role: "display", token: displayToken },
  transports: ["websocket", "polling"],
  reconnectionDelayMax: 5000,
});

socket.on("connect", () => {
  dom.conn.dataset.state = "on";
  loadState();
});

socket.on("disconnect", () => {
  dom.conn.dataset.state = "off";
});

socket.on("connect_error", (err) => {
  dom.conn.dataset.state = "off";
  console.warn("[TV] Verbindung fehlgeschlagen:", err.message);
});

socket.on("call:new", (payload) => {
  if (payload.popupSeconds) settings.popupSeconds = payload.popupSeconds;
  if (payload.call) showPopup(payload.call);
  renderRecent(payload.recent);
});

socket.on("announcement:new", (payload) => {
  if (payload.text) showMessage(payload.text, payload.seconds);
});

socket.on("display:refresh", (payload) => {
  dom.popup.dataset.show = "0";
  dom.message.dataset.show = "0";
  renderRecent(payload.recent);
});

// Ausgangszustand laden (auch nach einem Neustart des Fernsehers).
async function loadState() {
  try {
    const url = displayToken ? `/api/display/state?token=${encodeURIComponent(displayToken)}` : "/api/display/state";
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json();

    settings = { ...settings, ...data.overlay };
    dom.practice.textContent = data.practice.name || "Praxis";
    document.title = `Wartezimmer – ${data.practice.name || "Praxis"}`;
    renderRecent(data.recent);
  } catch (err) {
    console.warn("[TV] Zustand konnte nicht geladen werden:", err.message);
  }
}

loadState();

// Zeitangaben im Ruhezustand regelmäßig auffrischen.
setInterval(() => {
  if (dom.popup.dataset.show !== "1" && dom.message.dataset.show !== "1") loadState();
}, 60000);

// Bildschirm wach halten, soweit der Browser das erlaubt.
if ("wakeLock" in navigator) {
  const requestLock = () => navigator.wakeLock.request("screen").catch(() => {});
  requestLock();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestLock();
  });
}

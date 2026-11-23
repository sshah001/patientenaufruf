"use strict";
/**
 * Wartezimmer-Anzeige.
 *
 * Drei Betriebsarten (config.signage.mode):
 *
 *  "overlay"  EMPFOHLEN. Der Fernseher zeigt dauerhaft unsere Seite /tv als
 *             piSignage-Asset (.link). Diese Seite hält eine WebSocket-
 *             Verbindung zum Server und blendet Aufrufe selbst ein – ohne
 *             Verzögerung, ohne API-Aufruf, und sie funktioniert auch dann
 *             noch, wenn die piSignage-API zickt.
 *
 *  "notice"   Der Aufruf wird über die piSignage-Notice-API eingeblendet.
 *
 *  "asset"    Ein vorbereitetes Asset wird kurz abgespielt und danach zur
 *             Standard-Playlist zurückgewechselt.
 *
 * Unabhängig davon führt dieses Modul die Liste der letzten Aufrufe, aus der
 * Laufband und RSS-Feed gespeist werden.
 */
const config = require("../../config");
const log = require("../../util/logger")("signage");
const client = require("./pisignageClient");
const { displayName, salutation } = require("../../util/text");

/** Ringpuffer der letzten Aufrufe (im Speicher, für Ticker und RSS). */
const recentCalls = [];
const MAX_RECENT = 20;

let lastProbe = null;

function enabled() {
  return Boolean(config.signage.enabled);
}

/** Aufbereitete Darstellung eines Aufrufs für alle Anzeigen. */
function toDisplayCall(patient, room) {
  const anrede = salutation(patient.gender);
  const name = displayName(patient, config.privacy);
  return {
    id: String(patient._id || patient.id || ""),
    salutation: anrede,
    name,
    headline: [anrede, name].filter(Boolean).join(" "),
    room: room.label || room,
    roomColor: room.color || "#2563eb",
    at: new Date().toISOString(),
  };
}

/** Nimmt einen Aufruf in den Ringpuffer auf. */
function record(call) {
  recentCalls.unshift(call);
  recentCalls.length = Math.min(recentCalls.length, MAX_RECENT);
  return call;
}

/** Die letzten N Aufrufe (für Ticker, RSS, Monitorseite). */
function recent(count) {
  const n = count || config.signage.overlay.tickerCount || 3;
  return recentCalls.slice(0, n);
}

function lastCall() {
  return recentCalls[0] || null;
}

/**
 * Meldet einen Aufruf an die Wartezimmer-Anzeige.
 * Wird vom Aufruf-Ablauf VOR der Audiowiedergabe aufgerufen, damit Bild und
 * Ton gemeinsam einsetzen.
 *
 * @returns {Promise<{ok:boolean, mode:string, detail?:string}>}
 */
async function announce(patient, room) {
  const call = record(toDisplayCall(patient, room));

  if (!enabled()) {
    return { ok: true, mode: "disabled", call, detail: "piSignage ist deaktiviert; nur Browser-Anzeigen aktualisiert." };
  }

  const mode = config.signage.mode;

  try {
    if (mode === "overlay") {
      // Die /tv-Seite bekommt den Aufruf über WebSocket – hier ist nichts zu tun.
      return { ok: true, mode, call };
    }

    if (mode === "notice") {
      const text = `${call.headline} – ${call.room}`;
      const result = await client.showNotice(text, config.signage.notice.durationSec);
      if (!result.ok) log.warn("Notice fehlgeschlagen:", result.error);
      return { ok: result.ok, mode, call, detail: result.error || result.via };
    }

    if (mode === "asset") {
      const { filename, durationSec, defaultPlaylist } = config.signage.asset;
      const result = await client.playAsset(filename, durationSec);
      if (!result.ok) {
        log.warn("Asset-Anzeige fehlgeschlagen:", result.error);
        return { ok: false, mode, call, detail: result.error };
      }
      // Nach Ablauf zurück zur regulären Playlist.
      if (defaultPlaylist) {
        setTimeout(() => {
          client.playPlaylist(defaultPlaylist).catch((err) => log.warn("Rückkehr zur Playlist fehlgeschlagen:", err.message));
        }, durationSec * 1000);
      }
      return { ok: true, mode, call, detail: result.via };
    }

    return { ok: false, mode, call, detail: `Unbekannter Anzeigemodus "${mode}".` };
  } catch (err) {
    log.error("Anzeige fehlgeschlagen:", err.message);
    return { ok: false, mode, call, detail: err.message };
  }
}

/** Leert die Anzeige (z. B. am Praxisende). */
function clear() {
  recentCalls.length = 0;
}

/**
 * Stellt den Aufrufverlauf nach einem Serverneustart aus dem Protokoll wieder her.
 *
 * Ohne das wäre der Wartezimmer-Ticker nach jedem Neustart leer, bis der
 * nächste Patient gerufen wird – mitten in der Sprechstunde ein sichtbarer
 * Aussetzer auf dem Fernseher.
 */
async function restoreRecent() {
  const CallLogs = require("../../db/callLogs");

  const seit = new Date(Date.now() - 4 * 3600 * 1000); // nur die letzten vier Stunden
  let entries = [];
  try {
    entries = CallLogs.since(seit, { excludeResult: "failed", limit: MAX_RECENT });
  } catch {
    entries = [];
  }

  recentCalls.length = 0;
  for (const entry of entries) {
    const room = config.practice.rooms.find((r) => r.id === entry.roomId);
    const patient = { _id: entry.patientId, lastName: entry.lastName, gender: entry.gender };
    const call = toDisplayCall(patient, room || { label: entry.room });
    call.at = new Date(entry.createdAt).toISOString();
    recentCalls.push(call);
  }

  if (recentCalls.length) {
    log.info(`Aufrufverlauf wiederhergestellt: ${recentCalls.length} Einträge der letzten Stunden.`);
  }
  return recentCalls.length;
}

/** Beim Serverstart einmal prüfen, ob das Gerät erreichbar ist. */
async function verifyOnStart() {
  if (!enabled() || !config.signage.verifyOnStart) return null;
  lastProbe = await client.probe({ full: false });
  if (lastProbe.reachable) {
    log.info(`piSignage erreichbar unter ${lastProbe.baseUrl}.`);
  } else {
    log.warn(`piSignage nicht erreichbar: ${lastProbe.hint}`);
  }
  return lastProbe;
}

async function status() {
  return {
    enabled: enabled(),
    mode: config.signage.mode,
    host: config.signage.host,
    port: config.signage.port,
    tvUrl: `${config.app.publicUrl}/tv`,
    lastProbe,
    recentCount: recentCalls.length,
    lastCall: lastCall(),
  };
}

module.exports = {
  announce,
  recent,
  lastCall,
  record,
  clear,
  status,
  verifyOnStart,
  restoreRecent,
  toDisplayCall,
  client,
};

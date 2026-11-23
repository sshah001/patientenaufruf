"use strict";
/**
 * Mopidy-Anbindung über JSON-RPC.
 *
 * Mopidy holt sich die Audiodatei per HTTP von diesem Server (deshalb muss
 * APP_PUBLIC_URL eine im Netz erreichbare Adresse sein) und gibt sie über
 * Snapcast an die Lautsprecher aus.
 *
 * Gegenüber der Vorversion:
 *   - jeder RPC-Aufruf hat ein Zeitlimit (vorher konnte ein hängendes Mopidy
 *     den Node-Prozess dauerhaft blockieren),
 *   - das Warten auf das Ende der Wiedergabe bricht spätestens nach
 *     `maxPlaybackMs` ab,
 *   - die vorherige Wiedergabe (z. B. Wartezimmermusik) kann auf Wunsch
 *     danach fortgesetzt werden.
 */
const axios = require("axios");
const config = require("../../config");
const log = require("../../util/logger")("mopidy");

let rpcId = 0;

function enabled() {
  return Boolean(config.mopidy.enabled && config.mopidy.rpcUrl);
}

/** Ein einzelner JSON-RPC-Aufruf. */
async function rpc(method, params = {}, { timeoutMs } = {}) {
  if (!enabled()) {
    throw new Error("Mopidy ist deaktiviert oder ohne rpcUrl konfiguriert.");
  }

  rpcId += 1;
  const body = { jsonrpc: "2.0", id: rpcId, method, params };

  const response = await axios.post(config.mopidy.rpcUrl, body, {
    timeout: timeoutMs || config.mopidy.requestTimeoutMs,
    headers: { "Content-Type": "application/json" },
  });

  if (response.data && response.data.error) {
    const err = response.data.error;
    throw new Error(`Mopidy-Fehler bei ${method}: ${err.message || JSON.stringify(err)}`);
  }
  return response.data ? response.data.result : undefined;
}

const getState = () => rpc("core.playback.get_state");
const stop = () => rpc("core.playback.stop");
const getVolume = () => rpc("core.mixer.get_volume");
const setVolume = (volume) => rpc("core.mixer.set_volume", { volume });
const getCurrentTlTrack = () => rpc("core.playback.get_current_tl_track");

/** Erreichbarkeit und Version prüfen. */
async function ping() {
  if (!enabled()) {
    return { ok: false, enabled: false, error: "Mopidy ist in der Konfiguration deaktiviert." };
  }
  try {
    const version = await rpc("core.get_version", {}, { timeoutMs: 3000 });
    const state = await getState();
    let volume = null;
    try {
      volume = await getVolume();
    } catch {
      /* Mixer nicht vorhanden – bei Snapcast normal */
    }
    return { ok: true, enabled: true, version, state, volume, rpcUrl: config.mopidy.rpcUrl };
  } catch (err) {
    return { ok: false, enabled: true, error: err.message, rpcUrl: config.mopidy.rpcUrl };
  }
}

/**
 * Spielt eine per HTTP erreichbare Audiodatei ab und wartet, bis sie zu Ende ist.
 *
 * @param {string} url         Vollständige URL der WAV-Datei.
 * @param {object} opts        { expectedMs?: number, signal?: AbortSignal }
 * @returns {Promise<{ok:boolean, playedMs:number, error?:string}>}
 */
async function playUrlAndWait(url, opts = {}) {
  const started = Date.now();

  if (!enabled()) {
    return { ok: false, playedMs: 0, error: "Mopidy ist deaktiviert." };
  }

  const pollMs = Math.max(100, config.mopidy.pollIntervalMs);
  // Zeitlimit: bekannte Dauer plus Puffer, höchstens aber maxPlaybackMs.
  const budgetMs = Math.min(
    config.mopidy.maxPlaybackMs,
    opts.expectedMs ? opts.expectedMs + 8000 : config.mopidy.maxPlaybackMs
  );

  let previousVolume = null;

  try {
    if (config.mopidy.volume != null) {
      previousVolume = await getVolume().catch(() => null);
      await setVolume(config.mopidy.volume).catch(() => {});
    }

    await rpc("core.tracklist.clear");
    const added = await rpc("core.tracklist.add", { uris: [url] });
    if (!added || added.length === 0) {
      throw new Error(`Mopidy konnte die Audiodatei nicht laden: ${url}. Ist die Adresse von Mopidy aus erreichbar?`);
    }

    await rpc("core.playback.play");
    log.debug("Wiedergabe gestartet:", url);

    // Kurz warten, bis Mopidy tatsächlich in "playing" wechselt.
    let state = "stopped";
    const startDeadline = Date.now() + 5000;
    while (Date.now() < startDeadline) {
      state = await getState();
      if (state === "playing") break;
      await sleep(pollMs);
    }

    // Auf das Ende warten.
    while (Date.now() - started < budgetMs) {
      if (opts.signal && opts.signal.aborted) {
        await stop().catch(() => {});
        return { ok: false, playedMs: Date.now() - started, error: "Abgebrochen." };
      }
      state = await getState();
      if (state !== "playing") break;
      await sleep(pollMs);
    }

    const playedMs = Date.now() - started;

    if (state === "playing") {
      log.warn(`Wiedergabe nach ${playedMs} ms abgebrochen (Zeitlimit erreicht).`);
      await stop().catch(() => {});
      return { ok: false, playedMs, error: "Zeitlimit der Wiedergabe erreicht." };
    }

    return { ok: true, playedMs };
  } catch (err) {
    log.error("Wiedergabe fehlgeschlagen:", err.message);
    return { ok: false, playedMs: Date.now() - started, error: err.message };
  } finally {
    if (previousVolume != null) {
      await setVolume(previousVolume).catch(() => {});
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  rpc,
  ping,
  enabled,
  getState,
  stop,
  getVolume,
  setVolume,
  getCurrentTlTrack,
  playUrlAndWait,
};

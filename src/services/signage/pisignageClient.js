"use strict";
/**
 * piSignage-Player-API.
 *
 * Die Vorversion probierte bei JEDEM Patientenaufruf acht verschiedene
 * Endpunkte durch und protokollierte sieben Fehlschläge. Hier stattdessen:
 *
 *   - `probe()` ermittelt EINMAL (beim Start oder auf Knopfdruck), welche
 *     Endpunkte dieses Gerät tatsächlich versteht,
 *   - das Ergebnis wird gemerkt und danach gezielt der passende Aufruf benutzt,
 *   - der empfohlene Betriebsmodus "overlay" kommt ganz ohne Aufruf-API aus:
 *     der Fernseher zeigt unsere eigene Seite als Asset an und bekommt die
 *     Aufrufe live über WebSocket. Das ist der zuverlässigste Weg.
 */
const axios = require("axios");
const config = require("../../config");
const log = require("../../util/logger")("signage");

/** Merkt sich, welcher Endpunkt für welche Aktion funktioniert. */
let capabilities = null;

function baseUrl() {
  return `http://${config.signage.host}:${config.signage.port}`;
}

function requestOptions(extra = {}) {
  return {
    timeout: config.signage.requestTimeoutMs,
    auth: {
      username: config.secrets.signageUser,
      password: config.secrets.signagePassword || "",
    },
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true, // Statuscode selbst auswerten
    ...extra,
  };
}

async function call(method, endpoint, data) {
  const url = `${baseUrl()}${endpoint}`;
  try {
    const response =
      method === "GET"
        ? await axios.get(url, requestOptions())
        : await axios.post(url, data ?? {}, requestOptions());

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data: response.data,
      endpoint,
      method,
    };
  } catch (err) {
    return { ok: false, status: 0, error: err.message, endpoint, method };
  }
}

/** Kandidaten je Aktion – geordnet nach Verbreitung über die piSignage-Versionen. */
const ENDPOINTS = {
  status: [
    { method: "GET", path: "/api/status" },
    { method: "GET", path: "/api/settings" },
  ],
  notice: [
    { method: "POST", path: "/api/notice", body: (text, sec) => ({ msg: text, duration: sec }) },
    { method: "POST", path: "/api/notices", body: (text, sec) => ({ msg: text, duration: sec }) },
    { method: "POST", path: "/api/ticker", body: (text, sec) => ({ msg: text, duration: sec, enable: true }) },
  ],
  playFile: [
    { method: "POST", path: "/api/play/files/play", body: (file, sec) => ({ file, duration: sec }) },
    { method: "POST", path: "/api/playfile", body: (file, sec) => ({ file, duration: sec }) },
  ],
  playlist: [
    { method: "POST", path: "/api/play/playlists/play", body: (name) => ({ name }) },
    { method: "POST", path: "/api/playlists/play", body: (name) => ({ name }) },
  ],
};

/**
 * Prüft die Erreichbarkeit und ermittelt die unterstützten Endpunkte.
 * Nur Status-Endpunkte werden automatisch getestet; alles Weitere nur, wenn
 * `full` gesetzt ist (das löst sichtbare Aktionen auf dem Fernseher aus).
 */
async function probe({ full = false, sampleText = "Anzeigetest" } = {}) {
  const results = { reachable: false, baseUrl: baseUrl(), status: null, endpoints: {}, checkedAt: new Date().toISOString() };

  for (const candidate of ENDPOINTS.status) {
    const res = await call(candidate.method, candidate.path);
    results.endpoints[candidate.path] = { ok: res.ok, status: res.status, error: res.error };
    if (res.ok) {
      results.reachable = true;
      results.status = res.data;
      capabilities = { ...(capabilities || {}), status: candidate.path };
      break;
    }
    if (res.status === 401 || res.status === 403) {
      results.authFailed = true;
      results.hint = "Benutzername oder Passwort für piSignage stimmt nicht (SIGNAGE_USER / SIGNAGE_PASSWORD).";
    }
  }

  if (!results.reachable && !results.hint) {
    results.hint = `piSignage unter ${baseUrl()} nicht erreichbar. Läuft das Gerät, und stimmen SIGNAGE_HOST/SIGNAGE_PORT?`;
  }

  if (full && results.reachable) {
    for (const candidate of ENDPOINTS.notice) {
      const res = await call(candidate.method, candidate.path, candidate.body(sampleText, 5));
      results.endpoints[candidate.path] = { ok: res.ok, status: res.status, error: res.error };
      if (res.ok) {
        capabilities = { ...(capabilities || {}), notice: candidate };
        break;
      }
    }
  }

  results.capabilities = capabilities;
  return results;
}

/** Blendet eine Kurznachricht auf dem Fernseher ein. */
async function showNotice(text, seconds) {
  const candidates = capabilities?.notice ? [capabilities.notice] : ENDPOINTS.notice;

  for (const candidate of candidates) {
    const res = await call(candidate.method, candidate.path, candidate.body(text, seconds));
    if (res.ok) {
      capabilities = { ...(capabilities || {}), notice: candidate };
      return { ok: true, via: candidate.path };
    }
  }
  return { ok: false, error: "Kein passender Notice-Endpunkt auf diesem piSignage-Gerät gefunden. Bitte /api/diagnostics/signage ausführen." };
}

/** Spielt ein hochgeladenes Asset (z. B. eine .link-Datei) einmalig ab. */
async function playAsset(filename, seconds) {
  const candidates = capabilities?.playFile ? [capabilities.playFile] : ENDPOINTS.playFile;

  for (const candidate of candidates) {
    const res = await call(candidate.method, candidate.path, candidate.body(filename, seconds));
    if (res.ok) {
      capabilities = { ...(capabilities || {}), playFile: candidate };
      return { ok: true, via: candidate.path };
    }
  }
  return { ok: false, error: `Asset "${filename}" konnte nicht abgespielt werden.` };
}

/** Wechselt zurück zur regulären Playlist. */
async function playPlaylist(name) {
  const candidates = capabilities?.playlist ? [capabilities.playlist] : ENDPOINTS.playlist;

  for (const candidate of candidates) {
    const res = await call(candidate.method, candidate.path, candidate.body(name));
    if (res.ok) {
      capabilities = { ...(capabilities || {}), playlist: candidate };
      return { ok: true, via: candidate.path };
    }
  }
  return { ok: false, error: `Playlist "${name}" konnte nicht gestartet werden.` };
}

function reset() {
  capabilities = null;
}

module.exports = { probe, showNotice, playAsset, playPlaylist, call, baseUrl, reset };

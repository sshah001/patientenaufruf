"use strict";
/**
 * Tabelle `call_logs` – Protokoll jedes Aufrufs und jeder Durchsage.
 *
 * Zweck: Nachvollziehbarkeit im Praxisalltag ("wurde Frau X schon gerufen?"),
 * Grundlage für den Wartezimmer-Ticker und für Auswertungen (Wartezeiten).
 *
 * Datenschutz: Einträge älter als `privacy.callLogRetentionDays` werden beim
 * Start und danach stündlich gelöscht (purgeExpired).
 */
const config = require("../config");
const { handle } = require("./connect");
const { newId, toIso, toDate } = require("./util");

const DEFAULT_CHANNELS = { audio: "skipped", signage: "skipped", browser: "ok" };
const COLUMNS = [
  "kind",
  "patientId",
  "lastName",
  "gender",
  "roomId",
  "room",
  "spokenText",
  "voice",
  "result",
  "error",
  "audioMs",
  "repeatCount",
  "channels",
  "triggeredBy",
];

function toDb(key, value) {
  if (key === "channels") return JSON.stringify({ ...DEFAULT_CHANNELS, ...(value || {}) });
  if (key === "patientId") return value === null || value === undefined ? null : String(value);
  if (key === "audioMs" || key === "repeatCount") return Math.round(Number(value) || 0);
  return String(value ?? "");
}

function fromRow(row) {
  if (!row) return null;
  let channels = DEFAULT_CHANNELS;
  try {
    channels = JSON.parse(row.channels);
  } catch {
    /* Standardwerte */
  }
  return { ...row, _id: row.id, channels, createdAt: toDate(row.createdAt) };
}

/** Legt einen Eintrag an und liefert ihn zurück (mit `id`). */
function create(data) {
  const row = { id: newId(), createdAt: toIso(data.createdAt) || new Date().toISOString() };
  for (const key of COLUMNS) {
    if (data[key] !== undefined) row[key] = toDb(key, data[key]);
  }
  const cols = Object.keys(row);
  handle()
    .prepare(`INSERT INTO call_logs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((c) => row[c]));
  return get(row.id);
}

function get(id) {
  return fromRow(handle().prepare("SELECT * FROM call_logs WHERE id = ?").get(String(id)));
}

/** Ändert Felder eines Eintrags (z. B. Ergebnis nach der Ansage). */
function update(id, data) {
  const cols = COLUMNS.filter((key) => data[key] !== undefined);
  if (!cols.length) return get(id);
  handle()
    .prepare(`UPDATE call_logs SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .run(...cols.map((c) => toDb(c, data[c])), String(id));
  return get(id);
}

/** Die neuesten Einträge, optional nur einer Art. */
function recent({ kind, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 50));
  const rows = kind
    ? handle().prepare("SELECT * FROM call_logs WHERE kind = ? ORDER BY createdAt DESC LIMIT ?").all(kind, lim)
    : handle().prepare("SELECT * FROM call_logs ORDER BY createdAt DESC LIMIT ?").all(lim);
  return rows.map(fromRow);
}

/** Einträge seit `date`, neueste zuerst, ohne die mit Ergebnis `excludeResult`. */
function since(date, { excludeResult, limit = 100 } = {}) {
  const rows = handle()
    .prepare("SELECT * FROM call_logs WHERE createdAt >= ? AND result != ? ORDER BY createdAt DESC LIMIT ?")
    .all(toIso(date), excludeResult ?? "", Math.max(1, Number(limit) || 100));
  return rows.map(fromRow);
}

/** Löscht Einträge jenseits der Aufbewahrungsfrist. Liefert die Anzahl. */
function purgeExpired(days = config.privacy.callLogRetentionDays) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(days) || 30) * 24 * 3600 * 1000);
  return Number(handle().prepare("DELETE FROM call_logs WHERE createdAt < ?").run(cutoff.toISOString()).changes);
}

function removeAll() {
  return Number(handle().prepare("DELETE FROM call_logs").run().changes);
}

module.exports = { create, get, update, recent, since, purgeExpired, removeAll };

"use strict";
/**
 * Tabelle `patients` – ein Eintrag = ein Termin des heutigen Tages.
 *
 * `externalId` ist der Schlüssel aus dem Quellsystem (Doctolib). Darüber
 * erkennt der Import Wiederholungen und aktualisiert bestehende Einträge,
 * statt die Liste jedes Mal zu löschen und neu anzulegen.
 *
 * Zurückgegeben werden einfache Objekte. Sie tragen die Kennung sowohl als
 * `id` als auch als `_id`, damit Oberfläche und Anzeigen unverändert bleiben.
 */
const { handle, transaction } = require("./connect");
const { newId, toIso, toDate, translateError } = require("./util");

const STATUSES = ["waiting", "called", "in_treatment", "completed", "no_show"];
const GENDERS = ["male", "female", "other"];

/** Spalten, die von außen gesetzt werden dürfen, mit Umwandlung in DB-Werte. */
const WRITABLE = {
  firstName: (v) => String(v ?? "").trim(),
  lastName: (v) => String(v ?? "").trim(),
  gender: (v) => (GENDERS.includes(v) ? v : "other"),
  appointmentAt: toIso,
  appointmentRaw: (v) => String(v ?? ""),
  status: (v) => v,
  room: (v) => String(v ?? ""),
  roomId: (v) => String(v ?? ""),
  calledAt: toIso,
  callCount: (v) => Number(v) || 0,
  externalId: (v) => (v === null || v === undefined || v === "" ? null : String(v)),
  agendaId: (v) => String(v ?? ""),
  practitioner: (v) => String(v ?? ""),
  visitMotive: (v) => String(v ?? ""),
  note: (v) => String(v ?? ""),
  source: (v) => String(v ?? "manual"),
  importBatch: (v) => String(v ?? ""),
};

/** Sortierung der Arbeitsliste – entspricht der früheren {status, appointmentAt, createdAt}. */
const ORDER = "ORDER BY status, appointmentAt, createdAt";

function fromRow(row) {
  if (!row) return null;
  return {
    ...row,
    _id: row.id,
    appointmentAt: toDate(row.appointmentAt),
    calledAt: toDate(row.calledAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    fullName: `${row.firstName} ${row.lastName}`.trim(),
  };
}

function pickWritable(data) {
  const out = {};
  for (const [key, convert] of Object.entries(WRITABLE)) {
    if (data[key] !== undefined) out[key] = convert(data[key]);
  }
  return out;
}

function insertOne(data) {
  if (!data.lastName || !String(data.lastName).trim()) {
    const err = new Error("Ein Nachname ist erforderlich.");
    err.status = 400;
    err.code = "VALIDATION";
    throw err;
  }
  const now = new Date().toISOString();
  const row = { id: newId(), status: "waiting", ...pickWritable(data), createdAt: now, updatedAt: now };
  const cols = Object.keys(row);
  try {
    handle()
      .prepare(`INSERT INTO patients (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...cols.map((c) => row[c]));
  } catch (err) {
    throw translateError(err);
  }
  return row.id;
}

/** Alle Patienten in Arbeitslisten-Reihenfolge, optional gefiltert. */
function list({ statuses, search } = {}) {
  let sql = "SELECT * FROM patients";
  const params = [];
  if (statuses && statuses.length) {
    sql += ` WHERE status IN (${statuses.map(() => "?").join(", ")})`;
    params.push(...statuses);
  }
  let rows = handle().prepare(`${sql} ${ORDER}`).all(...params).map(fromRow);

  // Suche in JavaScript statt per LIKE: SQLite vergleicht Umlaute sonst
  // case-sensitiv ("Öztürk" würde mit "öz" nicht gefunden).
  if (search) {
    const term = String(search).slice(0, 60).toLocaleLowerCase("de");
    rows = rows.filter(
      (p) => p.lastName.toLocaleLowerCase("de").includes(term) || p.firstName.toLocaleLowerCase("de").includes(term)
    );
  }
  return rows;
}

function get(id) {
  return fromRow(handle().prepare("SELECT * FROM patients WHERE id = ?").get(String(id)));
}

function create(data) {
  return get(insertOne(data));
}

function insertMany(items) {
  transaction(() => items.forEach(insertOne));
  return items.length;
}

/** Ändert Felder eines Patienten; liefert den neuen Stand oder null. */
function update(id, data) {
  const fields = pickWritable(data);
  if (fields.status !== undefined && !STATUSES.includes(fields.status)) {
    const err = new Error(`Unbekannter Status "${fields.status}".`);
    err.status = 400;
    err.code = "VALIDATION";
    throw err;
  }
  const cols = Object.keys(fields);
  if (cols.length) {
    try {
      handle()
        .prepare(`UPDATE patients SET ${cols.map((c) => `${c} = ?`).join(", ")}, updatedAt = ? WHERE id = ?`)
        .run(...cols.map((c) => fields[c]), new Date().toISOString(), String(id));
    } catch (err) {
      throw translateError(err);
    }
  }
  return get(id);
}

/** Setzt den Patienten auf "aufgerufen" und zählt die Aufrufe hoch. */
function markCalled(id, { room, roomId }) {
  const now = new Date().toISOString();
  handle()
    .prepare(
      "UPDATE patients SET status = 'called', room = ?, roomId = ?, calledAt = ?, callCount = callCount + 1, updatedAt = ? WHERE id = ?"
    )
    .run(String(room ?? ""), String(roomId ?? ""), now, now, String(id));
  return get(id);
}

function remove(id) {
  return handle().prepare("DELETE FROM patients WHERE id = ?").run(String(id)).changes > 0;
}

/** Löscht alle Patienten, oder nur die mit einem der angegebenen Status. */
function removeAll({ statuses } = {}) {
  if (statuses && statuses.length) {
    return Number(
      handle()
        .prepare(`DELETE FROM patients WHERE status IN (${statuses.map(() => "?").join(", ")})`)
        .run(...statuses).changes
    );
  }
  return Number(handle().prepare("DELETE FROM patients").run().changes);
}

/** Aufgerufene und laufende Behandlungen zurück in die Warteliste. */
function resetActive() {
  return Number(
    handle()
      .prepare(
        "UPDATE patients SET status = 'waiting', room = '', roomId = '', updatedAt = ? WHERE status IN ('called', 'in_treatment')"
      )
      .run(new Date().toISOString()).changes
  );
}

/** { waiting: 3, called: 1, … } */
function countByStatus() {
  const rows = handle().prepare("SELECT status, COUNT(*) AS n FROM patients GROUP BY status").all();
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

function count() {
  return Number(handle().prepare("SELECT COUNT(*) AS n FROM patients").get().n);
}

/**
 * Schreibt das Ergebnis eines Imports in EINER Transaktion: entweder kommt
 * alles an oder nichts – eine halb importierte Tagesliste gibt es nicht.
 */
function applyImport({ inserts = [], updates = [], deleteIds = [] }) {
  transaction(() => {
    for (const data of inserts) insertOne(data);
    for (const { id, fields } of updates) update(id, fields);
    const del = handle().prepare("DELETE FROM patients WHERE id = ?");
    for (const id of deleteIds) del.run(String(id));
  });
}

module.exports = {
  STATUSES,
  GENDERS,
  list,
  get,
  create,
  insertMany,
  update,
  markCalled,
  remove,
  removeAll,
  resetActive,
  countByStatus,
  count,
  applyImport,
};

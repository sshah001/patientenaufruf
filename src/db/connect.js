"use strict";
/**
 * Datenbank: SQLite über das in Node eingebaute Modul `node:sqlite`.
 *
 * Früher lief hier MongoDB. Für eine Tagesliste mit einigen hundert Einträgen
 * war das ein eigener Server mit Passwort und Netzwerkverbindung – und auf dem
 * Raspberry Pi 4 gar nicht lauffähig (MongoDB ≥ 5 verlangt ARMv8.2).
 * SQLite ist eine einzige Datei unter data/, braucht keinen Dienst und kein
 * zusätzliches npm-Paket.
 *
 * USE_MEMORY_DB=true legt die Datenbank nur im Arbeitsspeicher an (Tests,
 * Vorführung). Alle Daten sind dann nach dem Beenden weg.
 */
const fs = require("fs");
const path = require("path");
const config = require("../config");
const log = require("../util/logger")("db");

let db = null;

/** Schema-Versionen. Neue Änderungen immer als weiteren Eintrag anhängen. */
const MIGRATIONS = [
  `
  CREATE TABLE patients (
    id             TEXT PRIMARY KEY,
    firstName      TEXT NOT NULL DEFAULT '',
    lastName       TEXT NOT NULL,
    gender         TEXT NOT NULL DEFAULT 'other' CHECK (gender IN ('male','female','other')),
    appointmentAt  TEXT,
    appointmentRaw TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting','called','in_treatment','completed','no_show')),
    room           TEXT NOT NULL DEFAULT '',
    roomId         TEXT NOT NULL DEFAULT '',
    calledAt       TEXT,
    callCount      INTEGER NOT NULL DEFAULT 0,
    externalId     TEXT,
    agendaId       TEXT NOT NULL DEFAULT '',
    practitioner   TEXT NOT NULL DEFAULT '',
    visitMotive    TEXT NOT NULL DEFAULT '',
    note           TEXT NOT NULL DEFAULT '',
    source         TEXT NOT NULL DEFAULT 'manual',
    importBatch    TEXT NOT NULL DEFAULT '',
    createdAt      TEXT NOT NULL,
    updatedAt      TEXT NOT NULL
  );
  CREATE INDEX patients_status_appointment ON patients (status, appointmentAt);
  CREATE UNIQUE INDEX patients_external_id ON patients (externalId) WHERE externalId IS NOT NULL;

  CREATE TABLE call_logs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL DEFAULT 'patient' CHECK (kind IN ('patient','announcement')),
    patientId   TEXT,
    lastName    TEXT NOT NULL DEFAULT '',
    gender      TEXT NOT NULL DEFAULT 'other',
    roomId      TEXT NOT NULL DEFAULT '',
    room        TEXT NOT NULL DEFAULT '',
    spokenText  TEXT NOT NULL DEFAULT '',
    voice       TEXT NOT NULL DEFAULT '',
    result      TEXT NOT NULL DEFAULT 'queued',
    error       TEXT NOT NULL DEFAULT '',
    audioMs     INTEGER NOT NULL DEFAULT 0,
    repeatCount INTEGER NOT NULL DEFAULT 1,
    channels    TEXT NOT NULL DEFAULT '{"audio":"skipped","signage":"skipped","browser":"ok"}',
    triggeredBy TEXT NOT NULL DEFAULT 'ui',
    createdAt   TEXT NOT NULL
  );
  CREATE INDEX call_logs_created ON call_logs (createdAt);
  CREATE INDEX call_logs_kind_created ON call_logs (kind, createdAt);
  `,
];

/** Führt `fn` in einer Transaktion aus; bei einem Fehler wird alles zurückgenommen. */
function transaction(fn) {
  const conn = handle();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

function migrate() {
  const current = db.prepare("PRAGMA user_version").get().user_version;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    log.info(`Datenbankschema auf Version ${version + 1} gebracht.`);
  }
}

async function connect() {
  if (db) return db;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error(`Diese Node-Version (${process.version}) bringt kein node:sqlite mit. Bitte Node 22.13 oder neuer verwenden.`);
  }

  let file = ":memory:";
  if (config.secrets.useMemoryDb) {
    log.warn("In-Memory-Datenbank aktiv – alle Daten gehen beim Beenden verloren.");
  } else {
    file = config.paths.database;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  migrate();

  if (file !== ":memory:") log.info(`Datenbank geöffnet: ${file}`);

  // Aufbewahrungsfrist für das Aufrufprotokoll durchsetzen (danach stündlich, siehe server.js).
  require("./callLogs").purgeExpired();

  return db;
}

async function disconnect() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* bereits geschlossen */
  }
  db = null;
}

function handle() {
  if (!db) throw new Error("Datenbank ist nicht geöffnet (connect() wurde nicht aufgerufen).");
  return db;
}

function isConnected() {
  return db !== null;
}

module.exports = { connect, disconnect, handle, isConnected, transaction };

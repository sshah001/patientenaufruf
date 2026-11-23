"use strict";
/** Gemeinsame Helfer für die Tabellen-Module. */
const crypto = require("crypto");

/** 24-stellige Hex-Kennung – gleiche Form wie die früheren MongoDB-IDs. */
function newId() {
  return crypto.randomBytes(12).toString("hex");
}

/** Date | string | number | null -> ISO-Text für die Datenbank (oder null). */
function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO-Text aus der Datenbank -> Date (oder null). */
function toDate(value) {
  return value ? new Date(value) : null;
}

/** SQLite meldet verletzte Eindeutigkeit als Fehler; hier als 409 aufbereiten. */
function translateError(err) {
  if (/UNIQUE constraint failed/i.test(err.message)) {
    const e = new Error("Dieser Eintrag existiert bereits.");
    e.status = 409;
    e.code = "DUPLICATE";
    return e;
  }
  if (/CHECK constraint failed/i.test(err.message)) {
    const e = new Error("Ungültiger Wert für Status, Geschlecht oder Art.");
    e.status = 400;
    e.code = "VALIDATION";
    return e;
  }
  return err;
}

module.exports = { newId, toIso, toDate, translateError };

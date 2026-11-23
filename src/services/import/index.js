"use strict";
/**
 * Import der Tagesliste.
 *
 * Zwei Verbesserungen gegenüber der Vorversion:
 *
 *  1. VORSCHAU. Der Import läuft zweistufig: erst `preview()` (nichts wird
 *     geschrieben, die Oberfläche zeigt Zuordnung, Trefferzahl und Probleme),
 *     dann `apply()`. Ein kaputter Export löscht damit nicht mehr die Liste.
 *
 *  2. ZUSAMMENFÜHREN statt Löschen. Der alte CSV-Import rief pauschal
 *     `deleteMany({})` auf – ein zweiter Import mitten in der Sprechstunde
 *     löschte alle bereits aufgerufenen Patienten. Standardmäßig wird jetzt
 *     abgeglichen: bekannte Termine werden aktualisiert, laufende Behandlungen
 *     bleiben unangetastet.
 */
const { parse: parseCsv } = require("csv-parse/sync");
const crypto = require("crypto");

const config = require("../../config");
const log = require("../../util/logger")("import");
const { foldKey, buildAnnouncement } = require("../../util/text");
const Patients = require("../../db/patients");
const mapper = require("./mapper");
const tts = require("../tts");

/**
 * Erkennt das Dateiformat und liefert die Rohdatensätze.
 * @returns {{data:any, format:"json"|"csv"}}
 */
function parseFile(buffer, filename = "") {
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  const looksJson = /\.json$/i.test(filename) || /^\s*[[{]/.test(text);

  if (looksJson) {
    try {
      return { data: JSON.parse(text), format: "json" };
    } catch (err) {
      throw new Error(`Die Datei ist kein gültiges JSON: ${err.message}`);
    }
  }

  // CSV: Trennzeichen aus der Kopfzeile erraten (Doctolib nutzt oft Semikolon).
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = [";", ",", "\t"]
    .map((d) => ({ d, count: firstLine.split(d).length }))
    .sort((a, b) => b.count - a.count)[0].d;

  try {
    const rows = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
      relax_column_count: true,
      bom: true,
    });
    return { data: rows, format: "csv" };
  } catch (err) {
    throw new Error(`Die CSV-Datei konnte nicht gelesen werden: ${err.message}`);
  }
}

/**
 * Liest die Datei und zeigt, was passieren würde – ohne die Datenbank zu ändern.
 */
async function preview(buffer, filename, options = {}) {
  const { data, format } = parseFile(buffer, filename);
  const batch = crypto.randomBytes(6).toString("hex");

  const result = mapper.map(data, {
    todayOnly: options.todayOnly ?? config.import.todayOnly,
    source: format,
    batch,
  });

  if (result.stats.recordsFound === 0) {
    result.issues.unshift({
      line: 0,
      level: "error",
      message:
        "In der Datei wurde keine Terminliste gefunden. Erwartet wird ein JSON-Array oder ein Objekt mit einem Feld wie \"data\" oder \"appointments\".",
    });
  }
  if (result.patients.length > 0 && !result.mapping.lastName) {
    result.issues.unshift({
      line: 0,
      level: "warn",
      message: "Das Feld für den Nachnamen wurde nur über einen Notbehelf erkannt. Bitte die Zuordnung unten prüfen.",
    });
  }

  // Gegen den aktuellen Bestand abgleichen, damit die Vorschau echte Zahlen zeigt.
  const existing = Patients.list();
  const index = buildMatchIndex(existing);

  let willInsert = 0;
  let willUpdate = 0;
  for (const patient of result.patients) {
    if (findMatch(index, patient)) willUpdate += 1;
    else willInsert += 1;
  }

  const importedKeys = new Set(result.patients.map((p) => matchKeys(p)[0]));
  const obsolete = existing.filter((e) => e.status === "waiting" && !importedKeys.has(matchKeys(e)[0]));

  return {
    batch,
    format,
    filename,
    mapping: result.mapping,
    stats: { ...result.stats, willInsert, willUpdate, obsoleteWaiting: obsolete.length },
    issues: result.issues.slice(0, 100),
    issueCount: result.issues.length,
    /** Die ersten Einträge zur Sichtprüfung in der Oberfläche. */
    sample: result.patients.slice(0, 12).map((p) => ({
      firstName: p.firstName,
      lastName: p.lastName,
      gender: p.gender,
      appointmentAt: p.appointmentAt,
      practitioner: p.practitioner,
      visitMotive: p.visitMotive,
    })),
    patients: result.patients,
  };
}

/** Schlüssel, unter denen ein Patient wiedererkannt wird. */
function matchKeys(patient) {
  const day = patient.appointmentAt ? new Date(patient.appointmentAt).toISOString().slice(0, 10) : "-";
  return [
    patient.externalId ? `id:${patient.externalId}` : `n:${foldKey(patient.lastName)}|${foldKey(patient.firstName)}|${day}`,
    `n:${foldKey(patient.lastName)}|${foldKey(patient.firstName)}|${day}`,
  ];
}

function buildMatchIndex(list) {
  const index = new Map();
  for (const item of list) {
    for (const key of matchKeys(item)) {
      if (!index.has(key)) index.set(key, item);
    }
  }
  return index;
}

function findMatch(index, patient) {
  for (const key of matchKeys(patient)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Schreibt das Ergebnis einer Vorschau in die Datenbank.
 *
 * @param {object[]} patients  Aus `preview()`
 * @param {object} options     { mode: "merge"|"replace", removeObsolete?: boolean }
 */
async function apply(patients, options = {}) {
  const mode = options.mode || config.import.defaultMode;
  const started = Date.now();

  const existing = Patients.list();
  const index = buildMatchIndex(existing);

  let inserted = 0;
  let updated = 0;
  let skippedActive = 0;

  const inserts = [];
  const updates = [];
  let deleteIds = [];
  const keptIds = new Set();
  const seenExternalIds = new Set();

  for (const incoming of patients) {
    // Derselbe Termin zweimal in einer Datei: nur den ersten übernehmen.
    if (incoming.externalId) {
      if (seenExternalIds.has(incoming.externalId)) continue;
      seenExternalIds.add(incoming.externalId);
    }

    const match = findMatch(index, incoming);

    if (!match) {
      inserts.push(incoming);
      inserted += 1;
      continue;
    }

    keptIds.add(String(match._id));

    // Laufende oder erledigte Behandlungen nicht zurücksetzen.
    const isActive = ["called", "in_treatment", "completed"].includes(match.status);
    if (isActive) {
      skippedActive += 1;
      continue;
    }

    updates.push({
      id: match.id,
      fields: {
        firstName: incoming.firstName,
        lastName: incoming.lastName,
        gender: incoming.gender,
        appointmentAt: incoming.appointmentAt,
        appointmentRaw: incoming.appointmentRaw,
        agendaId: incoming.agendaId,
        practitioner: incoming.practitioner,
        visitMotive: incoming.visitMotive,
        externalId: incoming.externalId,
        source: incoming.source,
        importBatch: incoming.importBatch,
      },
    });
    updated += 1;
  }

  // Nicht mehr enthaltene Termine entfernen – aber nur wartende.
  let removed = 0;
  const shouldRemove = mode === "replace" || options.removeObsolete === true;
  if (shouldRemove) {
    const obsolete = existing.filter((e) => {
      if (keptIds.has(String(e._id))) return false;
      if (config.import.keepCalledOnReplace && e.status !== "waiting") return false;
      return true;
    });
    if (obsolete.length) {
      deleteIds = obsolete.map((o) => o.id);
      removed = obsolete.length;
    }
  }

  if (inserts.length || updates.length || deleteIds.length) {
    Patients.applyImport({ inserts, updates, deleteIds });
  }

  const summary = { mode, inserted, updated, removed, skippedActive, total: patients.length, ms: Date.now() - started };
  log.info(
    `Import abgeschlossen (${mode}): ${inserted} neu, ${updated} aktualisiert, ${removed} entfernt, ${skippedActive} laufende übersprungen.`
  );
  return summary;
}

/**
 * Produziert die Ansagen der importierten Patienten im Hintergrund vor.
 * Danach reagiert jeder Aufrufknopf ohne spürbare Verzögerung.
 */
async function prewarmAnnouncements(onProgress) {
  if (!config.tts.enabled || !config.tts.prewarmOnImport) {
    return { skipped: true };
  }

  const patients = Patients.list({ statuses: ["waiting"] });

  // Auf Wunsch nur die tatsächlich genutzten Räume vorproduzieren – das spart
  // auf einem Raspberry Pi spürbar Zeit und Plattenplatz.
  const wanted = config.tts.prewarmRooms || [];
  const rooms = wanted.length ? config.practice.rooms.filter((r) => wanted.includes(r.id)) : config.practice.rooms;

  const texts = [];
  for (const patient of patients) {
    for (const room of rooms) {
      texts.push(
        buildAnnouncement({
          template: config.announcement.template,
          templateNoGender: config.announcement.templateNoGender,
          patient,
          room: room.spoken,
          practiceName: config.practice.name,
        })
      );
    }
  }

  const limit = config.tts.prewarmMaxItems || 500;
  if (texts.length > limit) {
    log.warn(
      `${texts.length} mögliche Ansagen überschreiten das Limit von ${limit}. ` +
        `Vorproduktion übersprungen – bitte tts.prewarmRooms in config/local.json auf die wirklich genutzten Räume einschränken.`
    );
    return { skipped: true, reason: "limit", would: texts.length, limit };
  }

  log.info(`Produziere ${texts.length} Ansagen vor (${patients.length} Patienten × ${rooms.length} Räume)…`);
  return tts.prewarm(texts, { onProgress });
}

module.exports = { preview, apply, parseFile, prewarmAnnouncements, matchKeys };

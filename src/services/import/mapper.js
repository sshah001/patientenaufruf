"use strict";
/**
 * Übersetzt Termindaten aus Fremdsystemen (Doctolib-Export als JSON oder CSV)
 * in unser Patientenmodell.
 *
 * Doctolib-Exporte unterscheiden sich je nach Praxis, Version und Sprache in
 * den Spaltennamen. Statt einem starren Format zu vertrauen, sucht dieser
 * Mapper nach bekannten Bezeichnern – auch verschachtelt (`patient.last_name`)
 * – und meldet am Ende zurück, welche Felder er tatsächlich gefunden hat.
 * Die Oberfläche zeigt diese Zuordnung vor dem Import an.
 */
const { normalizeGender, foldKey } = require("../../util/text");

/** Bekannte Feldnamen je Zielfeld, in absteigender Priorität. */
const ALIASES = {
  firstName: [
    "patient_first_name", "first_name", "firstName", "vorname", "given_name", "givenName",
    "patient.first_name", "patient.firstName", "patient.given_name", "prenom", "forename",
  ],
  lastName: [
    "patient_last_name", "last_name", "lastName", "nachname", "surname", "family_name", "familyName",
    "patient.last_name", "patient.lastName", "patient.family_name", "nom", "name",
  ],
  gender: [
    "patient_legal_gender", "legal_gender", "gender", "sex", "geschlecht",
    "patient.gender", "patient.legal_gender", "patient.sex",
  ],
  startDateTime: [
    "start_datetime", "start_date_time", "startDateTime", "starts_at", "startsAt",
    "appointment_datetime", "appointmentDateTime", "datetime", "date_time",
    "start", "begin", "beginn", "termin", "appointmentTime",
  ],
  startDate: ["start_date", "startDate", "date", "datum", "appointment_date", "termin_datum"],
  startTime: ["start_time", "startTime", "time", "uhrzeit", "appointment_time", "termin_zeit"],
  externalId: [
    "appointment_id", "appointmentId", "external_id", "externalId", "visit_id", "uid", "uuid", "id", "_id",
  ],
  agendaId: ["agenda_id", "agendaId", "agenda", "calendar_id", "calendarId"],
  practitioner: [
    "practitioner_name", "practitionerName", "practitioner", "doctor", "arzt", "behandler",
    "agenda_name", "agendaName",
  ],
  visitMotive: [
    "visit_motive_name", "visitMotiveName", "visit_motive", "visitMotive", "reason", "grund", "motive", "anlass",
  ],
  note: ["note", "notes", "comment", "kommentar", "bemerkung"],
};

/** Liest auch verschachtelte Pfade wie "patient.last_name". */
function readPath(object, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

/**
 * Sucht den ersten passenden Alias in einem Datensatz.
 * Vergleich ist unempfindlich gegen Groß-/Kleinschreibung und Trennzeichen.
 */
function pick(record, field, flatIndex) {
  for (const alias of ALIASES[field]) {
    if (alias.includes(".")) {
      const value = readPath(record, alias);
      if (value !== undefined && value !== null && value !== "") return { value, alias };
      continue;
    }
    const key = flatIndex.get(foldKey(alias));
    if (key !== undefined) {
      const value = record[key];
      if (value !== undefined && value !== null && value !== "") return { value, alias: key };
    }
  }
  return { value: undefined, alias: null };
}

/** Index aller Schlüssel eines Datensatzes in normalisierter Form. */
function buildIndex(record) {
  const index = new Map();
  for (const key of Object.keys(record)) {
    index.set(foldKey(key), key);
  }
  return index;
}

const MONTHS_DE = {
  januar: 1, februar: 2, "märz": 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

/**
 * Wandelt Datum/Uhrzeit in ein Date-Objekt.
 * Unterstützt ISO-8601, TT.MM.JJJJ, TT/MM/JJJJ, JJJJ-MM-TT und Unix-Zeitstempel.
 *
 * @returns {{date: Date|null, raw: string, warning?: string}}
 */
function parseDateTime(dateValue, timeValue) {
  const rawDate = String(dateValue ?? "").trim();
  const rawTime = String(timeValue ?? "").trim();
  const raw = [rawDate, rawTime].filter(Boolean).join(" ");
  if (!raw) return { date: null, raw: "" };

  // Unix-Zeitstempel (Sekunden oder Millisekunden)
  if (!rawTime && /^\d{10}$|^\d{13}$/.test(rawDate)) {
    const ms = rawDate.length === 10 ? Number(rawDate) * 1000 : Number(rawDate);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? { date: null, raw, warning: "Unlesbarer Zeitstempel" } : { date: d, raw };
  }

  // Vollständiges ISO-8601 im Datumsfeld
  if (!rawTime && /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(rawDate)) {
    const d = new Date(rawDate.replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return { date: d, raw };
  }

  const time = parseTime(rawTime);
  const date = parseDate(rawDate);

  if (!date) return { date: null, raw, warning: `Datum "${rawDate}" nicht erkannt` };

  const result = new Date(date.year, date.month - 1, date.day, time.hour, time.minute, 0, 0);
  if (Number.isNaN(result.getTime())) {
    return { date: null, raw, warning: `Ungültiges Datum: ${raw}` };
  }
  return { date: result, raw, warning: rawTime && !time.found ? `Uhrzeit "${rawTime}" nicht erkannt` : undefined };
}

function parseTime(value) {
  const match = String(value).match(/(\d{1,2})[:.](\d{2})/);
  if (!match) return { hour: 0, minute: 0, found: false };
  return { hour: Math.min(23, Number(match[1])), minute: Math.min(59, Number(match[2])), found: true };
}

function parseDate(value) {
  let m;

  // JJJJ-MM-TT
  m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };

  // TT.MM.JJJJ (deutsch)
  m = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) return { year: fullYear(+m[3]), month: +m[2], day: +m[1] };

  // TT/MM/JJJJ (Doctolib-Export)
  m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return { year: fullYear(+m[3]), month: +m[2], day: +m[1] };

  // "5. Mai 2025"
  m = value.match(/^(\d{1,2})\.?\s+([A-Za-zäöüÄÖÜ]+)\s+(\d{4})/);
  if (m) {
    const month = MONTHS_DE[m[2].toLowerCase()];
    if (month) return { year: +m[3], month, day: +m[1] };
  }

  return null;
}

function fullYear(year) {
  if (year >= 1000) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

/**
 * Findet die Liste der Termine in einer beliebig verpackten JSON-Struktur.
 * Akzeptiert: Array direkt, {data:[...]}, {appointments:[...]}, {items:[...]}, …
 */
function extractRecords(input) {
  if (Array.isArray(input)) return { records: input, path: "(Wurzel-Array)" };

  if (input && typeof input === "object") {
    const candidates = ["data", "appointments", "items", "results", "records", "termine", "patients", "rows", "entries"];
    for (const key of candidates) {
      if (Array.isArray(input[key])) return { records: input[key], path: key };
    }
    // Zur Not das erste Array-Feld nehmen.
    for (const [key, value] of Object.entries(input)) {
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
        return { records: value, path: key };
      }
    }
  }

  return { records: [], path: null };
}

/** Prüft, ob ein Datum auf den heutigen Tag fällt. */
function isToday(date) {
  if (!date) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/**
 * Hauptfunktion: rohe Termindaten -> Patientenobjekte.
 *
 * @param {any} input        Geparstes JSON oder Array von CSV-Zeilen
 * @param {object} options   { todayOnly?: boolean, source?: string, batch?: string }
 * @returns {{patients: object[], issues: object[], mapping: object, stats: object}}
 */
function map(input, options = {}) {
  const { records, path } = extractRecords(input);
  const issues = [];
  const patients = [];
  const mapping = {};
  const seen = new Set();

  let skippedNoName = 0;
  let skippedNotToday = 0;
  let skippedDuplicate = 0;

  records.forEach((record, index) => {
    const line = index + 1;

    if (!record || typeof record !== "object") {
      issues.push({ line, level: "error", message: "Eintrag ist kein Objekt und wurde übersprungen." });
      return;
    }

    const flatIndex = buildIndex(record);
    const get = (field) => pick(record, field, flatIndex);

    const lastNameHit = get("lastName");
    const firstNameHit = get("firstName");

    // Zuordnung nur einmal merken (für die Anzeige in der Oberfläche).
    if (index === 0) {
      for (const field of Object.keys(ALIASES)) {
        const hit = get(field);
        if (hit.alias) mapping[field] = hit.alias;
      }
    }

    let lastName = String(lastNameHit.value ?? "").trim();
    let firstName = String(firstNameHit.value ?? "").trim();

    // Fällt nur ein Feld "name" an, nach "Nachname, Vorname" bzw. "Vorname Nachname" trennen.
    if (lastName && !firstName && /[\s,]/.test(lastName)) {
      if (lastName.includes(",")) {
        const [last, first] = lastName.split(",");
        lastName = last.trim();
        firstName = (first || "").trim();
      } else {
        const parts = lastName.split(/\s+/);
        lastName = parts.pop();
        firstName = parts.join(" ");
      }
    }

    if (!lastName) {
      skippedNoName += 1;
      issues.push({ line, level: "warn", message: "Kein Nachname gefunden – Eintrag übersprungen." });
      return;
    }

    const startHit = get("startDateTime");
    const dateHit = get("startDate");
    const timeHit = get("startTime");

    const parsed = startHit.value
      ? parseDateTime(startHit.value, timeHit.value)
      : parseDateTime(dateHit.value, timeHit.value);

    if (parsed.warning) {
      issues.push({ line, level: "warn", message: `${parsed.warning} (${lastName})` });
    }

    if (options.todayOnly && parsed.date && !isToday(parsed.date)) {
      skippedNotToday += 1;
      return;
    }

    const externalId = get("externalId").value;
    const dedupeKey = externalId
      ? `id:${externalId}`
      : `n:${foldKey(lastName)}|${foldKey(firstName)}|${parsed.date ? parsed.date.getTime() : "0"}`;

    if (seen.has(dedupeKey)) {
      skippedDuplicate += 1;
      issues.push({ line, level: "info", message: `Doppelter Eintrag übersprungen: ${lastName}` });
      return;
    }
    seen.add(dedupeKey);

    patients.push({
      firstName,
      lastName,
      gender: normalizeGender(get("gender").value),
      appointmentAt: parsed.date,
      appointmentRaw: parsed.raw,
      externalId: externalId != null ? String(externalId) : null,
      agendaId: String(get("agendaId").value ?? ""),
      practitioner: String(get("practitioner").value ?? ""),
      visitMotive: String(get("visitMotive").value ?? ""),
      note: String(get("note").value ?? ""),
      status: "waiting",
      room: "",
      roomId: "",
      source: options.source || "json",
      importBatch: options.batch || "",
    });
  });

  return {
    patients,
    issues,
    mapping,
    stats: {
      recordsFound: records.length,
      arrayPath: path,
      accepted: patients.length,
      skippedNoName,
      skippedNotToday,
      skippedDuplicate,
    },
  };
}

module.exports = { map, parseDateTime, extractRecords, ALIASES, isToday };

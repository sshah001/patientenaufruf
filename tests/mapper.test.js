"use strict";
/**
 * Tests für den Import-Mapper.
 *
 * Der Mapper ist das Bauteil mit dem höchsten Risiko: kommt ein Doctolib-Export
 * in einer unerwarteten Form, darf er keine falschen Patienten erzeugen und
 * keine stillen Datenverluste verursachen.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const mapper = require("../src/services/import/mapper");

test("erkennt den klassischen flachen Doctolib-Export", () => {
  const input = {
    data: [
      {
        appointment_id: "A-1",
        patient_first_name: "Max",
        patient_last_name: "Mustermann",
        patient_legal_gender: "male",
        start_date: "11/09/2026",
        start_time: "08:30",
        practitioner_name: "Dr. Rosenthal",
      },
    ],
  };

  const result = mapper.map(input);

  assert.equal(result.patients.length, 1);
  assert.equal(result.patients[0].lastName, "Mustermann");
  assert.equal(result.patients[0].firstName, "Max");
  assert.equal(result.patients[0].gender, "male");
  assert.equal(result.patients[0].externalId, "A-1");
  assert.equal(result.patients[0].practitioner, "Dr. Rosenthal");
  assert.equal(result.stats.arrayPath, "data");
  // TT/MM/JJJJ, nicht MM/TT/JJJJ
  assert.equal(result.patients[0].appointmentAt.getDate(), 11);
  assert.equal(result.patients[0].appointmentAt.getMonth(), 8); // September
  assert.equal(result.patients[0].appointmentAt.getHours(), 8);
  assert.equal(result.patients[0].appointmentAt.getMinutes(), 30);
});

test("liest verschachtelte Patientenobjekte und ISO-Zeitstempel", () => {
  const input = [
    {
      id: 772,
      patient: { first_name: "Hans", last_name: "Schäfer", gender: "male" },
      start_datetime: "2026-09-11T10:00:00+02:00",
    },
  ];

  const result = mapper.map(input);

  assert.equal(result.patients.length, 1);
  assert.equal(result.patients[0].lastName, "Schäfer");
  assert.equal(result.patients[0].externalId, "772");
  assert.equal(result.patients[0].appointmentAt.toISOString(), "2026-09-11T08:00:00.000Z");
});

test("versteht deutsche Spaltennamen und Datumsformate", () => {
  const input = [{ Nachname: "Kowalski", Vorname: "Anna", Geschlecht: "weiblich", Datum: "11.09.2026", Uhrzeit: "11:00" }];

  const result = mapper.map(input);

  assert.equal(result.patients[0].lastName, "Kowalski");
  assert.equal(result.patients[0].gender, "female");
  assert.equal(result.patients[0].appointmentAt.getDate(), 11);
  assert.equal(result.patients[0].appointmentAt.getHours(), 11);
});

test("trennt ein einzelnes Namensfeld auf", () => {
  const nachnameZuerst = mapper.map([{ name: "Mustermann, Max" }]);
  assert.equal(nachnameZuerst.patients[0].lastName, "Mustermann");
  assert.equal(nachnameZuerst.patients[0].firstName, "Max");

  const vornameZuerst = mapper.map([{ name: "Max Mustermann" }]);
  assert.equal(vornameZuerst.patients[0].lastName, "Mustermann");
  assert.equal(vornameZuerst.patients[0].firstName, "Max");
});

test("überspringt Einträge ohne Nachnamen und meldet sie", () => {
  const result = mapper.map([
    { patient_last_name: "Gültig" },
    { patient_last_name: "" },
    { patient_first_name: "NurVorname" },
  ]);

  assert.equal(result.patients.length, 1);
  assert.equal(result.stats.skippedNoName, 2);
  assert.equal(result.issues.filter((i) => i.level === "warn").length, 2);
});

test("erkennt Doppeleinträge über die Termin-Kennung", () => {
  const result = mapper.map([
    { appointment_id: "X", patient_last_name: "Müller" },
    { appointment_id: "X", patient_last_name: "Müller" },
  ]);

  assert.equal(result.patients.length, 1);
  assert.equal(result.stats.skippedDuplicate, 1);
});

test("erkennt Doppeleinträge ohne Kennung über Name und Zeit", () => {
  const record = { patient_last_name: "Müller", patient_first_name: "Anna", start_date: "11.09.2026", start_time: "09:00" };
  const result = mapper.map([record, { ...record }]);

  assert.equal(result.patients.length, 1);
  assert.equal(result.stats.skippedDuplicate, 1);
});

test("normalisiert unterschiedliche Geschlechtsangaben", () => {
  const result = mapper.map([
    { patient_last_name: "A", patient_legal_gender: "MALE" },
    { patient_last_name: "B", patient_legal_gender: "w" },
    { patient_last_name: "C", patient_legal_gender: "divers" },
    { patient_last_name: "D" },
  ]);

  assert.deepEqual(result.patients.map((p) => p.gender), ["male", "female", "other", "other"]);
});

test("meldet unlesbare Datumsangaben, verwirft den Patienten aber nicht", () => {
  const result = mapper.map([{ patient_last_name: "Müller", start_date: "irgendwann", start_time: "" }]);

  assert.equal(result.patients.length, 1);
  assert.equal(result.patients[0].appointmentAt, null);
  assert.ok(result.issues.some((i) => i.message.includes("nicht erkannt")));
});

test("liefert bei unbekanntem Aufbau eine leere Liste statt eines Absturzes", () => {
  assert.equal(mapper.map({ irgendwas: "Text" }).patients.length, 0);
  assert.equal(mapper.map(null).patients.length, 0);
  assert.equal(mapper.map("kaputt").patients.length, 0);
  assert.equal(mapper.map([null, 42, "x"]).patients.length, 0);
});

test("filtert auf den heutigen Tag, wenn gewünscht", () => {
  const heute = new Date();
  const datumHeute = `${String(heute.getDate()).padStart(2, "0")}.${String(heute.getMonth() + 1).padStart(2, "0")}.${heute.getFullYear()}`;

  const result = mapper.map(
    [
      { patient_last_name: "Heute", start_date: datumHeute, start_time: "10:00" },
      { patient_last_name: "Morgen", start_date: "01.01.2099", start_time: "10:00" },
    ],
    { todayOnly: true }
  );

  assert.equal(result.patients.length, 1);
  assert.equal(result.patients[0].lastName, "Heute");
  assert.equal(result.stats.skippedNotToday, 1);
});

test("parseDateTime beherrscht die gängigen Schreibweisen", () => {
  const faelle = [
    ["2026-09-11", "14:30", 2026, 8, 11, 14, 30],
    ["11.09.2026", "14:30", 2026, 8, 11, 14, 30],
    ["11/09/2026", "14:30", 2026, 8, 11, 14, 30],
    ["11.09.26", "14:30", 2026, 8, 11, 14, 30],
    ["11. September 2026", "14:30", 2026, 8, 11, 14, 30],
  ];

  for (const [datum, zeit, jahr, monat, tag, stunde, minute] of faelle) {
    const { date } = mapper.parseDateTime(datum, zeit);
    assert.ok(date, `${datum} ${zeit} wurde nicht erkannt`);
    assert.equal(date.getFullYear(), jahr, datum);
    assert.equal(date.getMonth(), monat, datum);
    assert.equal(date.getDate(), tag, datum);
    assert.equal(date.getHours(), stunde, datum);
    assert.equal(date.getMinutes(), minute, datum);
  }
});

test("findet die Terminliste in unterschiedlich verpackten Objekten", () => {
  const eintrag = [{ patient_last_name: "X" }];
  for (const schluessel of ["data", "appointments", "items", "results", "termine"]) {
    const { records, path } = mapper.extractRecords({ [schluessel]: eintrag });
    assert.equal(records.length, 1, schluessel);
    assert.equal(path, schluessel);
  }
});

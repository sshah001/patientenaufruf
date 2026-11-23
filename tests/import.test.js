"use strict";
/**
 * Integrationstest für den Import gegen eine echte (In-Memory-)Datenbank.
 *
 * Hintergrund: Der CSV-Import der Vorversion rief pauschal `deleteMany({})`
 * auf. Ein zweiter Import mitten in der Sprechstunde löschte damit auch alle
 * bereits aufgerufenen Patienten. Diese Tests halten fest, dass das nicht
 * mehr passieren kann.
 */
process.env.USE_MEMORY_DB = "true";
process.env.SECURITY_AUTH_ENABLED = "false";
process.env.TTS_ENABLED = "false";
process.env.MOPIDY_ENABLED = "false";
process.env.SIGNAGE_ENABLED = "false";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/db/connect");
const Patients = require("../src/db/patients");

/** Findet einen Patienten über den Nachnamen (nur für die Tests). */
const byName = (lastName) => Patients.list().find((p) => p.lastName === lastName);
const importService = require("../src/services/import");

test.before(async () => {
  await db.connect();
});

test.after(async () => {
  await db.disconnect();
});

test.beforeEach(async () => {
  Patients.removeAll();
});

function datei(objekt) {
  return Buffer.from(JSON.stringify(objekt), "utf8");
}

const TAGESLISTE = [
  { appointment_id: "A-1", patient_last_name: "Mustermann", patient_first_name: "Max", patient_legal_gender: "male", start_date: "11.09.2026", start_time: "08:30" },
  { appointment_id: "A-2", patient_last_name: "Musterfrau", patient_first_name: "Erika", patient_legal_gender: "female", start_date: "11.09.2026", start_time: "08:45" },
];

test("legt beim ersten Import alle Patienten an", async () => {
  const vorschau = await importService.preview(datei(TAGESLISTE), "tag.json");
  assert.equal(vorschau.stats.accepted, 2);
  assert.equal(vorschau.stats.willInsert, 2);
  assert.equal(vorschau.stats.willUpdate, 0);

  const ergebnis = await importService.apply(vorschau.patients, { mode: "merge" });
  assert.equal(ergebnis.inserted, 2);
  assert.equal(Patients.count(), 2);
});

test("ein zweiter Import legt keine Doppelten an", async () => {
  const erste = await importService.preview(datei(TAGESLISTE), "tag.json");
  await importService.apply(erste.patients, { mode: "merge" });

  const zweite = await importService.preview(datei(TAGESLISTE), "tag.json");
  assert.equal(zweite.stats.willInsert, 0);
  assert.equal(zweite.stats.willUpdate, 2);

  const ergebnis = await importService.apply(zweite.patients, { mode: "merge" });
  assert.equal(ergebnis.inserted, 0);
  assert.equal(Patients.count(), 2, "Es dürfen keine Doppelten entstehen.");
});

test("ein erneuter Import setzt einen bereits aufgerufenen Patienten nicht zurück", async () => {
  const erste = await importService.preview(datei(TAGESLISTE), "tag.json");
  await importService.apply(erste.patients, { mode: "merge" });

  // Mustermann wird aufgerufen …
  Patients.update(byName("Mustermann").id, {
    status: "called",
    room: "Behandlungszimmer 1",
    roomId: "bz1",
    calledAt: new Date(),
  });

  // … und mitten in der Sprechstunde wird die Liste erneut importiert.
  const zweite = await importService.preview(datei(TAGESLISTE), "tag.json");
  const ergebnis = await importService.apply(zweite.patients, { mode: "merge" });

  const mustermann = byName("Mustermann");
  assert.equal(mustermann.status, "called", "Der Aufruf darf nicht verloren gehen.");
  assert.equal(mustermann.room, "Behandlungszimmer 1");
  assert.equal(ergebnis.skippedActive, 1);
});

test("Ersetzen entfernt nur wartende Patienten, die nicht mehr in der Datei stehen", async () => {
  const erste = await importService.preview(datei(TAGESLISTE), "tag.json");
  await importService.apply(erste.patients, { mode: "merge" });

  // Musterfrau wird aufgerufen.
  Patients.update(byName("Musterfrau").id, { status: "called", room: "Labor", roomId: "labor" });

  // Neue Datei enthält nur noch einen ganz anderen Patienten.
  const neueListe = [
    { appointment_id: "A-9", patient_last_name: "Neumann", patient_first_name: "Nina", patient_legal_gender: "female", start_date: "11.09.2026", start_time: "10:00" },
  ];
  const zweite = await importService.preview(datei(neueListe), "tag.json");
  const ergebnis = await importService.apply(zweite.patients, { mode: "replace", removeObsolete: true });

  const namen = Patients.list().map((p) => p.lastName).sort();

  assert.equal(ergebnis.inserted, 1);
  assert.ok(namen.includes("Neumann"), "Der neue Patient fehlt.");
  assert.ok(namen.includes("Musterfrau"), "Ein bereits aufgerufener Patient darf nicht entfernt werden.");
  assert.ok(!namen.includes("Mustermann"), "Der wartende, nicht mehr gelistete Patient sollte entfernt sein.");
});

test("erkennt Patienten auch ohne Termin-Kennung über Name und Tag wieder", async () => {
  const ohneId = [
    { patient_last_name: "Öztürk", patient_first_name: "Ayşe", patient_legal_gender: "female", start_date: "11.09.2026", start_time: "09:00" },
  ];

  const erste = await importService.preview(datei(ohneId), "tag.json");
  await importService.apply(erste.patients, { mode: "merge" });

  const zweite = await importService.preview(datei(ohneId), "tag.json");
  assert.equal(zweite.stats.willUpdate, 1, "Der Patient sollte wiedererkannt werden.");

  await importService.apply(zweite.patients, { mode: "merge" });
  assert.equal(Patients.count(), 1);
});

test("liest CSV mit Semikolon und BOM", async () => {
  const csv = Buffer.from("﻿Nachname;Vorname;Geschlecht;Datum;Uhrzeit\nKowalski;Anna;weiblich;11.09.2026;11:00\n", "utf8");
  const vorschau = await importService.preview(csv, "liste.csv");

  assert.equal(vorschau.format, "csv");
  assert.equal(vorschau.stats.accepted, 1);
  assert.equal(vorschau.patients[0].lastName, "Kowalski");
});

test("meldet kaputtes JSON verständlich, statt abzustürzen", async () => {
  await assert.rejects(
    () => importService.preview(Buffer.from("{ das ist kein json", "utf8"), "kaputt.json"),
    /kein gültiges JSON/
  );
});

test("eine Datei ohne erkennbare Terminliste ändert nichts und erklärt das Problem", async () => {
  const vorschau = await importService.preview(datei({ meldung: "keine Termine" }), "leer.json");

  assert.equal(vorschau.stats.accepted, 0);
  assert.ok(vorschau.issues.some((i) => i.level === "error"));
  assert.equal(Patients.count(), 0);
});

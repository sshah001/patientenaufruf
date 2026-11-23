"use strict";
/**
 * Tests für den Aufrufverlauf, aus dem Popup, Laufband und RSS gespeist werden.
 */
process.env.USE_MEMORY_DB = "true";
process.env.SECURITY_AUTH_ENABLED = "false";
process.env.SIGNAGE_ENABLED = "false";
process.env.MOPIDY_ENABLED = "false";
process.env.TTS_ENABLED = "false";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/db/connect");
const CallLogs = require("../src/db/callLogs");
const signage = require("../src/services/signage");
const config = require("../src/config");

test.before(async () => {
  await db.connect();
});
test.after(async () => {
  await db.disconnect();
});
test.beforeEach(async () => {
  CallLogs.removeAll();
  signage.clear();
});

test("bereitet einen Aufruf für die Anzeige auf", () => {
  const raum = config.practice.rooms[0];
  const call = signage.toDisplayCall({ _id: "abc", lastName: "Müller", gender: "male" }, raum);

  assert.equal(call.headline, "Herr Müller");
  assert.equal(call.room, raum.label);
  assert.equal(call.roomColor, raum.color);
  assert.ok(call.at, "Ein Zeitstempel muss gesetzt sein.");
});

test("lässt die Anrede bei unbekanntem Geschlecht weg", () => {
  const call = signage.toDisplayCall({ _id: "x", lastName: "Müller", gender: "other" }, config.practice.rooms[0]);
  assert.equal(call.headline, "Müller");
});

test("kürzt den Namen, wenn die Datenschutz-Einstellung das verlangt", () => {
  const original = config.privacy.nameDisplay;
  config.privacy.nameDisplay = "initial";

  const call = signage.toDisplayCall({ _id: "x", lastName: "Mustermann", gender: "female" }, config.practice.rooms[0]);
  assert.equal(call.headline, "Frau M.");

  config.privacy.nameDisplay = original;
});

test("führt die letzten Aufrufe in umgekehrter Reihenfolge", () => {
  for (const name of ["Erster", "Zweiter", "Dritter"]) {
    signage.record(signage.toDisplayCall({ _id: name, lastName: name, gender: "male" }, config.practice.rooms[0]));
  }

  const letzte = signage.recent(3);
  assert.deepEqual(letzte.map((c) => c.name), ["Dritter", "Zweiter", "Erster"]);
  assert.equal(signage.lastCall().name, "Dritter");
});

test("stellt den Verlauf nach einem Neustart aus dem Protokoll wieder her", async () => {
  const raum = config.practice.rooms[1];

  CallLogs.create({
    lastName: "Älter",
    gender: "female",
    roomId: raum.id,
    room: raum.label,
    result: "done",
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  });
  CallLogs.create({
    lastName: "Neuer",
    gender: "male",
    roomId: raum.id,
    room: raum.label,
    result: "done",
    createdAt: new Date(Date.now() - 2 * 60 * 1000),
  });

  const anzahl = await signage.restoreRecent();

  assert.equal(anzahl, 2);
  assert.equal(signage.lastCall().headline, "Herr Neuer", "Der jüngste Aufruf muss vorne stehen.");
  assert.equal(signage.recent(2)[1].headline, "Frau Älter");
  assert.equal(signage.lastCall().roomColor, raum.color, "Die Raumfarbe muss wieder zugeordnet werden.");
});

test("übernimmt beim Wiederherstellen keine fehlgeschlagenen und keine alten Aufrufe", async () => {
  const raum = config.practice.rooms[0];

  CallLogs.create({ lastName: "Fehlgeschlagen", roomId: raum.id, room: raum.label, result: "failed" });
  CallLogs.create({
    lastName: "Vorgestern",
    roomId: raum.id,
    room: raum.label,
    result: "done",
    createdAt: new Date(Date.now() - 48 * 3600 * 1000),
  });
  CallLogs.create({ lastName: "Aktuell", roomId: raum.id, room: raum.label, result: "done" });

  const anzahl = await signage.restoreRecent();

  assert.equal(anzahl, 1);
  assert.equal(signage.lastCall().name, "Aktuell");
});

test("announce meldet bei abgeschalteter Anzeige trotzdem Erfolg und merkt sich den Aufruf", async () => {
  const raum = config.practice.rooms[0];
  const ergebnis = await signage.announce({ _id: "1", lastName: "Müller", gender: "male" }, raum);

  assert.equal(ergebnis.ok, true);
  assert.equal(ergebnis.mode, "disabled");
  assert.equal(signage.lastCall().headline, "Herr Müller", "Auch ohne piSignage müssen Browser-Anzeigen versorgt werden.");
});

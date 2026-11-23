"use strict";
/**
 * Tests für Ansagetext, Anzeigename und Datenschutz-Kürzung.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const text = require("../src/util/text");

const VORLAGE = {
  template: "{anrede} {name}, bitte kommen Sie {raum}.",
  templateNoGender: "{name}, bitte kommen Sie {raum}.",
};

test("baut die Ansage mit passender Anrede", () => {
  assert.equal(
    text.buildAnnouncement({ ...VORLAGE, patient: { gender: "male", lastName: "Müller" }, room: "in Behandlungszimmer eins" }),
    "Herr Müller, bitte kommen Sie in Behandlungszimmer eins."
  );
  assert.equal(
    text.buildAnnouncement({ ...VORLAGE, patient: { gender: "female", lastName: "Müller" }, room: "zur Anmeldung" }),
    "Frau Müller, bitte kommen Sie zur Anmeldung."
  );
});

test("lässt die Anrede weg, wenn das Geschlecht unbekannt ist", () => {
  const ansage = text.buildAnnouncement({
    ...VORLAGE,
    patient: { gender: "other", lastName: "Müller" },
    room: "in das Labor",
  });
  assert.equal(ansage, "Müller, bitte kommen Sie in das Labor.");
  assert.ok(!ansage.startsWith(" "), "Die Ansage darf nicht mit einem Leerzeichen beginnen.");
});

test("sanitizeForSpeech entfernt Steuerzeichen und vereinheitlicht Anführungszeichen", () => {
  assert.equal(text.sanitizeForSpeech("Herr  Müller "), "Herr Müller");
  assert.equal(text.sanitizeForSpeech("„Test“"), '"Test"');
  assert.equal(text.sanitizeForSpeech("a–b"), "a-b");
});

test("sanitizeForSpeech begrenzt die Länge", () => {
  assert.equal(text.sanitizeForSpeech("x".repeat(1000)).length, 400);
});

test("sanitizeForSpeech macht Shell-Sonderzeichen unschädlich – sie bleiben reiner Text", () => {
  // Piper wird über stdin gefüttert; der Text darf ruhig Sonderzeichen
  // enthalten, es wird nie eine Shell beteiligt.
  const boesartig = 'Müller"; rm -rf /; echo "';
  const sauber = text.sanitizeForSpeech(boesartig);
  assert.equal(sauber, boesartig, "Der Text soll unverändert bleiben, nicht escaped werden.");
  assert.ok(!sauber.includes("\n"), "Zeilenumbrüche werden entfernt.");
});

test("displayLastName kürzt gemäß Datenschutz-Einstellung", () => {
  assert.equal(text.displayLastName("Mustermann", "full"), "Mustermann");
  assert.equal(text.displayLastName("Mustermann", "initial"), "M.");
  assert.equal(text.displayLastName("Mustermann", "abbrev"), "Muste.");
  assert.equal(text.displayLastName("Li", "abbrev"), "L.");
  assert.equal(text.displayLastName("", "full"), "");
});

test("displayName berücksichtigt die Vornamen-Einstellung", () => {
  const patient = { firstName: "Max", lastName: "Mustermann" };
  assert.equal(text.displayName(patient, { nameDisplay: "full", showFirstName: false }), "Mustermann");
  assert.equal(text.displayName(patient, { nameDisplay: "full", showFirstName: true }), "Max Mustermann");
  assert.equal(text.displayName(patient, { nameDisplay: "initial", showFirstName: true }), "Max M.");
});

test("foldKey ignoriert Umlaute, Bindestriche und Groß-Klein-Schreibung", () => {
  assert.equal(text.foldKey("Müller"), text.foldKey("muller"));
  assert.equal(text.foldKey("Groß-Weiß"), text.foldKey("grossweiss"));
  assert.equal(text.foldKey("Öztürk"), text.foldKey("ozturk"));
});

test("escapeHtml verhindert eingeschleustes Markup", () => {
  assert.equal(text.escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

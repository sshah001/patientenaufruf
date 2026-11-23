#!/usr/bin/env node
"use strict";
/**
 * Legt eine Beispiel-Tagesliste an – zum Vorführen und zum Testen der
 * Einrichtung, bevor echte Daten importiert werden.
 *
 *   npm run seed
 *
 * Achtung: leert vorher die Patientenliste.
 */
require("dotenv").config();

const db = require("../src/db/connect");
const Patients = require("../src/db/patients");

const NAMEN = [
  ["Max", "Mustermann", "male"],
  ["Erika", "Musterfrau", "female"],
  ["Ayşe", "Öztürk", "female"],
  ["Hans", "Schäfer", "male"],
  ["Anna", "Kowalski", "female"],
  ["Emre", "Ünal", "male"],
  ["Petra", "Groß-Weiß", "female"],
  ["Jean", "Dupont", "male"],
  ["Nina", "Neumann", "female"],
  ["Klaus", "Schmidt", "male"],
];

const BEHANDLER = ["Dr. Rosenthal", "Dr. Meier"];
const ANLASS = ["Vorsorge", "Blutabnahme", "Kontrolle", "Impfung", "Beratung"];

async function main() {
  await db.connect();

  const anzahlVorher = Patients.removeAll();

  const beginn = new Date();
  beginn.setHours(8, 0, 0, 0);

  const patienten = NAMEN.map(([firstName, lastName, gender], index) => ({
    firstName,
    lastName,
    gender,
    appointmentAt: new Date(beginn.getTime() + index * 15 * 60 * 1000),
    externalId: `DEMO-${String(index + 1).padStart(3, "0")}`,
    practitioner: BEHANDLER[index % BEHANDLER.length],
    visitMotive: ANLASS[index % ANLASS.length],
    status: "waiting",
    source: "demo",
  }));

  Patients.insertMany(patienten);

  console.log(`${anzahlVorher} vorhandene Einträge entfernt.`);
  console.log(`${patienten.length} Beispielpatienten angelegt (Termine ab 08:00 Uhr).`);
  console.log("Hinweis: Das sind erfundene Namen, keine echten Patientendaten.");

  await db.disconnect();
}

main().catch((err) => {
  console.error("Fehlgeschlagen:", err.message);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";
/**
 * Prüft die Konfiguration, ohne den Server zu starten.
 *
 *   npm run check-config
 *
 * Gedacht für den Moment vor dem ersten Start und nach jeder Änderung an der
 * .env – meldet Fehler und Warnungen im Klartext und beendet sich mit
 * Rückgabewert 1, wenn etwas den Start verhindern würde.
 */
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const config = require("../src/config");

function heading(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}
const ok = (text) => console.log(`  \x1b[32m✓\x1b[0m ${text}`);
const warn = (text) => console.log(`  \x1b[33m!\x1b[0m ${text}`);
const bad = (text) => console.log(`  \x1b[31m✗\x1b[0m ${text}`);

/**
 * Erkennt einen Raspberry Pi und dessen CPU-Generation (nur zur Information;
 * seit dem Wechsel auf SQLite läuft das System auf Pi 4 und Pi 5 gleichermaßen).
 */
function erkenneRaspberryPi() {
  if (process.platform !== "linux" || process.arch !== "arm64") return null;
  let cpuinfo = "";
  let modell = "";
  try {
    cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
  } catch {
    return null;
  }
  try {
    modell = fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
  } catch {
    /* nicht überall vorhanden */
  }

  // CPU-Teilenummer: 0xd08 = Cortex-A72 (Pi 4), 0xd0b = Cortex-A76 (Pi 5)
  const teil = (cpuinfo.match(/CPU part\s*:\s*(0x[0-9a-f]+)/i) || [])[1];
  const kerne = { "0xd08": "Cortex-A72", "0xd0b": "Cortex-A76" }[teil] || teil || "unbekannt";
  const armv82 = teil === "0xd0b";

  return { modell: modell || "Raspberry Pi", kern: kerne, armv82 };
}

heading("Plattform");
const pi = erkenneRaspberryPi();
if (pi) {
  ok(`${pi.modell} (${pi.kern}), Node ${process.version}`);
} else {
  ok(`${process.platform} / ${process.arch}, Node ${process.version}`);
}

heading("Datenbank");
try {
  require("node:sqlite");
  ok(config.secrets.useMemoryDb ? "SQLite im Arbeitsspeicher (USE_MEMORY_DB=true) – Daten sind flüchtig." : `SQLite-Datei: ${config.paths.database}`);
} catch {
  bad(`Node ${process.version} bringt kein node:sqlite mit – bitte Node 22.13 oder neuer installieren.`);
}

heading("Konfiguration");
const result = config.validate();
for (const error of result.errors) bad(error);
for (const warning of result.warnings) warn(warning);
if (result.ok && result.warnings.length === 0) ok("Vollständig und ohne Beanstandung.");

heading("Adressen");
ok(`Öffentliche Basis-URL: ${config.app.publicUrl}`);
ok(`Audiodateien für Mopidy: ${config.mopidy.audioBaseUrl}/<datei>.wav`);
ok(`Wartezimmer-TV: ${config.app.publicUrl}/tv${config.secrets.displayToken ? "?token=…" : ""}`);
ok(`Laufband (RSS) für piSignage: ${config.app.publicUrl}/rss.xml${config.secrets.displayToken ? "?token=…" : ""}`);

heading("Räume");
for (const room of config.practice.rooms) {
  ok(`${room.label.padEnd(24)} gesprochen: „${room.spoken}“`);
}

heading("Beispielansage");
const { buildAnnouncement } = require("../src/util/text");
for (const gender of ["male", "female", "other"]) {
  console.log(
    "  " +
      buildAnnouncement({
        template: config.announcement.template,
        templateNoGender: config.announcement.templateNoGender,
        patient: { gender, lastName: "Mustermann" },
        room: config.practice.rooms[0].spoken,
        practiceName: config.practice.name,
      })
  );
}

heading("Stimmen");
const voicesDir = config.paths.voices;
if (!fs.existsSync(voicesDir)) {
  bad(`Verzeichnis fehlt: ${voicesDir}`);
} else {
  const models = fs.readdirSync(voicesDir).filter((f) => f.endsWith(".onnx"));
  if (models.length === 0) {
    bad(`Keine .onnx-Dateien in ${voicesDir}`);
  } else {
    for (const model of models) {
      const id = model.replace(/\.onnx$/, "");
      const hasMeta = fs.existsSync(path.join(voicesDir, `${model}.json`));
      const active = id === config.tts.voice;
      const line = `${id}${active ? "  ← aktiv" : ""}`;
      if (!hasMeta) warn(`${line}   (zugehörige .onnx.json fehlt)`);
      else ok(line);
    }
    if (!models.some((m) => m.replace(/\.onnx$/, "") === config.tts.voice)) {
      warn(`Die eingestellte Stimme "${config.tts.voice}" ist nicht vorhanden – es wird eine andere verwendet.`);
    }
  }
}

heading("Piper");
require("../src/services/tts/piperEngine")
  .status(config.tts.piperBin)
  .then((status) => {
    if (status.available) {
      ok(`Gefunden: ${status.bin}`);
    } else {
      bad(status.reason);
    }
    console.log("");
    process.exit(result.ok ? 0 : 1);
  })
  .catch((err) => {
    bad(err.message);
    process.exit(1);
  });

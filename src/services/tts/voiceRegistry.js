"use strict";
/**
 * Verzeichnis der verfügbaren Piper-Stimmen.
 *
 * Eine Stimme besteht aus zwei Dateien im Ordner `voices/`:
 *   de_DE-praxis-medium.onnx        (das Modell)
 *   de_DE-praxis-medium.onnx.json   (Metadaten: Abtastrate, Sprache, Sprecher)
 *
 * Die selbst trainierte Praxisstimme wird einfach dort abgelegt und taucht
 * dann automatisch in der Oberfläche auf – ein Neustart genügt.
 */
const fs = require("fs");
const path = require("path");
const config = require("../../config");
const log = require("../../util/logger")("voices");

let cache = { at: 0, list: [] };
const CACHE_MS = 10000;

function readMeta(jsonPath) {
  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    return null;
  }
}

/** Erzeugt einen sprechenden Anzeigenamen aus dem Dateinamen. */
function describe(id, meta) {
  const parts = id.split("-");
  const speaker = parts[1] ? parts[1].replace(/_/g, " ") : id;
  const quality = parts[2] || meta?.audio?.quality || "";
  const pretty = speaker.charAt(0).toUpperCase() + speaker.slice(1);
  return quality ? `${pretty} (${quality})` : pretty;
}

/**
 * Liest alle Stimmen aus dem konfigurierten Verzeichnis.
 * @param {boolean} force Cache umgehen
 */
function list(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.list;

  const dir = config.paths.voices;
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    log.warn(`Stimmverzeichnis ${dir} nicht lesbar: ${err.message}`);
    cache = { at: Date.now(), list: [] };
    return [];
  }

  const voices = files
    .filter((f) => f.endsWith(".onnx"))
    .map((file) => {
      const id = file.replace(/\.onnx$/, "");
      const modelPath = path.join(dir, file);
      const metaPath = `${modelPath}.json`;
      const meta = readMeta(metaPath);
      const stat = fs.statSync(modelPath);

      return {
        id,
        label: describe(id, meta),
        modelPath,
        hasMeta: Boolean(meta),
        language: meta?.language?.code || meta?.language || (id.startsWith("de") ? "de_DE" : "unbekannt"),
        sampleRate: meta?.audio?.sample_rate || 22050,
        quality: meta?.audio?.quality || id.split("-")[2] || "",
        speakerCount: meta?.num_speakers || 1,
        sizeMb: Math.round((stat.size / 1024 / 1024) * 10) / 10,
        /** Eigene Praxisstimme? Erkennung über Namenskonvention. */
        isCustom: /praxis|eigene|custom/i.test(id),
      };
    })
    .sort((a, b) => {
      if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  cache = { at: Date.now(), list: voices };
  return voices;
}

/** Liefert eine Stimme nach ID oder `null`. */
function get(id) {
  if (!id) return null;
  return list().find((v) => v.id === id) || null;
}

/**
 * Die aktuell zu verwendende Stimme.
 * Fällt nachvollziehbar zurück, statt – wie früher – zufällig zu wählen.
 */
function active() {
  const wanted = config.tts.voice;
  const voice = get(wanted);
  if (voice) return voice;

  const all = list();
  if (all.length === 0) return null;

  const fallback = all.find((v) => v.language.startsWith("de")) || all[0];
  log.warn(`Konfigurierte Stimme "${wanted}" nicht gefunden. Verwende stattdessen "${fallback.id}".`);
  return fallback;
}

function invalidate() {
  cache = { at: 0, list: [] };
}

module.exports = { list, get, active, invalidate };

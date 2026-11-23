"use strict";
/**
 * Aufmerksamkeitssignal vor der Ansage.
 *
 * Der Gong wird beim ersten Bedarf berechnet und als WAV abgelegt – so muss
 * keine Audiodatei mitgeliefert werden, und der Klang lässt sich über die
 * Konfiguration verändern.
 *
 * Klang: zwei Terzen (Quart-Abstand) mit exponentiell abfallender Hüllkurve,
 * wie ein klassischer Zweiklang-Gong im Wartezimmer.
 */
const fs = require("fs");
const path = require("path");
const config = require("../../config");
const log = require("../../util/logger")("gong");

const SAMPLE_RATE = 22050;

/**
 * Schreibt PCM-Samples als 16-Bit-Mono-WAV.
 * @param {Float32Array} samples Werte zwischen -1 und 1
 */
function writeWav(filePath, samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // Länge des fmt-Blocks
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // Byte pro Sekunde
  buffer.writeUInt16LE(2, 32); // Block-Ausrichtung
  buffer.writeUInt16LE(16, 34); // Bit pro Sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return buffer.length;
}

/**
 * Berechnet den Zweiklang.
 * @param {object} opts { tones: [Hz, Hz], spacingSec, decaySec, gain }
 */
function render({ tones = [660, 880], spacingSec = 0.32, decaySec = 1.5, gain = 0.28 } = {}) {
  const totalSec = spacingSec * (tones.length - 1) + decaySec + 0.2;
  const length = Math.round(totalSec * SAMPLE_RATE);
  const out = new Float32Array(length);

  tones.forEach((frequency, index) => {
    const offset = Math.round(index * spacingSec * SAMPLE_RATE);
    for (let n = 0; n + offset < length; n += 1) {
      const t = n / SAMPLE_RATE;
      const envelope = Math.exp(-t * (3 / decaySec));
      // Grundton plus leiser Oberton gibt dem Klang metallischen Charakter.
      const value =
        Math.sin(2 * Math.PI * frequency * t) * 0.8 +
        Math.sin(2 * Math.PI * frequency * 2.76 * t) * 0.2;
      out[n + offset] += value * envelope * gain;
    }
  });

  // Sanftes Ausblenden verhindert ein Knacken am Ende.
  const fade = Math.round(0.05 * SAMPLE_RATE);
  for (let i = 0; i < fade; i += 1) {
    out[length - 1 - i] *= i / fade;
  }

  return out;
}

let cached = null;

/**
 * Stellt sicher, dass die Gong-Datei existiert, und liefert Pfad und URL.
 * @returns {Promise<{file:string,url:string,durationMs:number}|null>}
 */
async function ensure() {
  if (!config.announcement.gongEnabled) return null;
  if (cached && fs.existsSync(cached.file)) return cached;

  const name = config.announcement.gongFile || "gong.wav";
  const file = path.join(config.paths.audioCache, name);

  if (!fs.existsSync(file)) {
    try {
      const samples = render(config.announcement.gongTones ? { tones: config.announcement.gongTones } : {});
      writeWav(file, samples);
      log.info(`Gong erzeugt: ${file}`);
    } catch (err) {
      log.error("Gong konnte nicht erzeugt werden:", err.message);
      return null;
    }
  }

  const stat = fs.statSync(file);
  cached = {
    file,
    url: `${config.app.publicUrl}/audio/${name}`,
    durationMs: Math.round(((stat.size - 44) / (SAMPLE_RATE * 2)) * 1000),
  };
  return cached;
}

/** Erzwingt eine Neuberechnung (nach Konfigurationsänderung). */
function invalidate() {
  if (cached && fs.existsSync(cached.file)) {
    fs.unlinkSync(cached.file);
  }
  cached = null;
}

module.exports = { ensure, invalidate, render, writeWav, SAMPLE_RATE };

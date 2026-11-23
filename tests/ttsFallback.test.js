"use strict";
/**
 * Ersatzstimme: Ist die eingestellte Stimme defekt (z. B. beschädigte
 * .onnx-Datei nach einem abgebrochenen Download), soll der Aufruf mit einer
 * anderen vollständigen deutschen Stimme trotzdem stattfinden.
 *
 * Hintergrund: Im Juni 2025 war genau das im Betrieb das Hauptproblem –
 * eine defekte Stimme legte jeden Aufruf lahm.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-tts-"));
const voicesDir = path.join(tmp, "voices");
fs.mkdirSync(voicesDir);
for (const id of ["de_DE-kaputt-medium", "de_DE-heil-medium"]) {
  fs.writeFileSync(path.join(voicesDir, `${id}.onnx`), "modell");
  fs.writeFileSync(path.join(voicesDir, `${id}.onnx.json`), JSON.stringify({ language: { code: "de_DE" }, audio: { sample_rate: 22050 } }));
}

process.env.USE_MEMORY_DB = "true";
process.env.SECURITY_AUTH_ENABLED = "false";
process.env.TTS_ENABLED = "true";
process.env.PIPER_VOICES_DIR = voicesDir;
process.env.PIPER_VOICE = "de_DE-kaputt-medium";
process.env.APP_PUBLIC_URL = "http://127.0.0.1:3300";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
config.paths.audioCache = path.join(tmp, "cache");

const piper = require("../src/services/tts/piperEngine");
const tts = require("../src/services/tts");

/** Minimale gültige WAV-Datei (1 s Stille, 8 kHz, 8 Bit). */
function writeWav(file) {
  const data = Buffer.alloc(8000, 128);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

const original = piper.synthesize;
let calls = [];

test.beforeEach(() => {
  calls = [];
  piper.synthesize = async ({ modelPath, outputPath }) => {
    calls.push(path.basename(modelPath));
    if (modelPath.includes("kaputt")) return { ok: false, durationMs: 1, error: "Modell beschädigt" };
    writeWav(outputPath);
    return { ok: true, durationMs: 1 };
  };
});

test.after(() => {
  piper.synthesize = original;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("springt auf eine andere Stimme um, wenn die eingestellte defekt ist", async () => {
  const result = await tts.speak("Herr Mustermann, bitte kommen Sie in Behandlungszimmer eins.");

  assert.equal(result.ok, true, result.error);
  assert.equal(result.voice, "de_DE-heil-medium");
  assert.deepEqual(calls, ["de_DE-kaputt-medium.onnx", "de_DE-heil-medium.onnx"]);
  assert.ok(result.durationMs > 900, "Die Spieldauer muss aus dem WAV-Kopf gelesen werden.");
});

test("überspringt eine als defekt erkannte Stimme beim nächsten Aufruf sofort", async () => {
  const result = await tts.speak("Frau Musterfrau, bitte kommen Sie in das Labor.");

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["de_DE-heil-medium.onnx"], "Die defekte Stimme darf nicht erneut versucht werden.");
});

test("ein ausdrücklicher Stimmtest nutzt genau die gewählte Stimme, ohne Ersatz", async () => {
  const result = await tts.speak("Test", { voiceId: "de_DE-kaputt-medium" });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["de_DE-kaputt-medium.onnx"]);
});

test("fehlt Piper ganz, werden nicht alle Stimmen nacheinander probiert", async () => {
  piper.synthesize = async ({ modelPath }) => {
    calls.push(path.basename(modelPath));
    return { ok: false, durationMs: 0, error: "Piper wurde nicht gefunden", engineUnavailable: true };
  };
  const result = await tts.speak("Noch ein ganz anderer Satz.");

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

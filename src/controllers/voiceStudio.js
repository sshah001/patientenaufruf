"use strict";
/**
 * Aufnahme-Studio für die eigene Praxisstimme.
 *
 * Ablauf für den Anwender:
 *   1. /voice-studio öffnen, Mikrofon freigeben.
 *   2. Die vorgegebenen Sätze nacheinander einsprechen (Leertaste = Aufnahme).
 *   3. Fertigen Datensatz als ZIP herunterladen.
 *   4. ZIP nach dem in docs/STIMME-TRAINIEREN.md beschriebenen Weg trainieren.
 *   5. Die entstandene .onnx-Datei nach voices/ legen – fertig.
 *
 * Der Datensatz wird direkt im LJSpeech-Format abgelegt, das Piper zum
 * Trainieren erwartet:
 *   wav/0001.wav, wav/0002.wav, …
 *   metadata.csv   ->  0001|Satztext|Satztext
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const config = require("../config");
const log = require("../util/logger")("stimme");
const { createZip } = require("../util/zip");
const tts = require("../services/tts");

const PROMPTS_FILE = path.join(config.paths.root, "tools", "prompts-de.txt");

function datasetDir() {
  return config.paths.voiceDataset;
}
function wavDir() {
  return path.join(datasetDir(), "wav");
}

/** Liest die Satzliste (Kommentare und Leerzeilen fallen weg). */
function loadPrompts() {
  if (!fs.existsSync(PROMPTS_FILE)) return [];
  return fs
    .readFileSync(PROMPTS_FILE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function clipName(index) {
  return `${String(index + 1).padStart(4, "0")}.wav`;
}

/** Spieldauer aus dem WAV-Header (ohne die Datei komplett zu lesen). */
function durationMs(file) {
  return tts.wavDurationMs(file);
}

// GET /api/voice-studio/prompts
exports.prompts = async (req, res, next) => {
  try {
    const prompts = loadPrompts();
    await fsp.mkdir(wavDir(), { recursive: true });
    const files = new Set(await fsp.readdir(wavDir()).catch(() => []));

    const items = prompts.map((text, index) => {
      const name = clipName(index);
      const recorded = files.has(name);
      return {
        index,
        text,
        recorded,
        durationMs: recorded ? durationMs(path.join(wavDir(), name)) : 0,
        url: recorded ? `/api/voice-studio/clip/${index}?t=${Date.now()}` : null,
      };
    });

    const recordedItems = items.filter((i) => i.recorded);
    const totalMs = recordedItems.reduce((sum, i) => sum + i.durationMs, 0);

    res.json({
      items,
      summary: {
        total: items.length,
        recorded: recordedItems.length,
        minutes: Math.round((totalMs / 60000) * 10) / 10,
        /** Erfahrungswert: ab etwa 20 Minuten wird ein Finetune brauchbar. */
        targetMinutes: 20,
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/voice-studio/clip/:index   (roher WAV-Body)
exports.saveClip = async (req, res, next) => {
  try {
    const index = Number.parseInt(req.params.index, 10);
    const prompts = loadPrompts();
    if (!Number.isInteger(index) || index < 0 || index >= prompts.length) {
      return res.status(400).json({ error: "Unbekannte Satznummer.", code: "BAD_INDEX" });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 1000) {
      return res.status(400).json({ error: "Aufnahme ist leer oder zu kurz.", code: "EMPTY" });
    }
    if (body.toString("ascii", 0, 4) !== "RIFF") {
      return res.status(400).json({ error: "Es werden nur WAV-Aufnahmen angenommen.", code: "BAD_FORMAT" });
    }

    await fsp.mkdir(wavDir(), { recursive: true });
    const file = path.join(wavDir(), clipName(index));
    await fsp.writeFile(file, body);

    const ms = durationMs(file);
    log.info(`Aufnahme ${index + 1} gespeichert (${Math.round(ms / 100) / 10} s).`);
    res.json({ ok: true, index, durationMs: ms, bytes: body.length });
  } catch (err) {
    next(err);
  }
};

// GET /api/voice-studio/clip/:index
exports.getClip = async (req, res, next) => {
  try {
    const index = Number.parseInt(req.params.index, 10);
    const file = path.join(wavDir(), clipName(index));
    if (!fs.existsSync(file)) return res.status(404).end();
    res.set("Content-Type", "audio/wav");
    res.set("Cache-Control", "no-store");
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    next(err);
  }
};

// DELETE /api/voice-studio/clip/:index
exports.deleteClip = async (req, res, next) => {
  try {
    const index = Number.parseInt(req.params.index, 10);
    const file = path.join(wavDir(), clipName(index));
    await fsp.unlink(file).catch(() => {});
    res.json({ ok: true, index });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/voice-studio/export
 * Liefert den kompletten Datensatz als ZIP im LJSpeech-Format.
 */
exports.exportDataset = async (req, res, next) => {
  try {
    const prompts = loadPrompts();
    const files = new Set(await fsp.readdir(wavDir()).catch(() => []));

    const entries = [];
    const metadata = [];

    for (let index = 0; index < prompts.length; index += 1) {
      const name = clipName(index);
      if (!files.has(name)) continue;
      const data = await fsp.readFile(path.join(wavDir(), name));
      entries.push({ name: `wav/${name}`, data });
      const id = name.replace(/\.wav$/, "");
      metadata.push(`${id}|${prompts[index]}|${prompts[index]}`);
    }

    if (entries.length === 0) {
      return res.status(400).json({ error: "Es wurden noch keine Aufnahmen gespeichert.", code: "EMPTY_DATASET" });
    }

    entries.push({ name: "metadata.csv", data: `${metadata.join("\n")}\n` });
    entries.push({
      name: "LIESMICH.txt",
      data:
        `Aufnahme-Datensatz fuer das Piper-Training\n` +
        `Erstellt: ${new Date().toISOString()}\n` +
        `Aufnahmen: ${entries.length - 1}\n\n` +
        `Format: LJSpeech (wav/ + metadata.csv).\n` +
        `Die Trainingsschritte stehen in docs/STIMME-TRAINIEREN.md.\n`,
    });

    const zip = createZip(entries);
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="praxisstimme-datensatz-${new Date().toISOString().slice(0, 10)}.zip"`,
      "Content-Length": String(zip.length),
    });
    res.send(zip);
    log.info(`Datensatz exportiert: ${entries.length - 2} Aufnahmen, ${Math.round(zip.length / 1024 / 1024)} MB.`);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/voice-studio/install   { }
 * Hinweis-Endpunkt: prüft, ob eine trainierte Stimme im voices-Ordner liegt,
 * und meldet, was noch fehlt.
 */
exports.checkInstall = async (req, res, next) => {
  try {
    const status = await tts.status();
    const custom = status.voices.filter((v) => v.isCustom);

    res.json({
      voicesDir: config.paths.voices,
      customVoices: custom,
      activeIsCustom: Boolean(status.activeVoice?.isCustom),
      hint: custom.length
        ? `Eigene Stimme gefunden. In der .env "PIPER_VOICE=${custom[0].id}" setzen und neu starten.`
        : `Noch keine eigene Stimme vorhanden. Die trainierten Dateien (.onnx und .onnx.json) nach ${config.paths.voices} kopieren.`,
    });
  } catch (err) {
    next(err);
  }
};

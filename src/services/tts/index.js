"use strict";
/**
 * Sprachausgabe mit Zwischenspeicher.
 *
 * Kernidee: Ein Ansagetext wird nur EINMAL synthetisiert. Der Dateiname ist der
 * Hash aus Stimme + Klangparametern + Text. Dadurch
 *   - ist der zweite Aufruf desselben Patienten sofort da,
 *   - kann nach dem Import die gesamte Tagesliste im Hintergrund vorproduziert
 *     werden ("prewarm") – der Knopfdruck löst dann eine Ansage ohne
 *     Wartezeit aus, auch auf einem Raspberry Pi.
 *
 * Die Dateinamen sind nicht erratbar (SHA-256), und der Zwischenspeicher wird
 * gemäß `privacy.audioRetentionHours` automatisch aufgeräumt.
 */
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const config = require("../../config");
const log = require("../../util/logger")("tts");
const { sanitizeForSpeech } = require("../../util/text");
const piper = require("./piperEngine");
const voices = require("./voiceRegistry");

/** Laufende Synthesen: verhindert doppelte Piper-Prozesse für denselben Text. */
const inFlight = new Map();

let lastError = null;
let generatedCount = 0;
let cacheHits = 0;

function ensureCacheDir() {
  fs.mkdirSync(config.paths.audioCache, { recursive: true });
}

/** Klangparameter der aktuellen Konfiguration. */
function synthOptions() {
  return {
    lengthScale: config.tts.lengthScale,
    noiseScale: config.tts.noiseScale,
    noiseW: config.tts.noiseW,
    sentenceSilenceSec: config.tts.sentenceSilenceSec,
  };
}

/** Eindeutiger, nicht erratbarer Dateiname für eine Text/Stimme-Kombination. */
function cacheKey(text, voiceId, options) {
  const payload = JSON.stringify([voiceId, text, options]);
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 40);
}

/**
 * Liest die Spieldauer aus dem WAV-Header.
 * Damit kennen wir die Länge, ohne ffmpeg oder Mopidy zu befragen.
 */
function wavDurationMs(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF") return 0;

    const byteRate = header.readUInt32LE(28);
    const size = fs.statSync(filePath).size;
    if (!byteRate) return 0;
    // 44 Byte Standard-Header abziehen.
    return Math.round(((size - 44) / byteRate) * 1000);
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Erzeugt (oder liefert aus dem Zwischenspeicher) die Audiodatei zu einem Text.
 *
 * @param {string} rawText  Der zu sprechende Satz.
 * @param {object} opts     { voiceId?: string, force?: boolean }
 * @returns {Promise<{ok:boolean, file?:string, url?:string, key?:string,
 *                    cached?:boolean, durationMs?:number, voice?:string, error?:string}>}
 */
async function speak(rawText, opts = {}) {
  if (!config.tts.enabled) {
    return { ok: false, error: "Sprachausgabe ist in der Konfiguration deaktiviert." };
  }

  const text = sanitizeForSpeech(rawText);
  if (!text) {
    return { ok: false, error: "Leerer Ansagetext." };
  }

  // Ausdrücklich gewählte Stimme (Stimmtest): genau diese, ohne Ersatz.
  if (opts.voiceId) {
    const voice = voices.get(opts.voiceId);
    if (!voice) return noVoice();
    return speakWith(text, voice, opts);
  }

  // Normaler Aufruf: aktive Stimme; ist sie defekt, springt eine andere
  // vollständige deutsche Stimme ein. Ein Patient wird lieber mit der
  // "falschen" Stimme aufgerufen als gar nicht.
  const candidates = voiceCandidates();
  if (candidates.length === 0) return noVoice();

  let result = null;
  for (const voice of candidates.slice(0, MAX_VOICE_ATTEMPTS)) {
    result = await speakWith(text, voice, opts);
    if (result.ok) {
      if (voice.id !== candidates[0].id) {
        log.warn(`Ersatzstimme "${voice.id}" verwendet, weil "${candidates[0].id}" nicht funktioniert.`);
      }
      return result;
    }
    if (result.engineUnavailable) break; // Piper selbst fehlt – andere Stimmen helfen nicht.
    markBroken(voice.id, result.error);
  }
  return result;
}

/** Stimmen, die zuletzt fehlschlugen, werden eine Weile übersprungen. */
const brokenVoices = new Map();
const BROKEN_FOR_MS = 30 * 60 * 1000;
const MAX_VOICE_ATTEMPTS = 3;

function markBroken(voiceId, error) {
  brokenVoices.set(voiceId, Date.now() + BROKEN_FOR_MS);
  log.warn(`Stimme "${voiceId}" wird für 30 Minuten übersprungen: ${String(error).slice(0, 160)}`);
}

function isBroken(voiceId) {
  const until = brokenVoices.get(voiceId);
  if (!until) return false;
  if (Date.now() > until) {
    brokenVoices.delete(voiceId);
    return false;
  }
  return true;
}

/** Aktive Stimme zuerst, danach die übrigen vollständigen deutschen Stimmen. */
function voiceCandidates() {
  const active = voices.active();
  const others = voices
    .list()
    .filter((v) => v.hasMeta && String(v.language).startsWith("de") && (!active || v.id !== active.id));
  const ordered = [active, ...others].filter(Boolean);
  const healthy = ordered.filter((v) => !isBroken(v.id));
  // Sind alle als defekt markiert, trotzdem die aktive Stimme erneut versuchen.
  return healthy.length ? healthy : ordered.slice(0, 1);
}

function noVoice() {
  const msg = `Keine Stimme verfügbar. Liegen .onnx-Dateien in ${config.paths.voices}?`;
  lastError = msg;
  return { ok: false, error: msg };
}

/** Synthese mit genau einer Stimme (mit Zwischenspeicher). */
async function speakWith(text, voice, opts = {}) {
  ensureCacheDir();
  const options = synthOptions();
  const key = cacheKey(text, voice.id, options);
  const file = path.join(config.paths.audioCache, `${key}.wav`);
  const url = `${config.app.publicUrl}/audio/${key}.wav`;

  // 1) Treffer im Zwischenspeicher
  if (!opts.force && fs.existsSync(file)) {
    cacheHits += 1;
    // Zugriffszeit auffrischen, damit die Aufräumlogik aktive Dateien verschont.
    fsp.utimes(file, new Date(), new Date()).catch(() => {});
    return { ok: true, file, url, key, cached: true, durationMs: wavDurationMs(file), voice: voice.id, text };
  }

  // 2) Läuft die Synthese bereits? Dann anhängen statt ein zweites Mal starten.
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const job = (async () => {
    const result = await piper.synthesize({
      text,
      modelPath: voice.modelPath,
      outputPath: file,
      options,
      binPath: config.tts.piperBin,
      timeoutMs: config.tts.timeoutMs,
    });

    if (!result.ok) {
      lastError = result.error;
      log.error(`Synthese fehlgeschlagen: ${result.error}`);
      await fsp.unlink(file).catch(() => {});
      return { ok: false, error: result.error, voice: voice.id, text, engineUnavailable: Boolean(result.engineUnavailable) };
    }

    generatedCount += 1;
    lastError = null;
    const durationMs = wavDurationMs(file);
    log.debug(`Erzeugt in ${result.durationMs} ms (${Math.round(durationMs / 100) / 10}s Audio): "${text.slice(0, 60)}"`);

    return { ok: true, file, url, key, cached: false, durationMs, voice: voice.id, text };
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Erzeugt mehrere Ansagen im Hintergrund vor.
 * Wird nach dem Patientenimport aufgerufen, damit der spätere Knopfdruck
 * ohne Verzögerung reagiert.
 *
 * @param {string[]} texts
 * @param {object} opts { concurrency?: number, onProgress?: (done, total) => void }
 */
async function prewarm(texts, opts = {}) {
  const unique = [...new Set(texts.map((t) => sanitizeForSpeech(t)).filter(Boolean))];
  const concurrency = Math.max(1, opts.concurrency || config.tts.prewarmConcurrency || 2);

  let done = 0;
  let generated = 0;
  let failed = 0;
  const started = Date.now();

  async function worker(queue) {
    while (queue.length) {
      const text = queue.shift();
      const result = await speak(text);
      done += 1;
      if (result.ok && !result.cached) generated += 1;
      if (!result.ok) failed += 1;
      if (opts.onProgress) opts.onProgress(done, unique.length);
    }
  }

  const queue = [...unique];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)));

  const summary = { total: unique.length, generated, failed, ms: Date.now() - started };
  log.info(`Vorproduktion fertig: ${summary.generated} neu, ${unique.length - generated - failed} bereits vorhanden, ${failed} Fehler (${summary.ms} ms).`);
  return summary;
}

/**
 * Räumt den Zwischenspeicher auf: zu alte Dateien (Datenschutz) und
 * Überzählige (Plattenplatz) werden gelöscht.
 */
async function cleanup() {
  ensureCacheDir();
  const dir = config.paths.audioCache;
  const maxAgeMs = Math.max(1, config.privacy.audioRetentionHours) * 3600 * 1000;
  const maxFiles = Math.max(10, config.tts.cacheMaxFiles);
  const now = Date.now();

  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }

  const files = [];
  for (const name of entries) {
    if (!name.endsWith(".wav")) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      files.push({ full, name, mtime: stat.mtimeMs, size: stat.size });
    } catch {
      /* Datei verschwand zwischenzeitlich */
    }
  }

  const doomed = new Set();
  for (const f of files) {
    if (now - f.mtime > maxAgeMs) doomed.add(f.full);
  }

  const survivors = files.filter((f) => !doomed.has(f.full)).sort((a, b) => b.mtime - a.mtime);
  for (const f of survivors.slice(maxFiles)) doomed.add(f.full);

  let removed = 0;
  for (const full of doomed) {
    try {
      await fsp.unlink(full);
      removed += 1;
    } catch {
      /* egal */
    }
  }

  if (removed) log.info(`Audio-Zwischenspeicher aufgeräumt: ${removed} Datei(en) gelöscht, ${files.length - removed} behalten.`);
  return { removed, kept: files.length - removed };
}

/** Löscht den kompletten Zwischenspeicher (Schaltfläche in der Oberfläche). */
async function clearCache() {
  ensureCacheDir();
  const entries = await fsp.readdir(config.paths.audioCache).catch(() => []);
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".wav")) continue;
    await fsp.unlink(path.join(config.paths.audioCache, name)).catch(() => {});
    removed += 1;
  }
  return { removed };
}

/** Zustandsbericht für die Diagnoseseite. */
async function status() {
  const engine = await piper.status(config.tts.piperBin);
  const all = voices.list(true);
  const activeVoice = voices.active();

  let cacheFiles = 0;
  let cacheBytes = 0;
  try {
    for (const name of await fsp.readdir(config.paths.audioCache)) {
      if (!name.endsWith(".wav")) continue;
      cacheFiles += 1;
      cacheBytes += (await fsp.stat(path.join(config.paths.audioCache, name))).size;
    }
  } catch {
    /* Verzeichnis existiert noch nicht */
  }

  return {
    enabled: config.tts.enabled,
    engine,
    activeVoice: activeVoice ? { id: activeVoice.id, label: activeVoice.label, isCustom: activeVoice.isCustom } : null,
    configuredVoice: config.tts.voice,
    voiceCount: all.length,
    voices: all.map((v) => ({ id: v.id, label: v.label, language: v.language, quality: v.quality, sizeMb: v.sizeMb, isCustom: v.isCustom })),
    cache: { files: cacheFiles, megabytes: Math.round((cacheBytes / 1024 / 1024) * 10) / 10, hits: cacheHits, generated: generatedCount },
    lastError,
  };
}

module.exports = { speak, prewarm, cleanup, clearCache, status, wavDurationMs, voices };

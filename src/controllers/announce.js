"use strict";
/**
 * Freie Durchsagen.
 *
 * Ein beliebiger Text wird mit der Praxisstimme gesprochen und über
 * Mopidy/Snapcast ausgegeben – z. B. „Die Praxis schließt in zehn Minuten."
 *
 * Der Auftrag geht durch dieselbe Warteschlange wie die Patientenaufrufe.
 * Dadurch kann eine Durchsage nie mitten in einen laufenden Aufruf platzen,
 * und umgekehrt.
 */
const crypto = require("crypto");

const config = require("../config");
const callQueue = require("../services/callQueue");
const tts = require("../services/tts");
const { sanitizeForSpeech } = require("../util/text");
const CallLogs = require("../db/callLogs");

const MAX_LENGTH = 300;

function fail(res, status, message, code) {
  return res.status(status).json({ error: message, code: code || "ERROR" });
}

/** Prüft und normalisiert den Durchsagetext. */
function readText(body) {
  const text = sanitizeForSpeech(body?.text || "");
  if (!text) return { error: "Bitte einen Text für die Durchsage eingeben." };
  if (text.length > MAX_LENGTH) {
    return { error: `Die Durchsage ist zu lang (maximal ${MAX_LENGTH} Zeichen).` };
  }
  return { text };
}

/**
 * POST /api/announce
 * { text, repeats?, gong?, showOnDisplay? }
 *
 * Antwortet, sobald die Durchsage eingereiht ist – nicht erst, wenn sie
 * gesprochen wurde. Den Fortschritt meldet die Warteschlange per WebSocket.
 */
exports.speak = async (req, res, next) => {
  try {
    const { text, error } = readText(req.body);
    if (error) return fail(res, 400, error, "VALIDATION");

    if (!config.tts.enabled) {
      return fail(res, 409, "Die Sprachausgabe ist in der Konfiguration abgeschaltet.", "TTS_DISABLED");
    }

    const job = {
      type: "announcement",
      id: crypto.randomBytes(6).toString("hex"),
      text,
      repeats: Math.min(3, Math.max(1, Number(req.body?.repeats) || 1)),
      gong: req.body?.gong !== false,
      showOnDisplay: req.body?.showOnDisplay === true,
      triggeredBy: req.session?.role || "durchsage",
    };

    const result = callQueue.enqueue(job);
    if (!result.accepted) return fail(res, 409, result.reason, "QUEUE_REJECTED");

    res.json({ ok: true, id: job.id, queued: result.position, text: job.text });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/announce/preview
 * Erzeugt die Ansage nur, ohne sie über die Lautsprecher auszugeben – zum
 * Gegenhören am Arbeitsplatz, bevor das halbe Wartezimmer es hört.
 */
exports.preview = async (req, res, next) => {
  try {
    const { text, error } = readText(req.body);
    if (error) return fail(res, 400, error, "VALIDATION");

    const audio = await tts.speak(text);
    if (!audio.ok) return fail(res, 500, audio.error, "TTS_FAILED");

    res.json({
      ok: true,
      url: audio.url,
      durationMs: audio.durationMs,
      cached: audio.cached,
      voice: audio.voice,
      text: audio.text,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/announce/presets
 * Häufig gebrauchte Durchsagen. Anpassbar über config/local.json unter
 * `announcement.presets`.
 */
exports.presets = (req, res) => {
  const presets = config.announcement.presets || [];
  res.json(presets);
};

/**
 * GET /api/announce/history
 * Die zuletzt gesprochenen Durchsagen – zum schnellen Wiederholen.
 */
exports.history = async (req, res, next) => {
  try {
    const entries = CallLogs.recent({ kind: "announcement", limit: 12 });

    // Doppelte Texte zusammenfassen, damit die Liste nutzbar bleibt.
    const seen = new Set();
    const unique = [];
    for (const entry of entries) {
      if (seen.has(entry.spokenText)) continue;
      seen.add(entry.spokenText);
      unique.push({ text: entry.spokenText, at: entry.createdAt, result: entry.result });
    }

    res.json(unique.slice(0, 6));
  } catch (err) {
    next(err);
  }
};

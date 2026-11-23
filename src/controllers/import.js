"use strict";
/**
 * Import der Tagesliste – zweistufig: erst Vorschau, dann Übernahme.
 */
const importService = require("../services/import");
const broadcast = require("../services/broadcast");
const config = require("../config");
const log = require("../util/logger")("import");

/**
 * Vorschauen werden kurz zwischengespeichert, damit die Oberfläche die
 * geprüften Daten übernehmen kann, ohne die Datei erneut hochzuladen.
 */
const previews = new Map();
const PREVIEW_TTL_MS = 15 * 60 * 1000;

function rememberPreview(preview) {
  previews.set(preview.batch, { preview, at: Date.now() });
  // Alte Vorschauen aufräumen.
  for (const [key, value] of previews) {
    if (Date.now() - value.at > PREVIEW_TTL_MS) previews.delete(key);
  }
}

// POST /api/import/preview   (multipart: file)
exports.preview = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Keine Datei empfangen.", code: "NO_FILE" });
    }

    const result = await importService.preview(req.file.buffer, req.file.originalname, {
      todayOnly: req.body?.todayOnly === "true" || req.body?.todayOnly === true,
    });

    rememberPreview(result);

    // Die vollständige Patientenliste bleibt auf dem Server; der Client
    // bekommt nur Kennzahlen, Zuordnung und eine kurze Stichprobe.
    const { patients, ...forClient } = result;
    res.json(forClient);
  } catch (err) {
    if (err.message.includes("gültiges JSON") || err.message.includes("CSV")) {
      return res.status(400).json({ error: err.message, code: "PARSE_ERROR" });
    }
    next(err);
  }
};

// POST /api/import/apply   { batch, mode, removeObsolete }
exports.apply = async (req, res, next) => {
  try {
    const { batch, mode, removeObsolete } = req.body || {};
    const entry = previews.get(batch);

    if (!entry) {
      return res.status(410).json({
        error: "Die Vorschau ist abgelaufen oder unbekannt. Bitte die Datei erneut hochladen.",
        code: "PREVIEW_EXPIRED",
      });
    }

    const summary = await importService.apply(entry.preview.patients, {
      mode: mode || config.import.defaultMode,
      removeObsolete: removeObsolete === true,
    });

    previews.delete(batch);
    await broadcast.patients();

    // Ansagen im Hintergrund vorproduzieren – die Antwort wartet nicht darauf.
    if (config.tts.enabled && config.tts.prewarmOnImport) {
      setImmediate(() => {
        importService
          .prewarmAnnouncements((done, total) => {
            if (done % 10 === 0 || done === total) {
              broadcast.importProgress({ phase: "prewarm", done, total });
            }
          })
          .then((result) => broadcast.importProgress({ phase: "prewarm-done", ...result }))
          .catch((err) => log.error("Vorproduktion fehlgeschlagen:", err.message));
      });
    }

    res.json({ ok: true, ...summary, prewarming: config.tts.enabled && config.tts.prewarmOnImport });
  } catch (err) {
    next(err);
  }
};

// POST /api/import/prewarm  – Vorproduktion von Hand anstoßen
exports.prewarm = async (req, res, next) => {
  try {
    const result = await importService.prewarmAnnouncements((done, total) => {
      if (done % 10 === 0 || done === total) broadcast.importProgress({ phase: "prewarm", done, total });
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
};

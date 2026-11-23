"use strict";
/**
 * Einheitliche Fehlerbehandlung.
 *
 * Nach außen gehen verständliche deutsche Meldungen; der technische
 * Hintergrund landet im Log. Im Produktivbetrieb wird kein Stacktrace an den
 * Browser geschickt.
 */
const config = require("../config");
const log = require("../util/logger")("http");

function notFound(req, res) {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: `Unbekannte Schnittstelle: ${req.method} ${req.path}`, code: "NOT_FOUND" });
  }
  res.status(404).sendFile(require("path").join(config.paths.public, "404.html"), (err) => {
    if (err) res.status(404).send("<h1>Seite nicht gefunden</h1>");
  });
}

// eslint-disable-next-line no-unused-vars
function handler(err, req, res, next) {
  // Multer-Fehler übersetzen
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: `Die Datei ist größer als ${config.import.maxFileSizeMb} MB.`,
      code: "FILE_TOO_LARGE",
    });
  }
  if (err.name === "ValidationError") {
    return res.status(400).json({ error: err.message, code: "VALIDATION" });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    log.error(`${req.method} ${req.path}:`, err.stack || err.message);
  } else {
    log.warn(`${req.method} ${req.path}: ${err.message}`);
  }

  res.status(status).json({
    error: status >= 500 ? "Interner Serverfehler. Details stehen im Serverprotokoll." : err.message,
    code: err.code || "ERROR",
    ...(config.isProduction ? {} : { detail: err.message }),
  });
}

module.exports = { notFound, handler };

"use strict";
/**
 * Anmeldung des Praxispersonals per PIN.
 */
const auth = require("../middleware/auth");
const config = require("../config");
const log = require("../util/logger")("auth");

// POST /api/auth/login   { pin }
exports.login = (req, res) => {
  if (!config.security.authEnabled) {
    return res.json({ ok: true, authDisabled: true });
  }

  const lockedFor = auth.isLockedOut(req);
  if (lockedFor) {
    return res.status(429).json({
      error: `Zu viele Fehlversuche. Bitte in ${lockedFor} Sekunden erneut versuchen.`,
      code: "LOCKED",
      retryAfterSec: lockedFor,
    });
  }

  const pin = String(req.body?.pin || "");
  if (!auth.checkPin(pin)) {
    auth.noteFailure(req);
    log.warn(`Fehlgeschlagene Anmeldung von ${req.ip}.`);
    // Bewusst kurze Verzögerung gegen automatisiertes Raten.
    return setTimeout(() => res.status(401).json({ error: "PIN ist falsch.", code: "BAD_PIN" }), 400);
  }

  auth.noteSuccess(req);
  auth.issueSession(res, { at: Date.now() });
  log.info(`Anmeldung erfolgreich von ${req.ip}.`);
  res.json({ ok: true, sessionHours: config.security.sessionHours });
};

// POST /api/auth/logout
exports.logout = (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
};

// GET /api/auth/me
exports.me = (req, res) => {
  res.json({
    authenticated: Boolean(req.session) || !config.security.authEnabled,
    authEnabled: config.security.authEnabled,
    role: req.session?.role || (config.security.authEnabled ? null : "staff"),
  });
};

"use strict";
/**
 * Schlanker Logger ohne externe Abhängigkeit.
 *
 * Wichtig für eine Arztpraxis: Patientennamen gehören nicht dauerhaft in
 * Logdateien. `logger.patient()` kürzt Namen deshalb automatisch, sobald
 * NODE_ENV=production gesetzt ist.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS.info;
let redactNames = process.env.NODE_ENV === "production";

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function emit(level, scope, args) {
  if (LEVELS[level] > currentLevel) return;
  const prefix = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(prefix, ...args);
}

/**
 * Erzeugt einen Logger für einen Programmbereich, z. B. `logger("tts")`.
 */
function logger(scope) {
  return {
    error: (...args) => emit("error", scope, args),
    warn: (...args) => emit("warn", scope, args),
    info: (...args) => emit("info", scope, args),
    debug: (...args) => emit("debug", scope, args),

    /** Namen datenschutzfreundlich für Logs aufbereiten: "Mustermann" -> "M." */
    patient(name) {
      const value = String(name || "").trim();
      if (!value) return "?";
      return redactNames ? `${value.charAt(0)}.` : value;
    },
  };
}

logger.setLevel = function setLevel(level) {
  if (level in LEVELS) currentLevel = LEVELS[level];
};
logger.setRedactNames = function setRedactNames(value) {
  redactNames = Boolean(value);
};
logger.LEVELS = LEVELS;

module.exports = logger;

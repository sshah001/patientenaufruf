"use strict";
/**
 * Bündelt alle Echtzeit-Benachrichtigungen an einer Stelle.
 *
 * Wichtig: Die vollständige Patientenliste geht ausschließlich an angemeldete
 * Bedienplätze. Anzeigegeräte erhalten nur den aufbereiteten Aufruf.
 */
const realtime = require("../realtime");
const config = require("../config");
const Patients = require("../db/patients");
const signage = require("./signage");

let pending = null;

/**
 * Sendet die aktuelle Patientenliste an alle Bedienplätze.
 * Mehrere Aufrufe kurz hintereinander werden zu einem zusammengefasst.
 */
async function patients() {
  if (pending) return pending;

  pending = (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const list = Patients.list();
    realtime.toStaff("patients:updated", list);
    pending = null;
    return list;
  })();

  return pending;
}

/** Meldet einen Aufruf an Wartezimmer-TV und Monitore. */
function call(payload) {
  realtime.toDisplay("call:new", {
    call: payload.call,
    recent: signage.recent(config.signage.overlay.tickerCount),
    popupSeconds: config.signage.overlay.popupSeconds,
  });
  realtime.toStaff("call:new", payload);
}

/** Freie Durchsage auf den Wartezimmer-Anzeigen einblenden. */
function announcement(payload) {
  realtime.toDisplay("announcement:new", {
    text: payload.text,
    seconds: payload.seconds,
  });
  realtime.toStaff("announcement:new", payload);
}

/** Fortschritt eines laufenden Aufrufs (Bedienoberfläche zeigt ihn als Statuszeile). */
function callPhase(payload) {
  realtime.toStaff("call:phase", payload);
}

function warning(payload) {
  realtime.toStaff("call:warning", payload);
}

function queue(state) {
  realtime.toStaff("queue:state", state);
}

/** Anzeigegeräte auffordern, ihren Stand neu zu laden (z. B. nach Zurücksetzen). */
function displayRefresh() {
  realtime.toDisplay("display:refresh", {
    recent: signage.recent(config.signage.overlay.tickerCount),
  });
}

function importProgress(payload) {
  realtime.toStaff("import:progress", payload);
}

module.exports = {
  patients,
  call,
  announcement,
  callPhase,
  warning,
  queue,
  displayRefresh,
  importProgress,
};

"use strict";
/**
 * Patientenliste und Aufruf.
 */
const config = require("../config");
const Patients = require("../db/patients");
const CallLogs = require("../db/callLogs");
const callQueue = require("../services/callQueue");
const broadcast = require("../services/broadcast");
const signage = require("../services/signage");
const log = require("../util/logger")("patienten");

const VALID_STATUS = ["waiting", "called", "in_treatment", "completed", "no_show"];

/** Kleiner Helfer: Fehler einheitlich beantworten. */
function fail(res, status, message, code) {
  return res.status(status).json({ error: message, code: code || "ERROR" });
}

// GET /api/patients
exports.list = async (req, res, next) => {
  try {
    const statuses = req.query.status
      ? String(req.query.status).split(",").filter((s) => VALID_STATUS.includes(s))
      : [];
    const patients = Patients.list({ statuses, search: req.query.search });
    res.json(patients);
  } catch (err) {
    next(err);
  }
};

// GET /api/patients/:id
exports.get = async (req, res, next) => {
  try {
    const patient = Patients.get(req.params.id);
    if (!patient) return fail(res, 404, "Patient nicht gefunden.", "NOT_FOUND");
    res.json(patient);
  } catch (err) {
    next(err);
  }
};

// POST /api/patients
exports.create = async (req, res, next) => {
  try {
    const { firstName, lastName, gender, appointmentAt, note } = req.body;
    if (!lastName || !String(lastName).trim()) {
      return fail(res, 400, "Ein Nachname ist erforderlich.", "VALIDATION");
    }

    const patient = Patients.create({
      firstName: String(firstName || "").trim(),
      lastName: String(lastName).trim(),
      gender: VALID_GENDER(gender),
      // Ohne Terminangabe zählt die Ankunftszeit. Sonst stünde ein spontan
      // hinzugefügter Patient (leeres Datum) ganz oben in der Warteliste und
      // würde vor allen angemeldeten Terminen aufgerufen.
      appointmentAt: appointmentAt ? new Date(appointmentAt) : new Date(),
      note: String(note || "").trim(),
      status: "waiting",
      source: "manual",
    });

    await broadcast.patients();
    res.status(201).json(patient);
  } catch (err) {
    next(err);
  }
};

function VALID_GENDER(value) {
  return ["male", "female", "other"].includes(value) ? value : "other";
}

// PUT /api/patients/:id
exports.update = async (req, res, next) => {
  try {
    const allowed = ["firstName", "lastName", "gender", "appointmentAt", "note", "practitioner", "visitMotive"];
    const update = {};
    for (const key of allowed) {
      if (key in req.body) update[key] = req.body[key];
    }
    if (update.gender) update.gender = VALID_GENDER(update.gender);

    const patient = Patients.update(req.params.id, update);
    if (!patient) return fail(res, 404, "Patient nicht gefunden.", "NOT_FOUND");

    await broadcast.patients();
    res.json(patient);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/patients/:id/status   { status, roomId? }
exports.setStatus = async (req, res, next) => {
  try {
    const { status, roomId } = req.body;
    if (!VALID_STATUS.includes(status)) {
      return fail(res, 400, `Unbekannter Status "${status}".`, "VALIDATION");
    }

    const update = { status };

    // Zurück in die Warteliste: Raumzuordnung aufheben.
    if (status === "waiting") {
      update.room = "";
      update.roomId = "";
    }

    // Wurde der Patient persönlich abgeholt, kann hier ein Raum mitgegeben
    // werden – ohne dass eine Ansage läuft.
    if (roomId) {
      const room = config.practice.rooms.find((r) => r.id === roomId);
      if (!room) {
        return fail(res, 400, `Unbekannter Raum "${roomId}".`, "UNKNOWN_ROOM");
      }
      update.room = room.label;
      update.roomId = room.id;
    }

    const patient = Patients.update(req.params.id, update);
    if (!patient) return fail(res, 404, "Patient nicht gefunden.", "NOT_FOUND");

    await broadcast.patients();
    res.json(patient);
  } catch (err) {
    next(err);
  }
};

// DELETE /api/patients/:id
exports.remove = async (req, res, next) => {
  try {
    const deleted = Patients.remove(req.params.id);
    if (!deleted) return fail(res, 404, "Patient nicht gefunden.", "NOT_FOUND");

    await broadcast.patients();
    res.json({ ok: true, message: "Patient gelöscht." });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/patients  (Tagesabschluss)
exports.removeAll = async (req, res, next) => {
  try {
    // Absichtssicherung: ohne bestätigten Parameter passiert nichts.
    if (req.body?.confirm !== true) {
      return fail(res, 400, 'Zum Leeren der Liste bitte {"confirm": true} senden.', "CONFIRM_REQUIRED");
    }

    const keepActive = req.body.keepActive === true;
    const deletedCount = keepActive
      ? Patients.removeAll({ statuses: ["waiting", "completed", "no_show"] })
      : Patients.removeAll();

    signage.clear();
    await broadcast.patients();
    broadcast.displayRefresh();

    log.info(`Liste geleert: ${deletedCount} Einträge entfernt.`);
    res.json({ ok: true, deleted: deletedCount });
  } catch (err) {
    next(err);
  }
};

// POST /api/patients/:id/call   { roomId }
exports.call = async (req, res, next) => {
  try {
    const patient = Patients.get(req.params.id);
    if (!patient) return fail(res, 404, "Patient nicht gefunden.", "NOT_FOUND");

    const roomId = req.body?.roomId;
    const room = config.practice.rooms.find((r) => r.id === roomId);
    if (!room) {
      return fail(res, 400, `Unbekannter Raum "${roomId}". Verfügbar: ${config.practice.rooms.map((r) => r.id).join(", ")}`, "UNKNOWN_ROOM");
    }

    const result = callQueue.enqueue({
      patientId: String(patient._id),
      roomId: room.id,
      roomLabel: room.label,
      triggeredBy: req.session?.role || "ui",
    });

    if (!result.accepted) {
      return fail(res, 409, result.reason, "QUEUE_REJECTED");
    }

    res.json({
      ok: true,
      queued: result.position,
      patient: { id: String(patient._id), lastName: patient.lastName },
      room: { id: room.id, label: room.label },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/patients/:id/recall  – nochmals ausrufen, Status bleibt
exports.recall = async (req, res, next) => {
  try {
    const patient = Patients.get(req.params.id);
    if (!patient) return fail(res, 404, "Patient nicht gefunden.", "NOT_FOUND");

    const roomId = req.body?.roomId || patient.roomId;
    const room = config.practice.rooms.find((r) => r.id === roomId);
    if (!room) return fail(res, 400, "Für den erneuten Aufruf ist kein Raum hinterlegt.", "UNKNOWN_ROOM");

    const result = callQueue.enqueue({
      patientId: String(patient._id),
      roomId: room.id,
      roomLabel: room.label,
      triggeredBy: "recall",
    });
    if (!result.accepted) return fail(res, 409, result.reason, "QUEUE_REJECTED");

    res.json({ ok: true, queued: result.position });
  } catch (err) {
    next(err);
  }
};

// POST /api/queue/abort
exports.abortQueue = async (req, res, next) => {
  try {
    const result = await callQueue.abortAll();
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
};

// GET /api/queue
exports.queueState = (req, res) => {
  res.json(callQueue.state());
};

// POST /api/patients/reset  – alle Aufgerufenen zurück in die Warteliste
exports.resetCalled = async (req, res, next) => {
  try {
    const resetCount = Patients.resetActive();
    signage.clear();
    await broadcast.patients();
    broadcast.displayRefresh();
    res.json({ ok: true, reset: resetCount });
  } catch (err) {
    next(err);
  }
};

// GET /api/calls  – Aufrufprotokoll
exports.callLog = async (req, res, next) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const entries = CallLogs.recent({ limit });
    res.json(entries);
  } catch (err) {
    next(err);
  }
};

// GET /api/rooms
exports.rooms = (req, res) => {
  res.json(config.practice.rooms);
};

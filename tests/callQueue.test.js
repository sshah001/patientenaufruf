"use strict";
/**
 * Tests für die Aufruf-Warteschlange.
 *
 * Der wichtigste Punkt: zwei schnell hintereinander ausgelöste Aufrufe dürfen
 * sich nicht überlagern. Genau das war in der Vorversion der Fall, weil die
 * Audiowiedergabe nicht abgewartet wurde.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { CallQueue } = require("../src/services/callQueue");

/** Ersetzt _process durch eine Attrappe, die messbar Zeit braucht. */
function makeQueue(onProcess) {
  const queue = new CallQueue();
  queue._process = onProcess;
  return queue;
}

test("arbeitet Aufrufe streng nacheinander ab", async () => {
  const ablauf = [];
  let gleichzeitig = 0;
  let maxGleichzeitig = 0;

  const queue = makeQueue(async (job) => {
    gleichzeitig += 1;
    maxGleichzeitig = Math.max(maxGleichzeitig, gleichzeitig);
    ablauf.push(`start:${job.patientId}`);
    await new Promise((r) => setTimeout(r, 30));
    ablauf.push(`ende:${job.patientId}`);
    gleichzeitig -= 1;
  });

  const fertig = new Promise((resolve) => queue.once("idle", resolve));

  queue.enqueue({ patientId: "1", roomId: "bz1", roomLabel: "BZ 1" });
  queue.enqueue({ patientId: "2", roomId: "bz2", roomLabel: "BZ 2" });
  queue.enqueue({ patientId: "3", roomId: "bz3", roomLabel: "BZ 3" });

  await fertig;

  assert.equal(maxGleichzeitig, 1, "Es darf immer nur ein Aufruf gleichzeitig laufen.");
  assert.deepEqual(ablauf, [
    "start:1", "ende:1",
    "start:2", "ende:2",
    "start:3", "ende:3",
  ]);
});

test("meldet die Position in der Warteschlange richtig", async () => {
  const queue = makeQueue(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

  const erster = queue.enqueue({ patientId: "1", roomId: "a", roomLabel: "A" });
  const zweiter = queue.enqueue({ patientId: "2", roomId: "a", roomLabel: "A" });
  const dritter = queue.enqueue({ patientId: "3", roomId: "a", roomLabel: "A" });

  assert.equal(erster.position, 1);
  assert.equal(zweiter.position, 2);
  assert.equal(dritter.position, 3);

  await new Promise((resolve) => queue.once("idle", resolve));
});

test("weist denselben Patienten nicht zweimal in die Warteschlange", async () => {
  const queue = makeQueue(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });

  queue.enqueue({ patientId: "1", roomId: "a", roomLabel: "A" });
  queue.enqueue({ patientId: "2", roomId: "a", roomLabel: "A" });
  const doppelt = queue.enqueue({ patientId: "2", roomId: "b", roomLabel: "B" });

  assert.equal(doppelt.accepted, false);
  assert.match(doppelt.reason, /bereits/);

  await new Promise((resolve) => queue.once("idle", resolve));
});

test("lehnt Aufrufe ab, wenn die Warteschlange voll ist", async () => {
  const config = require("../src/config");
  const original = config.announcement.maxQueueLength;
  config.announcement.maxQueueLength = 2;

  const queue = makeQueue(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });

  queue.enqueue({ patientId: "1", roomId: "a", roomLabel: "A" });
  queue.enqueue({ patientId: "2", roomId: "a", roomLabel: "A" });
  const abgelehnt = queue.enqueue({ patientId: "3", roomId: "a", roomLabel: "A" });

  assert.equal(abgelehnt.accepted, false);
  assert.match(abgelehnt.reason, /voll/);

  config.announcement.maxQueueLength = original;
  await new Promise((resolve) => queue.once("idle", resolve));
});

test("ein Fehler in einem Aufruf blockiert die folgenden nicht", async () => {
  const verarbeitet = [];
  const queue = makeQueue(async (job) => {
    if (job.patientId === "2") throw new Error("Absicht");
    verarbeitet.push(job.patientId);
  });

  const fehler = [];
  queue.on("failed", (payload) => fehler.push(payload.error));

  queue.enqueue({ patientId: "1", roomId: "a", roomLabel: "A" });
  queue.enqueue({ patientId: "2", roomId: "a", roomLabel: "A" });
  queue.enqueue({ patientId: "3", roomId: "a", roomLabel: "A" });

  await new Promise((resolve) => queue.once("idle", resolve));

  assert.deepEqual(verarbeitet, ["1", "3"]);
  assert.deepEqual(fehler, ["Absicht"]);
});

test("abortAll leert die Warteschlange", async () => {
  const queue = makeQueue(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  queue.enqueue({ patientId: "1", roomId: "a", roomLabel: "A" });
  queue.enqueue({ patientId: "2", roomId: "a", roomLabel: "A" });
  queue.enqueue({ patientId: "3", roomId: "a", roomLabel: "A" });

  const result = await queue.abortAll();
  assert.equal(result.cleared, 2, "Der laufende Aufruf zählt nicht mit.");
  assert.equal(queue.state().queued, 0);

  await new Promise((resolve) => queue.once("idle", resolve));
});

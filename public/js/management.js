/* Übersicht: wartende Patienten links, laufende Behandlungen rechts.
 *
 * Der Aufbau folgt dem bewährten Ablauf aus der Vorversion: In jeder Zeile
 * wird der Zielraum direkt gewählt und aufgerufen – so kann eine Person am
 * Tresen Patienten auf verschiedene Zimmer verteilen, ohne vorher irgendwo
 * umzuschalten.
 */
"use strict";

const { api, toast, timeOf, agoOf, el, icon, iconButton, connectStaffSocket, confirmDialog, formDialog } = window.PA;

const state = {
  patients: [],
  rooms: [],
  search: "",
  /** Zuletzt gewählter Raum – wird in neuen Zeilen vorbelegt. */
  lastRoomId: localStorage.getItem("pa.lastRoomId") || "",
  /** Patienten, für die gerade eine Ansage läuft oder ansteht. */
  busy: new Set(),
};

const dom = {
  waitingBody: document.getElementById("waitingBody"),
  waitingEmpty: document.getElementById("waitingEmpty"),
  waitingCount: document.getElementById("waitingCount"),
  treatmentList: document.getElementById("treatmentList"),
  treatmentEmpty: document.getElementById("treatmentEmpty"),
  treatmentCount: document.getElementById("treatmentCount"),
  completedList: document.getElementById("completedList"),
  completedCount: document.getElementById("completedCount"),
  currentCall: document.getElementById("currentCall"),
  currentWho: document.getElementById("currentWho"),
  currentPhase: document.getElementById("currentPhase"),
  abortBtn: document.getElementById("abortBtn"),
  search: document.getElementById("search"),
  healthDot: document.getElementById("healthDot"),
  liveDot: document.getElementById("liveDot"),
  connState: document.getElementById("connState"),
  sourceLine: document.getElementById("sourceLine"),

  announceText: document.getElementById("announceText"),
  announceBtn: document.getElementById("announceBtn"),
  previewBtn: document.getElementById("previewBtn"),
  announcePlayer: document.getElementById("announcePlayer"),
  announceCount: document.getElementById("announceCount"),
  announceHint: document.getElementById("announceHint"),
  presets: document.getElementById("presets"),
  optGong: document.getElementById("optGong"),
  optDisplay: document.getElementById("optDisplay"),
  optRepeats: document.getElementById("optRepeats"),
};

const idOf = (patient) => String(patient.id || patient._id);
const roomById = (id) => state.rooms.find((r) => r.id === id) || null;

const ANREDE = { male: "Herr", female: "Frau", other: "" };

function dateOf(value) {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ------------------------------------------------------------- Aufteilung

function matchesSearch(patient) {
  const term = state.search.trim().toLowerCase();
  if (!term) return true;
  return `${patient.lastName} ${patient.firstName}`.toLowerCase().includes(term);
}

function groups() {
  const waiting = [];
  const treatment = [];
  const completed = [];

  for (const patient of state.patients) {
    if (patient.status === "waiting") waiting.push(patient);
    else if (patient.status === "called" || patient.status === "in_treatment") treatment.push(patient);
    else completed.push(patient);
  }

  // Aufgerufene zuletzt oben – das ist der Patient, um den es gerade geht.
  treatment.sort((a, b) => new Date(b.calledAt || b.updatedAt) - new Date(a.calledAt || a.updatedAt));
  completed.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return { waiting, treatment, completed };
}

// ------------------------------------------------------- Wartende Patienten

function roomSelect(patient) {
  const select = el("select", { "aria-label": `Raum für ${patient.lastName}` });
  select.appendChild(el("option", { value: "", text: "Raum wählen" }));

  for (const room of state.rooms) {
    const option = el("option", { value: room.id, text: room.label });
    if (room.id === state.lastRoomId) option.selected = true;
    select.appendChild(option);
  }

  select.addEventListener("change", () => {
    state.lastRoomId = select.value;
    if (select.value) localStorage.setItem("pa.lastRoomId", select.value);
    // Andere Zeilen mitziehen, damit die Wahl nur einmal nötig ist.
    for (const other of dom.waitingBody.querySelectorAll("select")) {
      if (other !== select && !other.dataset.touched) other.value = select.value;
    }
    select.dataset.touched = "1";
  });

  return select;
}

function renderWaiting(list) {
  dom.waitingBody.replaceChildren();

  for (const patient of list) {
    const id = idOf(patient);
    const busy = state.busy.has(id);
    const tr = el("tr", { "data-id": id, class: busy ? "busy" : "" });

    tr.appendChild(el("td", { class: "muted", text: ANREDE[patient.gender] || "–" }));
    tr.appendChild(el("td", { class: "name", text: patient.lastName }));
    tr.appendChild(el("td", { text: patient.firstName || "–" }));
    tr.appendChild(el("td", { class: "num muted", text: dateOf(patient.appointmentAt) }));
    tr.appendChild(el("td", { class: "num", text: timeOf(patient.appointmentAt) || "–" }));
    tr.appendChild(el("td", { class: "muted", text: patient.practitioner || patient.visitMotive || "–" }));

    const select = roomSelect(patient);
    const voll = `${patient.lastName}${patient.firstName ? `, ${patient.firstName}` : ""}`;

    const callBtn = iconButton({
      icon: "lautsprecher",
      text: busy ? "läuft…" : "Aufrufen",
      label: voll,
      class: "call",
      disabled: busy,
      title: "Ansage abspielen und auf dem Wartezimmer-Monitor anzeigen",
      onclick: () => {
        if (!select.value) {
          toast("Bitte zuerst einen Raum wählen.", "warn");
          select.focus();
          return;
        }
        callPatient(id, select.value);
      },
    });

    const cancelBtn = iconButton({
      icon: "verboten",
      text: "Abgesagt",
      label: voll,
      class: "cancel",
      title: "Patient ist nicht erschienen oder hat abgesagt",
      onclick: () => setStatus(id, "no_show"),
    });

    const menuBtn = iconButton({
      icon: "mehr",
      class: "ghost",
      label: `Weitere Aktionen für ${voll}`,
      onclick: () => patientMenu(patient),
    });

    tr.appendChild(el("td", { class: "actions" }, el("div", { class: "rowactions" }, [select, callBtn, cancelBtn, menuBtn])));
    dom.waitingBody.appendChild(tr);
  }

  dom.waitingEmpty.hidden = list.length > 0;
  if (list.length === 0) {
    dom.waitingEmpty.textContent = state.search
      ? "Kein wartender Patient passt zur Suche."
      : state.patients.length === 0
        ? "Noch keine Patienten für heute. Tagesliste unter „Import“ hochladen."
        : "Alle Patienten sind aufgerufen oder erledigt.";
  }
}

// --------------------------------------------------------- In Behandlung

function renderTreatment(list) {
  dom.treatmentList.replaceChildren();

  for (const patient of list) {
    const id = idOf(patient);
    const room = roomById(patient.roomId);
    const busy = state.busy.has(id);

    const card = el("div", {
      class: "treatcard",
      style: `--room:${room ? room.color : "var(--accent)"}`,
    });

    card.appendChild(el("div", { class: "top" }, [
      el("span", { class: "who", text: `${ANREDE[patient.gender] ? `${ANREDE[patient.gender]} ` : ""}${patient.lastName}` }),
      el("span", { class: "roombadge", text: patient.room || "ohne Raum" }),
      el("span", {
        class: `badge ${patient.status}`,
        text: patient.status === "called" ? "Aufgerufen" : "In Behandlung",
      }),
    ]));

    const details = [
      patient.firstName,
      patient.calledAt ? agoOf(patient.calledAt) : null,
      patient.callCount > 1 ? `${patient.callCount}× gerufen` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (details) card.appendChild(el("div", { class: "meta", text: details }));

    const voll = `${patient.lastName}${patient.firstName ? `, ${patient.firstName}` : ""}`;

    card.appendChild(el("div", { class: "buttons" }, [
      iconButton({
        icon: "haken-kreis",
        text: "Beenden",
        label: voll,
        class: "finish",
        title: "Behandlung abschließen",
        onclick: () => setStatus(id, "completed"),
      }),
      iconButton({
        icon: "zurueck",
        text: busy ? "läuft…" : "Zurückrufen",
        label: voll,
        class: "recall",
        disabled: busy || !patient.roomId,
        title: patient.roomId ? "Ansage erneut abspielen" : "Kein Raum hinterlegt",
        onclick: () => recallPatient(id),
      }),
      iconButton({
        icon: "mehr",
        class: "ghost",
        label: `Weitere Aktionen für ${voll}`,
        onclick: () => patientMenu(patient),
      }),
    ]));

    dom.treatmentList.appendChild(card);
  }

  dom.treatmentEmpty.hidden = list.length > 0;
}

// ------------------------------------------------------------- Erledigt

function renderCompleted(list) {
  dom.completedList.replaceChildren();
  dom.completedCount.textContent = list.length ? `(${list.length})` : "";

  if (list.length === 0) {
    dom.completedList.appendChild(el("p", { class: "muted", style: "padding:6px 6px 10px", text: "Heute noch nichts abgeschlossen." }));
    return;
  }

  const table = el("table");
  const tbody = el("tbody");
  for (const patient of list) {
    const id = idOf(patient);
    tbody.appendChild(el("tr", {}, [
      el("td", { class: "num muted", text: timeOf(patient.updatedAt) }),
      el("td", { text: `${ANREDE[patient.gender] ? `${ANREDE[patient.gender]} ` : ""}${patient.lastName}${patient.firstName ? `, ${patient.firstName}` : ""}` }),
      el("td", { class: "muted", text: patient.room || "–" }),
      el("td", {}, el("span", {
        class: `badge ${patient.status}`,
        text: patient.status === "no_show" ? "Nicht erschienen" : "Fertig",
      })),
      el("td", { class: "right" }, iconButton({
        icon: "erneuern",
        text: "Zurück in die Liste",
        label: patient.lastName,
        class: "ghost small",
        onclick: () => setStatus(id, "waiting"),
      })),
    ]));
  }
  table.appendChild(tbody);
  dom.completedList.appendChild(table);
}

// ---------------------------------------------------------------- Rendern

function render() {
  const all = groups();
  const waiting = all.waiting.filter(matchesSearch);
  const treatment = all.treatment.filter(matchesSearch);

  renderWaiting(waiting);
  renderTreatment(treatment);
  renderCompleted(all.completed.filter(matchesSearch));

  dom.waitingCount.textContent = state.search ? `${waiting.length} / ${all.waiting.length}` : String(all.waiting.length);
  dom.treatmentCount.textContent = String(all.treatment.length);

  const quellen = new Set(state.patients.map((p) => p.source).filter(Boolean));
  dom.sourceLine.textContent = state.patients.length
    ? `${state.patients.length} Termine in der Tagesliste${quellen.size ? ` (Quelle: ${[...quellen].join(", ")})` : ""}`
    : "Noch keine Tagesliste importiert";
}

// ----------------------------------------------------------- Aktueller Aufruf

function showCurrent({ who, room, phase, active }) {
  // "empty" nur, solange überhaupt kein Aufruf vorliegt – ein vergangener
  // Aufruf bleibt farbig, damit er ablesbar bleibt.
  dom.currentCall.classList.toggle("empty", !who);
  dom.currentCall.classList.toggle("live", Boolean(active));
  dom.abortBtn.hidden = !active;
  if (dom.liveDot) dom.liveDot.hidden = !active;

  dom.currentWho.replaceChildren();
  if (!who) {
    dom.currentWho.textContent = "Noch kein Aufruf";
  } else {
    dom.currentWho.append(document.createTextNode(who));
    if (room) {
      dom.currentWho.append(
        document.createTextNode("  –  "),
        el("span", { class: "room", text: `Raum: ${room}` })
      );
    }
  }
  dom.currentPhase.textContent = phase || "";
}

const PHASE_TEXT = {
  db: "wird vorbereitet…",
  display: "Anzeige aktualisiert…",
  tts: "Ansage wird erzeugt…",
  audio: "Ansage läuft…",
  done: "fertig",
};

// ----------------------------------------------------------------- Aktionen

async function callPatient(id, roomId) {
  state.busy.add(id);
  render();
  try {
    await api(`/api/patients/${id}/call`, { method: "POST", body: { roomId } });
    state.lastRoomId = roomId;
    localStorage.setItem("pa.lastRoomId", roomId);
  } catch (err) {
    state.busy.delete(id);
    render();
    toast(err.message, "error");
  }
}

async function recallPatient(id) {
  state.busy.add(id);
  render();
  try {
    await api(`/api/patients/${id}/recall`, { method: "POST", body: {} });
  } catch (err) {
    state.busy.delete(id);
    render();
    toast(err.message, "error");
  }
}

async function setStatus(id, status, roomId) {
  try {
    await api(`/api/patients/${id}/status`, { method: "PATCH", body: roomId ? { status, roomId } : { status } });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function removePatient(id, name) {
  const ok = await confirmDialog(`Der Eintrag „${name}“ wird aus der heutigen Liste entfernt.`, {
    title: "Patient löschen",
    confirmText: "Löschen",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/patients/${id}`, { method: "DELETE" });
    toast("Patient gelöscht.");
  } catch (err) {
    toast(err.message, "error");
  }
}

/** Weitere Aktionen zu einem Patienten. */
async function patientMenu(patient) {
  const id = idOf(patient);
  const aktionen = [];

  if (patient.status !== "waiting") aktionen.push({ value: "waiting", label: "Zurück in die Warteliste" });
  // Ohne Ansage in Behandlung setzen – etwa wenn der Patient persönlich
  // abgeholt wurde. Es zählt der zuletzt gewählte Raum.
  if (patient.status !== "in_treatment") {
    const raum = roomById(state.lastRoomId);
    aktionen.push({
      value: "in_treatment",
      label: raum ? `In Behandlung setzen (${raum.label}, ohne Ansage)` : "In Behandlung setzen (ohne Ansage)",
    });
  }
  if (patient.status !== "completed") aktionen.push({ value: "completed", label: "Als fertig markieren" });
  if (patient.status !== "no_show") aktionen.push({ value: "no_show", label: "Abgesagt / nicht erschienen" });
  aktionen.push({ value: "delete", label: "Aus der Liste löschen" });

  const werte = await formDialog({
    title: `${patient.lastName}${patient.firstName ? `, ${patient.firstName}` : ""}`,
    submitText: "Ausführen",
    fields: [{ name: "aktion", label: "Aktion", type: "select", options: aktionen }],
  });
  if (!werte) return;

  if (werte.aktion === "delete") removePatient(id, patient.lastName);
  else if (werte.aktion === "in_treatment") setStatus(id, "in_treatment", state.lastRoomId || undefined);
  else setStatus(id, werte.aktion);
}

// ----------------------------------------------------------- Freie Durchsage

function updateAnnounceState() {
  const text = dom.announceText.value.trim();
  dom.announceCount.textContent = `${dom.announceText.value.length} / 300`;
  dom.announceBtn.disabled = text.length === 0;
  dom.previewBtn.disabled = text.length === 0;
}

async function loadPresets() {
  // Vorlagen aus der Konfiguration plus die zuletzt tatsächlich gesprochenen
  // Durchsagen – zusammen deckt das den Praxisalltag ab.
  const [presets, history] = await Promise.all([
    api("/api/announce/presets").catch(() => []),
    api("/api/announce/history").catch(() => []),
  ]);

  const texte = [];
  for (const entry of history) {
    if (entry.text && !texte.includes(entry.text)) texte.push(entry.text);
  }
  for (const text of presets) {
    if (!texte.includes(text)) texte.push(text);
  }

  dom.presets.replaceChildren();
  for (const text of texte.slice(0, 8)) {
    dom.presets.appendChild(el("button", {
      type: "button",
      text: text.length > 52 ? `${text.slice(0, 50)}…` : text,
      title: text,
      onclick: () => {
        dom.announceText.value = text;
        updateAnnounceState();
        dom.announceText.focus();
      },
    }));
  }
}

dom.announceText.addEventListener("input", updateAnnounceState);

dom.announceText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    dom.announceBtn.click();
  }
});

dom.previewBtn.addEventListener("click", async () => {
  const text = dom.announceText.value.trim();
  if (!text) return;

  dom.previewBtn.disabled = true;
  dom.previewBtn.textContent = "wird erzeugt…";
  try {
    const result = await api("/api/announce/preview", { method: "POST", body: { text } });
    dom.announcePlayer.src = result.url;
    dom.announcePlayer.hidden = false;
    dom.announcePlayer.play().catch(() => {});
    dom.announceHint.textContent =
      `Probe: ${Math.round(result.durationMs / 100) / 10} s · Stimme ${result.voice}` +
      `${result.cached ? " · aus dem Zwischenspeicher" : ""}. Im Wartezimmer war das noch nicht zu hören.`;
  } catch (err) {
    toast(err.message, "error", 8000);
  } finally {
    dom.previewBtn.textContent = "Vorhören";
    updateAnnounceState();
  }
});

dom.announceBtn.addEventListener("click", async () => {
  const text = dom.announceText.value.trim();
  if (!text) return;

  dom.announceBtn.disabled = true;
  dom.announceBtn.textContent = "wird gesendet…";
  try {
    await api("/api/announce", {
      method: "POST",
      body: {
        text,
        gong: dom.optGong.checked,
        showOnDisplay: dom.optDisplay.checked,
        repeats: Number(dom.optRepeats.value) || 1,
      },
    });
    toast("Durchsage läuft.", "ok");
    dom.announcePlayer.hidden = true;
    loadPresets();
  } catch (err) {
    toast(err.message, "error", 8000);
  } finally {
    dom.announceBtn.textContent = "Durchsagen";
    updateAnnounceState();
  }
});

document.getElementById("clearTextBtn").addEventListener("click", () => {
  dom.announceText.value = "";
  dom.announcePlayer.hidden = true;
  dom.announceHint.textContent = "Wird mit der Praxisstimme gesprochen und über die Wartezimmer-Lautsprecher ausgegeben.";
  updateAnnounceState();
  dom.announceText.focus();
});

// --------------------------------------------------------------- Bedienung

dom.search.addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});

dom.abortBtn.addEventListener("click", async () => {
  try {
    await api("/api/queue/abort", { method: "POST" });
    state.busy.clear();
    render();
    toast("Ansage abgebrochen.");
  } catch (err) {
    toast(err.message, "error");
  }
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  const ok = await confirmDialog(
    "Alle aufgerufenen Patienten wandern zurück in die Warteliste, die Raumzuordnung wird aufgehoben.",
    { title: "Aufgerufene zurücksetzen", confirmText: "Zurücksetzen" }
  );
  if (!ok) return;
  try {
    const result = await api("/api/patients/reset", { method: "POST" });
    toast(`${result.reset} Patienten zurückgesetzt.`, "ok");
  } catch (err) {
    toast(err.message, "error");
  }
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  const ok = await confirmDialog(
    "Die komplette Patientenliste des heutigen Tages wird gelöscht. Das lässt sich nicht rückgängig machen.",
    { title: "Tag beenden", confirmText: "Liste löschen", danger: true }
  );
  if (!ok) return;
  try {
    const result = await api("/api/patients", { method: "DELETE", body: { confirm: true } });
    toast(`${result.deleted} Einträge gelöscht.`, "ok");
  } catch (err) {
    toast(err.message, "error");
  }
});

document.getElementById("addBtn").addEventListener("click", async () => {
  const values = await formDialog({
    title: "Patient hinzufügen",
    submitText: "Hinzufügen",
    fields: [
      { name: "lastName", label: "Nachname", required: true, placeholder: "Mustermann" },
      { name: "firstName", label: "Vorname (optional)", placeholder: "Max" },
      {
        name: "gender",
        label: "Anrede",
        type: "select",
        options: [
          { value: "female", label: "Frau" },
          { value: "male", label: "Herr" },
          { value: "other", label: "ohne Anrede" },
        ],
      },
      { name: "appointmentAt", label: "Terminzeit (optional)", type: "time" },
    ],
  });
  if (!values || !values.lastName) return;

  const body = { lastName: values.lastName, firstName: values.firstName, gender: values.gender };
  if (values.appointmentAt) {
    const [hours, minutes] = values.appointmentAt.split(":");
    const when = new Date();
    when.setHours(Number(hours), Number(minutes), 0, 0);
    body.appointmentAt = when.toISOString();
  }

  try {
    await api("/api/patients", { method: "POST", body });
    toast(`${values.lastName} hinzugefügt.`, "ok");
  } catch (err) {
    toast(err.message, "error");
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
});

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea, select")) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  if (event.key === "/") {
    event.preventDefault();
    dom.search.focus();
  } else if (event.key === "Escape" && !dom.abortBtn.hidden) {
    dom.abortBtn.click();
  }
});

// --------------------------------------------------------------- Echtzeit

function connect() {
  const socket = connectStaffSocket();
  if (!socket) return;

  const setConn = (state, text) => {
    dom.healthDot.dataset.state = state;
    dom.healthDot.title = text;
    if (dom.connState) dom.connState.textContent = text;
  };

  socket.on("connect", () => setConn("on", "Mit dem Server verbunden"));
  socket.on("disconnect", () => setConn("off", "Verbindung zum Server unterbrochen"));

  socket.on("patients:updated", (list) => {
    state.patients = list;
    render();
  });

  socket.on("call:new", (payload) => {
    const who = payload.call?.headline || payload.patient?.lastName || "";
    showCurrent({ who, room: payload.room?.label, phase: "", active: true });
    dom.healthDot.dataset.state = "busy";
  });

  socket.on("announcement:new", (payload) => {
    if (payload.text) showCurrent({ who: `„${payload.text}“`, phase: "", active: true });
  });

  socket.on("call:phase", (payload) => {
    // Freie Durchsagen melden sich mit announcementId statt patientId.
    if (payload.announcementId && payload.text && payload.phase !== "done") {
      showCurrent({ who: `„${payload.text}“`, phase: PHASE_TEXT[payload.phase] || "", active: true });
      dom.healthDot.dataset.state = "busy";
      return;
    }

    if (payload.phase === "done") {
      if (payload.patientId) state.busy.delete(String(payload.patientId));
      render();
      dom.healthDot.dataset.state = "on";
      dom.currentPhase.textContent = "";
      dom.currentCall.classList.remove("live");
      dom.abortBtn.hidden = true;
    } else {
      dom.currentPhase.textContent = PHASE_TEXT[payload.phase] || payload.phase;
    }
  });

  socket.on("call:warning", (payload) => toast(payload.message, "warn", 7000));

  socket.on("queue:state", (queueState) => {
    if (!queueState.running && queueState.queued === 0) {
      state.busy.clear();
      render();
    }
  });

  socket.on("import:progress", (payload) => {
    if (payload.phase === "prewarm-done" && !payload.skipped) {
      toast(`Ansagen vorproduziert: ${payload.generated || 0} neu.`, "ok");
    }
  });
}

// ------------------------------------------------------------------- Start

(async function boot() {
  try {
    const [config, patients, queue, lastCall] = await Promise.all([
      api("/api/config"),
      api("/api/patients"),
      api("/api/queue").catch(() => null),
      // Maßgeblich für „Aktueller Aufruf" ist die zuletzt ANGESAGTE Person –
      // nicht die zuletzt geänderte. Beide unterscheiden sich, sobald jemand
      // ohne Ansage in Behandlung gesetzt wird.
      api("/api/display/last").catch(() => null),
    ]);

    state.rooms = config.practice.rooms;
    state.patients = patients;

    if (!state.rooms.some((r) => r.id === state.lastRoomId)) state.lastRoomId = "";

    document.title = `Übersicht – ${config.practice.name}`;

    // Zuletzt angesagten Patienten in der Kopfzeile anzeigen.
    if (lastCall && lastCall.headline) {
      showCurrent({ who: lastCall.headline, room: lastCall.room, active: false });
    }
    if (queue && queue.running) {
      dom.abortBtn.hidden = false;
    }

    render();
    updateAnnounceState();
    loadPresets();
    connect();
  } catch (err) {
    toast(`Start fehlgeschlagen: ${err.message}`, "error", 10000);
  }
})();

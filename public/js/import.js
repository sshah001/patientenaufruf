/* Import: Vorschau anzeigen, dann übernehmen. */
"use strict";

const { api, toast, timeOf, el, connectStaffSocket } = window.PA;

const dom = {
  drop: document.getElementById("drop"),
  file: document.getElementById("file"),
  todayOnly: document.getElementById("todayOnly"),
  step1: document.getElementById("step1"),
  step2: document.getElementById("step2"),
  step3: document.getElementById("step3"),
  kpis: document.getElementById("kpis"),
  mapping: document.getElementById("mapping"),
  sample: document.getElementById("sample"),
  issues: document.getElementById("issues"),
  issuesWrap: document.getElementById("issuesWrap"),
  issueCount: document.getElementById("issueCount"),
  applyBtn: document.getElementById("applyBtn"),
  result: document.getElementById("result"),
  prewarm: document.getElementById("prewarm"),
  prewarmBar: document.getElementById("prewarmBar"),
  prewarmText: document.getElementById("prewarmText"),
};

let preview = null;

/** Deutsche Bezeichnung der Zielfelder für die Zuordnungsanzeige. */
const FIELD_LABEL = {
  lastName: "Nachname",
  firstName: "Vorname",
  gender: "Anrede/Geschlecht",
  startDateTime: "Termin (Datum+Zeit)",
  startDate: "Termindatum",
  startTime: "Terminzeit",
  externalId: "Termin-Kennung",
  agendaId: "Kalender",
  practitioner: "Behandler",
  visitMotive: "Terminart",
  note: "Notiz",
};

// ------------------------------------------------------------- Dateiwahl

dom.drop.addEventListener("click", () => dom.file.click());
dom.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dom.file.click(); }
});
dom.file.addEventListener("change", () => {
  if (dom.file.files[0]) upload(dom.file.files[0]);
});

for (const type of ["dragenter", "dragover"]) {
  dom.drop.addEventListener(type, (e) => { e.preventDefault(); dom.drop.classList.add("over"); });
}
for (const type of ["dragleave", "drop"]) {
  dom.drop.addEventListener(type, (e) => { e.preventDefault(); dom.drop.classList.remove("over"); });
}
dom.drop.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) upload(file);
});

// -------------------------------------------------------------- Vorschau

async function upload(file) {
  const form = new FormData();
  form.append("file", file);
  form.append("todayOnly", dom.todayOnly.checked ? "true" : "false");

  dom.drop.querySelector(".big").textContent = "Datei wird gelesen…";

  try {
    preview = await api("/api/import/preview", { method: "POST", body: form });
    showPreview(preview);
  } catch (err) {
    toast(err.message, "error", 9000);
  } finally {
    dom.drop.querySelector(".big").textContent = "Datei hierher ziehen oder klicken";
    dom.file.value = "";
  }
}

function kpi(number, text, kind = "") {
  return el("div", { class: `kpi ${kind}` }, [
    el("div", { class: "n", text: String(number) }),
    el("div", { class: "t", text }),
  ]);
}

function showPreview(data) {
  const s = data.stats;

  dom.kpis.replaceChildren(
    kpi(s.accepted, "Termine erkannt", s.accepted > 0 ? "good" : "bad"),
    kpi(s.willInsert, "davon neu"),
    kpi(s.willUpdate, "werden aktualisiert"),
    kpi(s.obsoleteWaiting, "nicht mehr in der Datei", s.obsoleteWaiting > 0 ? "warn" : "")
  );

  // Feldzuordnung
  dom.mapping.replaceChildren();
  const shown = ["lastName", "firstName", "gender", "startDateTime", "startDate", "startTime", "practitioner", "visitMotive", "externalId"];
  for (const field of shown) {
    const source = data.mapping[field];
    const required = field === "lastName";
    if (!source && !required) continue;
    dom.mapping.appendChild(el("div", { class: `maprow ${source ? "" : "missing"}` }, [
      el("span", { text: FIELD_LABEL[field] || field }),
      el("span", { class: "to", text: source || "nicht gefunden" }),
    ]));
  }

  // Stichprobe
  dom.sample.replaceChildren();
  for (const p of data.sample) {
    dom.sample.appendChild(el("tr", {}, [
      el("td", { class: "mono", text: timeOf(p.appointmentAt) || "–" }),
      el("td", { text: `${p.lastName}${p.firstName ? `, ${p.firstName}` : ""}` }),
      el("td", { text: p.gender === "male" ? "Herr" : p.gender === "female" ? "Frau" : "–" }),
      el("td", { class: "muted", text: p.practitioner || "–" }),
    ]));
  }

  // Hinweise
  dom.issues.replaceChildren();
  if (data.issues.length) {
    dom.issuesWrap.hidden = false;
    dom.issueCount.textContent = `${data.issueCount}`;
    for (const issue of data.issues.slice(0, 60)) {
      dom.issues.appendChild(el("li", {
        class: issue.level,
        text: issue.line ? `Zeile ${issue.line}: ${issue.message}` : issue.message,
      }));
    }
    if (data.issueCount > 60) {
      dom.issues.appendChild(el("li", { class: "muted", text: `… und ${data.issueCount - 60} weitere.` }));
    }
  } else {
    dom.issuesWrap.hidden = true;
  }

  dom.applyBtn.disabled = s.accepted === 0;
  dom.step2.dataset.show = "1";
  dom.step3.dataset.show = "0";
  dom.step2.scrollIntoView({ behavior: "smooth", block: "start" });
}

// -------------------------------------------------------------- Übernahme

dom.applyBtn.addEventListener("click", async () => {
  if (!preview) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;

  dom.applyBtn.disabled = true;
  dom.applyBtn.textContent = "Wird übernommen…";

  try {
    const result = await api("/api/import/apply", {
      method: "POST",
      body: { batch: preview.batch, mode, removeObsolete: mode === "replace" },
    });

    dom.result.replaceChildren(
      el("div", { class: "notice ok", text:
        `${result.inserted} neu angelegt, ${result.updated} aktualisiert, ` +
        `${result.removed} entfernt, ${result.skippedActive} laufende übersprungen.` }),
    );

    dom.prewarm.hidden = !result.prewarming;
    dom.step2.dataset.show = "0";
    dom.step3.dataset.show = "1";
    dom.step3.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Import erfolgreich.", "ok");
  } catch (err) {
    if (err.code === "PREVIEW_EXPIRED") {
      toast(err.message, "warn", 8000);
      dom.step2.dataset.show = "0";
    } else {
      toast(err.message, "error", 9000);
    }
  } finally {
    dom.applyBtn.disabled = false;
    dom.applyBtn.textContent = "Import durchführen";
  }
});

document.getElementById("cancelBtn").addEventListener("click", () => {
  preview = null;
  dom.step2.dataset.show = "0";
});

document.getElementById("againBtn").addEventListener("click", () => {
  preview = null;
  dom.step3.dataset.show = "0";
  dom.step1.scrollIntoView({ behavior: "smooth" });
});

// ---------------------------------------------- Fortschritt der Vorproduktion

const socket = connectStaffSocket();
if (socket) {
  socket.on("import:progress", (payload) => {
    if (payload.phase === "prewarm") {
      const percent = Math.round((payload.done / Math.max(1, payload.total)) * 100);
      dom.prewarmBar.style.width = `${percent}%`;
      dom.prewarmText.textContent = `${payload.done} / ${payload.total}`;
    } else if (payload.phase === "prewarm-done") {
      dom.prewarmBar.style.width = "100%";
      dom.prewarmText.textContent = payload.skipped
        ? "übersprungen"
        : `${payload.generated} neu erzeugt (${Math.round((payload.ms || 0) / 1000)} s)`;
      toast("Ansagen sind vorproduziert.", "ok");
    }
  });
}

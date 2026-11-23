/* Anmeldung per PIN. */
"use strict";

const { api } = window.PA;

const form = document.getElementById("form");
const pin = document.getElementById("pin");
const submit = document.getElementById("submit");
const error = document.getElementById("error");

const next = new URLSearchParams(location.search).get("next") || "/";

/** Nur auf eigene Pfade weiterleiten – nie auf eine fremde Adresse. */
function safeNext() {
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function showError(message) {
  error.textContent = message;
  error.dataset.show = "1";
  pin.select();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.dataset.show = "0";
  submit.disabled = true;
  submit.textContent = "Wird geprüft…";

  try {
    await api("/api/auth/login", { method: "POST", body: { pin: pin.value } });
    location.href = safeNext();
  } catch (err) {
    showError(err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = "Anmelden";
  }
});

// Bereits angemeldet? Dann direkt weiter.
api("/api/auth/me")
  .then((me) => {
    if (me.authenticated) location.href = safeNext();
  })
  .catch(() => {});

/* Gemeinsame Hilfsfunktionen aller Bedienseiten.
 *
 * Alles steckt in einer Funktion, damit im globalen Namensraum nur `window.PA`
 * entsteht. Die Seiten-Skripte holen sich daraus per Destrukturierung, was sie
 * brauchen – ohne dass sich Bezeichner überschneiden.
 */
(function () {
  "use strict";

  /** Fetch mit einheitlicher Fehlerbehandlung; wirft bei Fehlern eine Meldung. */
  async function api(path, options = {}) {
    const opts = { credentials: "same-origin", ...options };

    const hasJsonBody =
      opts.body &&
      typeof opts.body === "object" &&
      !(opts.body instanceof FormData) &&
      !(opts.body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(opts.body) &&
      !(opts.body instanceof Blob);

    if (hasJsonBody) {
      opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }

    const response = await fetch(path, opts);

    if (response.status === 401) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      throw new Error("Nicht angemeldet.");
    }

    const isJson = (response.headers.get("content-type") || "").includes("json");
    const data = isJson ? await response.json().catch(() => null) : await response.text();

    if (!response.ok) {
      const error = new Error((data && data.error) || `Fehler ${response.status}`);
      error.code = data && data.code;
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  /** Kurzmeldung unten rechts. */
  function toast(message, kind = "", ms = 4000) {
    let host = document.getElementById("toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "toasts";
      document.body.appendChild(host);
    }
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    host.appendChild(node);

    setTimeout(() => {
      node.style.opacity = "0";
      node.style.transition = "opacity .2s";
      setTimeout(() => node.remove(), 220);
    }, ms);
  }

  /** Uhrzeit "14:05"; leerer String, wenn kein Datum vorliegt. */
  function timeOf(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }

  /** "vor 3 Min." */
  function agoOf(value) {
    if (!value) return "";
    const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 45) return "gerade eben";
    if (seconds < 3600) return `vor ${Math.round(seconds / 60)} Min.`;
    if (seconds < 86400) return `vor ${Math.round(seconds / 3600)} Std.`;
    return new Date(value).toLocaleDateString("de-DE");
  }

  const STATUS_LABEL = {
    waiting: "Wartet",
    called: "Aufgerufen",
    in_treatment: "In Behandlung",
    completed: "Fertig",
    no_show: "Nicht erschienen",
  };

  /**
   * Element bauen. Text wird immer über textContent gesetzt – Patientennamen
   * landen so nie als HTML im Dokument.
   */
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  /**
   * Erzeugt ein Symbol aus dem Vorrat oben im Dokument.
   * Immer aria-hidden: Neben jedem Symbol steht sichtbarer Text, sonst wäre
   * die Bedeutung für Screenreader-Nutzer verloren.
   */
  function icon(name, extraClass = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `icon ${extraClass}`.trim());
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /**
   * Schaltfläche mit Symbol und Text.
   *
   * Der zugängliche Name wird ausdrücklich gesetzt und beginnt IMMER mit dem
   * sichtbaren Text. Das ist nicht kosmetisch: Ohne aria-label gewinnt in
   * Chrome das title-Attribut, und dann hieße die Schaltfläche für einen
   * Screenreader "Ansage abspielen…" statt "Aufrufen". Wer sie per
   * Sprachsteuerung mit dem gelesenen Wort anspricht, träfe sie nicht mehr
   * (WCAG 2.5.3 "Beschriftung im Namen"). Das title-Attribut bleibt reiner
   * Mauszeiger-Hinweis.
   *
   * @param {{icon?:string, text?:string, label?:string, class?:string,
   *          title?:string, disabled?:boolean, onclick?:Function}} spec
   */
  function iconButton(spec) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = spec.class || "";
    if (spec.title) button.title = spec.title;
    if (spec.disabled) button.disabled = true;
    if (spec.onclick) button.addEventListener("click", spec.onclick);

    if (spec.icon) button.appendChild(icon(spec.icon));

    if (spec.text) {
      button.appendChild(document.createTextNode(spec.text));
      button.setAttribute("aria-label", spec.label ? `${spec.text} – ${spec.label}` : spec.text);
    } else {
      // Reine Symbolschaltfläche braucht zwingend eine Beschriftung.
      button.classList.add("icon-only");
      button.setAttribute("aria-label", spec.label || spec.title || "Schaltfläche");
    }
    return button;
  }

  /** Markiert den aktiven Navigationspunkt. */
  function markNav() {
    for (const link of document.querySelectorAll(".topbar nav a")) {
      if (link.getAttribute("href") === window.location.pathname) {
        link.setAttribute("aria-current", "page");
      }
    }
  }
  document.addEventListener("DOMContentLoaded", markNav);

  /**
   * Rückfrage als eigenes Fenster statt window.confirm().
   *
   * Native Dialoge halten den kompletten Browser-Tab an – auf einem
   * Praxisrechner mit mehreren offenen Anzeigen ist das unangenehm, und die
   * Gestaltung passt nicht zum Rest. Dieses Fenster verhält sich wie erwartet
   * (Esc schließt, Enter bestätigt) und liefert ein Promise.
   */
  function confirmDialog(message, options = {}) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "modal";

      const title = document.createElement("h2");
      title.textContent = options.title || "Bitte bestätigen";

      const text = document.createElement("p");
      text.textContent = message;

      const row = document.createElement("div");
      row.className = "row";
      row.style.justifyContent = "flex-end";
      row.style.marginTop = "20px";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ghost";
      cancel.textContent = options.cancelText || "Abbrechen";

      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = options.danger ? "danger" : "primary";
      ok.textContent = options.confirmText || "Ja, fortfahren";

      row.append(cancel, ok);
      dialog.append(title, text, row);
      document.body.appendChild(dialog);

      const finish = (value) => {
        dialog.close();
        dialog.remove();
        resolve(value);
      };

      cancel.addEventListener("click", () => finish(false));
      ok.addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(false);
      });

      dialog.showModal();
      ok.focus();
    });
  }

  /**
   * Formular als eigenes Fenster statt mehrerer window.prompt()-Aufrufe.
   * @param {{title:string, fields:Array, submitText?:string}} spec
   * @returns {Promise<object|null>}
   */
  function formDialog(spec) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "modal";

      const form = document.createElement("form");
      form.method = "dialog";

      const title = document.createElement("h2");
      title.textContent = spec.title;
      form.appendChild(title);

      const inputs = {};
      for (const field of spec.fields) {
        const wrap = document.createElement("div");
        wrap.className = "field";

        const label = document.createElement("label");
        label.textContent = field.label;
        label.htmlFor = `f_${field.name}`;
        wrap.appendChild(label);

        let input;
        if (field.type === "select") {
          input = document.createElement("select");
          for (const option of field.options) {
            const node = document.createElement("option");
            node.value = option.value;
            node.textContent = option.label;
            input.appendChild(node);
          }
        } else {
          input = document.createElement("input");
          input.type = field.type || "text";
          if (field.placeholder) input.placeholder = field.placeholder;
          if (field.required) input.required = true;
        }
        input.id = `f_${field.name}`;
        input.name = field.name;
        if (field.value !== undefined) input.value = field.value;

        wrap.appendChild(input);
        form.appendChild(wrap);
        inputs[field.name] = input;
      }

      const row = document.createElement("div");
      row.className = "row";
      row.style.justifyContent = "flex-end";
      row.style.marginTop = "18px";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ghost";
      cancel.textContent = "Abbrechen";

      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "primary";
      submit.textContent = spec.submitText || "Speichern";

      row.append(cancel, submit);
      form.appendChild(row);
      dialog.appendChild(form);
      document.body.appendChild(dialog);

      const finish = (value) => {
        dialog.close();
        dialog.remove();
        resolve(value);
      };

      cancel.addEventListener("click", () => finish(null));
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(null);
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const values = {};
        for (const [name, input] of Object.entries(inputs)) values[name] = input.value.trim();
        finish(values);
      });

      dialog.showModal();
      const first = Object.values(inputs)[0];
      if (first) first.focus();
    });
  }

  /** Socket.IO-Verbindung als Bedienplatz. */
  function connectStaffSocket() {
    if (typeof io === "undefined") return null;
    const socket = io({ auth: { role: "staff" }, transports: ["websocket", "polling"] });
    socket.on("connect_error", (err) => {
      if (String(err.message).includes("angemeldet")) window.location.href = "/login";
    });
    return socket;
  }

  window.PA = {
    api, toast, timeOf, agoOf, STATUS_LABEL, el,
    icon, iconButton,
    connectStaffSocket, confirmDialog, formDialog,
  };
})();

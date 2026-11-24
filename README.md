# Patientenaufruf

Digitales Patientenaufrufsystem für die Arztpraxis.

Die Tagesliste kommt als Doctolib-Export herein, ein Knopfdruck ruft den
nächsten Patienten auf: **die Ansage wird mit der eigenen Stimme der Praxis
gesprochen** und über Mopidy/Snapcast im Wartezimmer ausgegeben, gleichzeitig
erscheint der Aufruf auf dem Wartezimmer-Fernseher.

Alles läuft lokal. Kein Patientenname verlässt die Praxis.

```
Doctolib-Export ──► Import mit Vorschau ──► Aufrufliste
                                                │
                                    ein Knopfdruck
                                                │
                   ┌────────────────────────────┼────────────────────────────┐
                   ▼                            ▼                            ▼
          Wartezimmer-TV                 Sprachansage                 Protokoll
       (Popup + Laufband)         (eigene Stimme, Snapcast)       (DSGVO-Frist)
```

---

## Schnellstart zum Ausprobieren

Ohne Mopidy und ohne piSignage – nur um die Oberfläche zu sehen:

```bash
npm install
cp .env.example .env
```

In der `.env` mindestens setzen:

```
USE_MEMORY_DB=true
APP_PUBLIC_URL=http://localhost:3300
SESSION_SECRET=<32+ zufällige Zeichen>
APP_PIN=1234
DISPLAY_TOKEN=test
MOPIDY_ENABLED=false
SIGNAGE_ENABLED=false
```

```bash
npm run check-config    # prüft alles vor dem Start
npm start
```

| Seite | Adresse | Zweck |
|---|---|---|
| Aufruf | <http://localhost:3300/> | Tagesliste, Patienten aufrufen |
| Import | <http://localhost:3300/import> | Doctolib-Datei einlesen |
| Stimme | <http://localhost:3300/voice-studio> | eigene Praxisstimme aufnehmen |
| System | <http://localhost:3300/system> | Selbsttest, Stimmen, Protokoll |
| TV | <http://localhost:3300/tv?token=test> | Wartezimmer-Fernseher |
| Monitor | <http://localhost:3300/monitor?token=test> | Übersichtstafel je Raum |
| Wetter | <http://localhost:3300/wetter> | 5-Tage-Vorhersage für den TV (auch unter `/pi-wetter`) |

Die Daten (Tagesliste, Aufrufprotokoll) liegen in einer SQLite-Datei unter
`data/patientenaufruf.db` – ein eigener Datenbankserver ist nicht nötig.
Voraussetzung ist Node.js 22.13 oder neuer.

Für den Produktivbetrieb: **[docs/BETRIEB.md](docs/BETRIEB.md)**.

Auf einem Raspberry Pi 4 oder 5: **[docs/RASPBERRY-PI.md](docs/RASPBERRY-PI.md)**.

---

## Was das System kann

### Import mit Vorschau

Doctolib-Exporte unterscheiden sich je nach Praxis und Version in ihren
Spaltennamen. Der Import sucht deshalb nach bekannten Bezeichnern – flach
(`patient_last_name`), verschachtelt (`patient.last_name`) und auf Deutsch
(`Nachname`) – und **zeigt vor dem Schreiben, was er verstanden hat**:
erkannte Feldzuordnung, Trefferzahl, eine Stichprobe und alle Auffälligkeiten.

Erst danach wird geschrieben, wahlweise:

- **Abgleichen** (Standard): bekannte Termine aktualisieren, neue ergänzen.
  Bereits aufgerufene oder laufende Behandlungen bleiben unberührt.
- **Ersetzen**: zusätzlich wartende Patienten entfernen, die nicht mehr in der
  Datei stehen. Aufgerufene und erledigte bleiben erhalten.

Unterstützt werden JSON (Array oder verpackt in `data`, `appointments`, …) und
CSV (Semikolon, Komma oder Tabulator, mit oder ohne BOM). Datumsformate:
ISO-8601, `TT.MM.JJJJ`, `TT/MM/JJJJ`, `JJJJ-MM-TT`, Unix-Zeitstempel.

### Aufruf per Knopfdruck

Die Startseite zeigt oben den aktuellen Aufruf, darunter links alle wartenden
Patienten und rechts die freie Durchsage und die laufenden Behandlungen. In jeder Zeile wird der Raum direkt
gewählt und aufgerufen – eine Person am Tresen kann so ohne Umschalten auf
verschiedene Zimmer verteilen. Die Raumwahl gilt nur für die eine Zeile und
bleibt erhalten, auch wenn sich die Liste aktualisiert.

- **Aufrufen** – Ansage über die Lautsprecher plus Anzeige auf dem Fernseher
- **Abgesagt** – Patient ist nicht erschienen
- **Beenden / Zurückrufen** – auf den Karten der laufenden Behandlungen

Tastatur: `/` springt in die Suche, `Esc` bricht eine laufende Ansage ab.

Die Aufrufe laufen durch eine **Warteschlange**: Zwei schnell hintereinander
gedrückte Knöpfe überlagern sich nicht mehr, sondern werden nacheinander
vollständig abgearbeitet.

### Freie Durchsage

Ein Textfeld auf der Startseite spricht beliebigen Text mit der Praxisstimme
über die Wartezimmer-Lautsprecher – „Die Praxis schließt in zehn Minuten."
Wahlweise mit Gong, mehrfach wiederholt und zusätzlich als Einblendung auf dem
Fernseher. Vorlagen und die zuletzt gesprochenen Durchsagen stehen als
Schaltflächen bereit; **Vorhören** spielt die Ansage nur am Arbeitsplatz ab.

### Barrierefrei bedienbar

Alle Text- und Farbkombinationen erfüllen WCAG AA (mindestens 4,5:1),
Statusinformationen stehen nie nur als Farbe da, jede Schaltfläche trägt einen
Namen, der mit ihrer sichtbaren Beschriftung beginnt, neue Aufrufe werden über
`aria-live` vorgelesen, und die Seite ist vollständig mit der Tastatur
bedienbar – einschließlich Sprungmarke zum Inhalt.

### Ansagen ohne Wartezeit

Nach dem Import werden im Hintergrund **alle Ansagen des Tages vorproduziert**
(jeder Patient × jeder Raum). Der Knopfdruck spielt dann eine fertige Datei ab,
statt erst zu synthetisieren – auch auf einem Raspberry Pi ohne spürbare
Verzögerung.

Der Zwischenspeicher ist nach Stimme, Klangparametern und Text gehasht: Wird
die Stimme gewechselt, entstehen automatisch neue Dateien.

### Eigene Praxisstimme

Unter `/voice-studio` sprichst du 170 vorgegebene Sätze ein – 60 davon sind
echte Praxisansagen, 50 häufige deutsche Nachnamen. Die Seite nimmt direkt im
richtigen Format auf (22,05 kHz, Mono, WAV), schneidet Stille weg, zeigt den
Pegel und exportiert den fertigen Datensatz im LJSpeech-Format als ZIP.

Daraus wird per Finetune ein Piper-Modell trainiert. Anleitung:
**[docs/STIMME-TRAINIEREN.md](docs/STIMME-TRAINIEREN.md)**.

### Wartezimmer-Anzeige

Die Seite `/tv` wird in piSignage als Link-Asset eingebunden und holt sich ihre
Aufrufe selbst per WebSocket:

- **Popup** beim Aufruf: Name und Raum groß, in der Farbe des Raums, mit
  ablaufendem Zeitbalken.
- **Dauerticker** unten mit den letzten Aufrufen.
- Im Ruhezustand: Begrüßung, Uhrzeit und die zuletzt Aufgerufenen.

Weil die Seite selbst am Server hängt, ist **kein API-Aufruf pro Patient** nötig.
Zusätzlich steht unter `/monitor` eine Übersichtstafel „welcher Patient in
welchem Raum" bereit.

### Diagnose statt Rätselraten

`/system` prüft auf Knopfdruck Konfiguration, Datenbank, Piper, Stimmmodell,
eine echte Probeansage, Mopidy und piSignage – und nennt zu jedem Fehler den
nächsten Schritt. Der Sprachtest geht wahlweise nur bis zur Datei oder den
kompletten Weg bis zum Lautsprecher.

---

## Aufbau

```
src/
  config/           Konfiguration: default.json < local.json < Umgebung
  db/models/        Patient, CallLog (mit automatischer Löschfrist)
  middleware/       Anmeldung (PIN), Anzeige-Token, Fehlerbehandlung
  realtime/         Socket.IO, getrennt nach Bedienung und Anzeige
  services/
    tts/            Piper-Anbindung, Stimmenverzeichnis, Zwischenspeicher
    audio/          Mopidy-Client, Gong
    signage/        piSignage-Client, Aufrufverlauf
    import/         Formaterkennung, Feldzuordnung, Abgleich
    callQueue.js    der eigentliche Aufruf-Ablauf
  controllers/      HTTP-Endpunkte
  routes/           alle Adressen an einer Stelle
public/             Oberfläche (reines HTML/CSS/JS, kein Build-Schritt)
config/             default.json (eingecheckt), local.json (praxiseigen)
voices/             Piper-Stimmmodelle, hier landet die eigene Stimme
tools/              prompts-de.txt, check-config.js
tests/              node --test
docs/               Betrieb, Stimm-Training
```

Bewusste Entscheidungen:

- **Kein Build-Schritt im Frontend.** Ein Praxisrechner soll das System nach
  einem `git pull` starten können, ohne Werkzeugkette.
- **Piper über stdin, nie über eine Shell.** Patientennamen aus dem Import
  können damit nicht als Befehl interpretiert werden.
- **Anzeigegeräte bekommen nur Aufrufe, nie die Patientenliste.**
- **Zwei getrennte Zugänge**: PIN für die Bedienung, Token für Anzeigen. Ein
  Fernseher kann sich nicht anmelden, braucht aber auch keinen Vollzugriff.

---

## Befehle

```bash
npm start            # Server starten
npm run dev          # mit automatischem Neustart bei Änderungen
npm test             # Tests (node --test, ohne Zusatzabhängigkeit)
npm run check-config # Konfiguration prüfen, ohne zu starten
```

---

## Konfiguration

Geheimnisse ausschließlich in `.env` (Vorlage: `.env.example`).
Praxisspezifisches in `config/local.json` – das überschreibt
`config/default.json` und bleibt bei Updates erhalten.

Die wichtigsten Werte:

| Variable | Bedeutung |
|---|---|
| `APP_PUBLIC_URL` | Im Netz erreichbare Adresse. Mopidy und der TV laden hierüber – **nicht** `localhost`. |
| `SECURITY_AUTH_ENABLED` | `false` (Standard): Bedienung ohne PIN; `true`: Anmeldung mit `APP_PIN` |
| `APP_PIN` | PIN für die Bedienoberfläche, nur bei `SECURITY_AUTH_ENABLED=true` |
| `SESSION_SECRET` | Signatur der Anmeldung, 32+ zufällige Zeichen |
| `DISPLAY_TOKEN` | Zugang für TV, Monitor und RSS |
| `PIPER_BIN` | Pfad zur Piper-Datei |
| `PIPER_VOICE` | Aktive Stimme, z. B. `de_DE-praxis-medium` |
| `MOPIDY_RPC_URL` | z. B. `http://192.168.130.196:6680/mopidy/rpc` |
| `SIGNAGE_HOST` | IP des piSignage-Players |

---

## Lizenz

MIT. Die mitgelieferten Piper-Stimmmodelle stehen unter ihren eigenen Lizenzen
(siehe die jeweilige `.onnx.json`).

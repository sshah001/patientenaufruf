# Die eigene Stimme als Praxisstimme

Ziel: Am Ende sagt das System die Patientenaufrufe **mit deiner Stimme** –
vollständig lokal, ohne dass ein Patientenname jemals die Praxis verlässt.

Der Weg besteht aus vier Schritten:

| Schritt | Wo | Aufwand |
|---|---|---|
| 1. Sätze einsprechen | `/voice-studio` im Browser | 45–75 Min. |
| 2. Datensatz herunterladen | ein Klick | 1 Min. |
| 3. Modell trainieren | Google Colab (kostenlose GPU) | 2–6 Std. Wartezeit |
| 4. Modell einbauen | Datei nach `voices/` kopieren | 5 Min. |

Schritt 3 läuft von allein – du startest ihn und kommst später wieder.

---

## Warum dieser Weg und nicht ein Klon-Dienst?

Es gibt Dienste, die aus 30 Sekunden Aufnahme eine Stimme klonen. Für eine
Arztpraxis sprechen zwei Dinge dagegen:

- **Datenschutz.** Für jede Ansage müsste der Nachname des Patienten an einen
  externen Server geschickt werden. Das ist eine Übermittlung von
  Gesundheitsdaten an einen Dritten und würde einen Auftragsverarbeitungsvertrag
  und eine Rechtsgrundlage brauchen.
- **Verfügbarkeit.** Fällt das Internet aus, fällt der Patientenaufruf aus.

Ein einmal trainiertes Piper-Modell läuft dagegen auf dem Praxisrechner selbst –
schnell genug sogar auf einem Raspberry Pi – und kostet nichts.

---

## Schritt 1: Sätze einsprechen

Öffne **`/voice-studio`**. Die Seite führt dich durch 170 Sätze:

- **Sätze 1–60** sind echte Praxisansagen. Sie prägen die Satzmelodie, die
  später jeden Tag zu hören ist – hier lohnt sich die meiste Sorgfalt.
- **Sätze 61–110** sind häufige deutsche Nachnamen. Der Nachname ist der
  einzige Teil, der sich bei jedem Aufruf ändert.
- **Sätze 111–170** sind allgemeine Sätze, die dem Modell die übrigen Laute
  beibringen.

### Aufnahmebedingungen

Die Aufnahmequalität entscheidet mehr über das Ergebnis als die Menge.

- **Raum:** ruhig, mit Teppich, Vorhängen oder Möbeln. Ein leerer,
  gefliester Raum klingt hallig, und der Hall bleibt für immer im Modell.
- **Lüftung, Klimaanlage, Kühlschrank aus.** Fenster zu.
- **Mikrofon:** Ein einfaches USB-Mikrofon oder ein Headset genügt. Wichtiger
  als der Preis ist der **gleichbleibende Abstand** – etwa eine Handbreit.
- **Nicht direkt in die Kapsel sprechen**, sondern leicht daran vorbei. Das
  vermeidet Plopplaute bei P und B.
- **Alles in einer Sitzung** und mit demselben Mikrofon. Wechselt Raum,
  Mikrofon oder Tagesform, klingt das Modell später uneinheitlich.

### Sprechen

- Normale Lautstärke, normales Tempo. Sprich so, wie du im Wartezimmer
  tatsächlich rufen würdest – nicht übertrieben deutlich, nicht "vorlesend".
- Der Pegelbalken soll **grün** bleiben. Rot heißt übersteuert (die Aufnahme
  ist dann unbrauchbar), Gelb heißt zu leise.
- Vor und nach dem Satz kurz Pause lassen, bevor du die Aufnahme beendest.
  Die Software schneidet die Stille selbst weg.
- **Leertaste** startet und beendet die Aufnahme; nach dem Speichern springt
  die Seite automatisch zum nächsten Satz.
- Versprecher: einfach **„Neu aufnehmen"** drücken. Ein Versprecher im
  Datensatz schadet mehr als ein fehlender Satz.

### Wie viel ist genug?

- **Ab ~20 Minuten** entsteht ein brauchbares Modell.
- **30–45 Minuten** klingen deutlich natürlicher.
- Mehr als eine Stunde bringt kaum noch Verbesserung.

Die Fortschrittsanzeige rechnet in Minuten, nicht in Sätzen – kurze Sätze
zählen entsprechend weniger.

> **Datenschutz:** Die Aufnahmen liegen unter `data/voice-dataset/` auf dem
> Server. Es sind deine eigenen Sätze, keine Patientendaten. Nach dem Training
> kannst du das Verzeichnis löschen – hebe es aber auf, falls du das Modell
> später mit mehr Material verbessern willst.

---

## Schritt 2: Datensatz herunterladen

Unten auf der Seite: **„Datensatz herunterladen (ZIP)"**.

Die ZIP-Datei hat genau den Aufbau, den Piper zum Trainieren erwartet
(LJSpeech-Format):

```
praxisstimme-datensatz-2026-09-11.zip
├── wav/
│   ├── 0001.wav          22.050 Hz, Mono, 16 Bit
│   ├── 0002.wav
│   └── …
├── metadata.csv          0001|Satztext|Satztext
└── LIESMICH.txt
```

---

## Schritt 3: Modell trainieren

Trainiert wird **nicht von Null**, sondern als *Finetune* auf einem
vorhandenen deutschen Modell. Das ist der Grund, weshalb 20 Minuten Material
genügen statt vieler Stunden: Die deutsche Aussprache kann das Ausgangsmodell
bereits, gelernt wird nur noch dein Stimmklang.

Als Ausgangspunkt eignet sich **`de_DE-thorsten-medium`** (männlich) oder
**`de_DE-kerstin-low`** (weiblich) – beide liegen bereits in `voices/`. Nimm
das Modell, das deiner Stimmlage näher kommt.

### Variante A: Google Colab (empfohlen, kostenlos)

Du brauchst ein Google-Konto. Die kostenlose GPU reicht aus.

1. **Colab öffnen:** <https://colab.research.google.com> → *Neues Notebook*
2. **GPU einschalten:** Menü *Laufzeit → Laufzeittyp ändern → GPU (T4)*
3. **Umgebung einrichten** – erste Zelle:

   ```python
   !git clone https://github.com/rhasspy/piper.git
   %cd piper/src/python
   !pip install -q -e .
   !pip install -q torchmetrics==0.11.4
   !bash build_monotonic_align.sh
   ```

4. **Datensatz hochladen:** Linke Seitenleiste → Ordnersymbol → ZIP
   hochladen, dann entpacken:

   ```python
   !unzip -q /content/praxisstimme-datensatz-*.zip -d /content/dataset
   !ls /content/dataset
   ```

5. **Ausgangsmodell (Checkpoint) laden.** Piper-Checkpoints liegen auf
   Hugging Face. Für Thorsten medium:

   ```python
   !wget -O /content/base.ckpt \
     "https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/de/de_DE/thorsten/medium/epoch%3D2864-step%3D1355600.ckpt"
   ```

   > Ändert sich der Dateiname, findest du den aktuellen unter
   > <https://huggingface.co/datasets/rhasspy/piper-checkpoints/tree/main/de/de_DE>.

6. **Datensatz aufbereiten:**

   ```python
   !python -m piper_train.preprocess \
     --language de \
     --input-dir /content/dataset \
     --output-dir /content/training \
     --dataset-format ljspeech \
     --single-speaker \
     --sample-rate 22050
   ```

7. **Training starten:**

   ```python
   !python -m piper_train \
     --dataset-dir /content/training \
     --accelerator gpu --devices 1 \
     --batch-size 12 \
     --validation-split 0.0 \
     --num-test-examples 0 \
     --max_epochs 4000 \
     --resume_from_checkpoint /content/base.ckpt \
     --checkpoint-epochs 200 \
     --precision 32
   ```

   Läuft ab jetzt allein. Nach etwa **2 Stunden** ist das Ergebnis meist
   ordentlich, nach 4–6 Stunden sehr gut. Colab trennt die Verbindung nach
   einiger Zeit – nicht schlimm: Schritt 7 lässt sich mit
   `--resume_from_checkpoint /content/training/lightning_logs/version_0/checkpoints/<neueste>.ckpt`
   fortsetzen.

8. **Modell exportieren:**

   ```python
   !ls /content/training/lightning_logs/version_0/checkpoints/
   !python -m piper_train.export_onnx \
     /content/training/lightning_logs/version_0/checkpoints/<neueste>.ckpt \
     /content/de_DE-praxis-medium.onnx
   !cp /content/training/config.json /content/de_DE-praxis-medium.onnx.json
   ```

9. **Beide Dateien herunterladen:**

   ```python
   from google.colab import files
   files.download('/content/de_DE-praxis-medium.onnx')
   files.download('/content/de_DE-praxis-medium.onnx.json')
   ```

### Variante B: eigener Rechner mit NVIDIA-GPU

Dieselben Befehle ohne Colab. Voraussetzung: Python 3.10, CUDA, mindestens
8 GB Grafikspeicher. Auf reiner CPU ist das Training nicht praktikabel – es
dauert Wochen statt Stunden.

---

## Schritt 4: Modell einbauen

1. Die beiden Dateien in den Ordner **`voices/`** legen:

   ```
   voices/de_DE-praxis-medium.onnx
   voices/de_DE-praxis-medium.onnx.json
   ```

   > Der Name muss `praxis`, `eigene` oder `custom` enthalten – daran erkennt
   > die Oberfläche die eigene Stimme und zeigt sie ganz oben an.

2. In der **`.env`** die Stimme aktivieren:

   ```
   PIPER_VOICE=de_DE-praxis-medium
   ```

3. Server neu starten.

4. Unter **`/system`** → *Sprachausgabe testen* → **„Über Lautsprecher ausgeben"**
   prüfen, ob alles zusammenspielt.

5. Den Zwischenspeicher leeren (ebenfalls unter `/system`), damit alte Ansagen
   mit der bisherigen Stimme verschwinden. Danach unter `/import` →
   **„Ansagen vorproduzieren"** die Tagesliste neu erzeugen lassen.

---

## Wenn das Ergebnis nicht gefällt

| Klangbild | Ursache | Abhilfe |
|---|---|---|
| Hallig, "im Badezimmer" | Raumakustik | In einem gedämpften Raum neu aufnehmen |
| Rauschen, Brummen | Mikrofon oder Lüfter | Mikrofon näher, Störquellen aus |
| Verzerrt, kratzig | Übersteuert (roter Pegel) | Leiser aufnehmen oder Abstand vergrößern |
| Roboterhaft, monoton | Zu wenig Material | Auf 40+ Minuten aufstocken, weitertrainieren |
| Nuschelt bei Namen | Zu wenige Namen im Datensatz | Teil B erweitern (weitere Nachnamen ergänzen) |
| Falsche Betonung einzelner Räume | Aussprache-Schreibweise | In `config/local.json` das Feld `spoken` anpassen, z. B. `"in das E K G Zimmer"` |
| Klingt insgesamt fremd | Ausgangsmodell passt nicht zur Stimmlage | Mit dem anderen Basismodell neu trainieren |

Die Aufnahmesätze selbst stehen in **`tools/prompts-de.txt`** und können vor
dem Aufnehmen ergänzt werden – zum Beispiel um Nachnamen, die in deinem
Patientenstamm häufig vorkommen. Das ist die wirksamste einzelne Verbesserung.

---

## Zwischenlösung ohne Training

Solange das Modell noch nicht fertig ist, läuft das System mit einer der
mitgelieferten Stimmen weiter. Unter `/system` lassen sich alle vorhandenen
Stimmen anhören und vergleichen; `de_DE-thorsten-medium` und
`de_DE-kerstin-low` sind die verständlichsten.

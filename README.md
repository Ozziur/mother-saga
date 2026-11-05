# Mother Saga

App Android per giocare la saga di **Mother** sul telefono, con una guida integrata senza spoiler. Si parte da **Mother 1** nella raccolta GBA *Mother 1+2*.

## Cosa fa

- **Installazione**: scegli la tua ROM di Mother 1+2. Quella già tradotta con la patch italiana del Team MOTHER (1.1.1) viene riconosciuta e installata subito; con la ROM giapponese originale puoi applicare una patch IPS, UPS o BPS o giocare così com'è. La ROM non lascia il telefono.
- **Emulatore**: core mGBA (libretro, WebAssembly senza thread), controlli touch con vibrazione, avanti veloce, turbo A, riavvolgimento, 4 slot di salvataggio rapido, ripresa automatica, esportazione e importazione del `.sav`.
- **Più partite**: ognuna con salvataggio, stati, progressi e note separati.
- **Guida a scomparsa** (Fase 1, manuale):
  - *Dove andare*: 19 capitoli con suggerimenti a tre livelli (spunto, indizio, soluzione)
  - *Melodie*: diario delle 8 melodie, con il luogo nascosto finché non lo chiedi
  - *Consigli*: per il capitolo attuale e in generale
  - *Note*: appunti di viaggio per partita

I testi della guida sono scritti per questa app: non contengono dialoghi o testi del gioco.

## Struttura

```
web/        app (HTML/CSS/JS, nessuna build richiesta)
  js/       main.js (interfaccia), emulator.js, patcher.js, controls.js, storage.js
  data/     mother1.json (capitoli, melodie, consigli)
  vendor/   core mGBA libretro (EmulatorJS)
android/    contenitore WebView (Java) che impacchetta /web come asset
```

## Build

Ogni push su `main` compila l'APK con GitHub Actions (scheda **Actions** → ultimo run → artifact `mother-saga-apk`).

In locale servono JDK 21 e Android SDK 36:

```
cd android
./gradlew assembleRelease
# app/build/outputs/apk/release/app-release.apk
```

L'APK è firmato con la chiave in `android/keystore/`, così ogni build si installa sopra la precedente senza perdere i dati.

## Aggiornamenti

Quando cambia `versionName` in `android/app/build.gradle`, il workflow pubblica una release `vX.Y.Z` con l'APK (`mother-saga.apk`) e le note prese dal messaggio del commit. L'app controlla l'ultima release all'avvio (al massimo ogni 6 ore, o con *Menu → Cerca aggiornamenti*), la scarica e apre l'installazione di Android, che chiede sempre conferma. Il repository deve essere pubblico perché il telefono possa leggere le release.

## Prossimi passi (Fase 2)

Lettura della memoria del gioco per segnare da sole melodie e progressi, e aiuti anti-grind opzionali (esperienza e soldi moltiplicati, meno incontri casuali).

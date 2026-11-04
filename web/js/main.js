// Mother Saga: interfaccia dell'app (installazione, partite, controlli, guida a scomparsa).
import { Emulator } from './emulator.js';
import { setupControls, hapticConfig } from './controls.js';
import { kv, requestPersistence } from './storage.js';
import * as P from './patcher.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isAndroid = () => !!window.AndroidBridge;
const HINT_LEVELS = ['Spunto', 'Indizio', 'Soluzione'];

const app = {
  emu: null,
  run: null,
  guide: null,
  controls: null,
  turbo: false,
  settings: { volume: 1, haptics: 2, speed: 2, turboRate: 12 },
};

// ---------------------------------------------------------------- avvio

async function boot() {
  try {
    setBoot('Carico la guida…');
    app.guide = await (await fetch('data/mother1.json')).json();
    app.settings = { ...app.settings, ...((await kv.get('settings')) || {}) };
    requestPersistence();

    setBoot('Avvio l’emulatore…');
    app.emu = new Emulator($('#screen'));
    await app.emu.init();

    if (!(await app.emu.hasRom())) return showSetup();
    await enterGame();
  } catch (e) {
    console.error(e);
    setBoot(`Errore all’avvio: ${e.message}`);
  }
}

function setBoot(msg) {
  $('#boot').hidden = false;
  $('#boot-msg').textContent = msg;
}
const hideBoot = () => ($('#boot').hidden = true);

// ---------------------------------------------------------------- installazione

function showSetup() {
  hideBoot();
  $('#game').hidden = true;
  $('#setup').hidden = false;
  $('#rom-input').onchange = (e) => e.target.files[0] && pickRom(e.target.files[0]);
  $('#patch-input').onchange = (e) => e.target.files[0] && pickPatch(e.target.files[0]);
  $('#btn-raw').onclick = () => install(app.pendingRom, app.pendingInfo, null);
}

function setStep(step, state, text) {
  const li = $(`.steps [data-step="${step}"]`);
  li.className = state;
  if (text) li.querySelector('small').textContent = text;
}

function setProgress(frac) {
  const p = $('.progress');
  p.hidden = frac == null;
  if (frac != null) $('.progress .bar').style.width = `${Math.round(frac * 100)}%`;
}

function setupError(msg) {
  const err = $('#setup-error');
  err.textContent = msg || '';
  err.hidden = !msg;
}

async function pickRom(file) {
  setupError(null);
  $('#patch-box').hidden = true;
  try {
    setStep('rom', 'active', 'Verifico…');
    const rom = new Uint8Array(await file.arrayBuffer());
    const info = P.identify(rom);
    if (info.game !== 'mother12') {
      setStep('rom', 'fail', `${info.label} (CRC ${P.hex(info.crc)})`);
      throw new Error('Questa non è una ROM di Mother 1+2 per GBA.');
    }
    setStep('rom', 'done', info.label);
    if (info.ready) {
      setStep('patch', 'done', info.lang === 'it' ? 'Già tradotta in italiano' : 'Versione modificata: la uso così com’è');
      return install(rom, info, null);
    }
    app.pendingRom = rom;
    app.pendingInfo = info;
    setStep('patch', 'active', 'Serve una traduzione');
    $('#patch-box').hidden = false;
  } catch (e) {
    console.error(e);
    setupError(e.message);
  } finally {
    $('#rom-input').value = '';
  }
}

async function pickPatch(file) {
  setupError(null);
  try {
    setStep('patch', 'active', `Applico ${file.name}…`);
    setProgress(0);
    await new Promise((r) => setTimeout(r, 30));
    const out = P.applyPatch(app.pendingRom, new Uint8Array(await file.arrayBuffer()), setProgress);
    setProgress(null);
    setStep('patch', 'done', file.name);
    await install(out, P.identify(out), file.name);
  } catch (e) {
    console.error(e);
    setProgress(null);
    setStep('patch', 'fail', 'Patch non applicata');
    setupError(e.message);
  } finally {
    $('#patch-input').value = '';
  }
}

async function install(rom, info, patchName) {
  setStep('apply', 'active', 'Salvo il gioco…');
  await app.emu.writeRom(rom);
  await kv.set('install', { label: info.label, crc: P.hex(P.crc32(rom)), patch: patchName, at: Date.now() });
  setStep('apply', 'done', 'Pronto');
  await enterGame(true);
}

// ---------------------------------------------------------------- partite

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function listRuns() {
  return (await kv.get('runs')) || [];
}

async function getRun(id) {
  return kv.get(`run:${id}`);
}

async function saveRun(run) {
  run.updated = Date.now();
  await kv.set(`run:${run.id}`, run);
  const runs = (await listRuns()).filter((r) => r.id !== run.id);
  runs.unshift({ id: run.id, name: run.name, updated: run.updated });
  await kv.set('runs', runs);
}

async function createRun(name) {
  const run = { id: newId(), name: name || 'Partita', created: Date.now(), melodies: [], chapters: [], revealed: {}, notes: '' };
  await saveRun(run);
  return run;
}

async function deleteRun(id) {
  await app.emu.deleteRunFiles(id);
  await kv.del(`run:${id}`);
  await kv.set('runs', (await listRuns()).filter((r) => r.id !== id));
}

// ---------------------------------------------------------------- gioco

async function enterGame(firstTime = false) {
  $('#setup').hidden = true;
  $('#game').hidden = false;
  hideBoot();
  hapticConfig.mode = app.settings.hapticMode || 0;
  app.controls ??= setupControls($('#pad'), turboWrapper(app.emu), { haptics: () => app.settings.haptics });
  bindTopbar();

  const activeId = await kv.get('active-run');
  let run = activeId && (await getRun(activeId));
  if (!run) {
    const runs = await listRuns();
    run = runs[0] ? await getRun(runs[0].id) : await createRun('Prima partita');
  }
  await startRun(run);
  if (firstTime) toast('Gioco installato. Buon viaggio!', 2600);
}

async function startRun(run) {
  if (app.emu.running) return switchRun(run.id);
  app.run = run;
  await kv.set('active-run', run.id);
  await app.emu.start(run.id, { rewind: true, volume: app.settings.volume });
  app.emu.setSpeed(1);
  updateSpeedBadge();
  updateMelodyChip();
}

/** Il core carica un solo gioco per sessione: per cambiare partita salva tutto e ricarica la pagina. */
async function switchRun(runId) {
  setBoot('Cambio partita…');
  await app.emu.flush();
  await kv.set('active-run', runId);
  app.emu.running = false;
  location.reload();
}

async function persistRun() {
  if (app.run) await saveRun(app.run);
  updateMelodyChip();
}

// Turbo A: mentre A è tenuto premuto, il tasto viene premuto e rilasciato a ripetizione.
function turboWrapper(emu) {
  let timer = null;
  let phase = false;
  const stop = () => {
    clearInterval(timer);
    timer = null;
    emu.release('A');
  };
  return new Proxy(emu, {
    get(target, prop) {
      if (prop === 'press')
        return (btn) => {
          if (btn !== 'A' || !app.turbo) return target.press(btn);
          if (timer) return;
          target.press('A');
          phase = true;
          const half = Math.max(25, Math.round(500 / app.settings.turboRate));
          timer = setInterval(() => {
            phase = !phase;
            if (phase) target.press('A');
            else target.release('A');
          }, half);
        };
      if (prop === 'release')
        return (btn) => {
          if (btn === 'A' && timer) return stop();
          return target.release(btn);
        };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function updateSpeedBadge() {
  const s = app.emu.speed;
  $('#speed-badge').hidden = s === 1;
  $('#speed-badge').textContent = `${s}×`;
}

function updateMelodyChip() {
  const n = app.run?.melodies.length || 0;
  $('#mel-chip').textContent = `♪ ${n}/8`;
  $('#mel-chip').classList.toggle('warn', n === 8);
}

// Messaggi brevi sopra lo schermo, uno dopo l'altro.
const toastQueue = [];
let toastBusy = false;
function toast(msg, ms = 2000) {
  toastQueue.push([msg, ms]);
  if (toastQueue.length > 4) toastQueue.splice(0, toastQueue.length - 4);
  if (!toastBusy) nextToast();
}
function nextToast() {
  const t = $('#toast');
  const item = toastQueue.shift();
  if (!item) {
    toastBusy = false;
    t.hidden = true;
    return;
  }
  toastBusy = true;
  t.textContent = item[0];
  t.hidden = false;
  setTimeout(nextToast, item[1]);
}

function bindTopbar() {
  if (bindTopbar.done) return;
  bindTopbar.done = true;
  $('.topbar').addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (!a) return;
    app.emu.resumeAudio();
    if (a === 'menu') openSheet('Menu', menuView);
    if (a === 'guide') openGuide('cammino');
    if (a === 'melodies') openGuide('melodie');
    if (a === 'states') openSheet('Salvataggi rapidi', statesView);
    if (a === 'turbo') {
      app.turbo = !app.turbo;
      $('#turbo-btn').classList.toggle('on', app.turbo);
      toast(app.turbo ? 'Turbo A attivo: tieni premuto A' : 'Turbo A spento', 1200);
    }
    if (a === 'speed') {
      const next = app.emu.speed === 1 ? app.settings.speed : 1;
      app.emu.setSpeed(next);
      updateSpeedBadge();
      toast(next === 1 ? 'Velocità normale' : `Avanti veloce ${next}×`, 1000);
    }
  });
}

// ---------------------------------------------------------------- cassetto

const sheet = { stack: [], tabs: null, tab: null, tabView: null };

function openSheet(title, view, tabs = null, tab = null) {
  app.emu?.pause();
  app.controls?.releaseAll();
  sheet.stack = [{ title, view }];
  sheet.shown = null;
  sheet.tabs = tabs;
  sheet.tab = tab;
  sheet.tabView = tabs ? view : null;
  $('#sheet').hidden = false;
  render();
}

function pushView(title, view) {
  sheet.stack.push({ title, view });
  render();
}

function popView() {
  if (sheet.stack.length > 1) {
    sheet.stack.pop();
    render();
    return true;
  }
  return false;
}

function closeSheet() {
  $('#sheet').hidden = true;
  sheet.stack = [];
  app.emu.resume();
}

function render() {
  const top = sheet.stack[sheet.stack.length - 1];
  if (!top) return;
  $('#sheet-title').textContent = top.title;
  $('#sheet-back').hidden = sheet.stack.length < 2;
  const tabsEl = $('#sheet-tabs');
  const showTabs = sheet.tabs && sheet.stack.length === 1;
  tabsEl.hidden = !showTabs;
  if (showTabs) tabsEl.innerHTML = sheet.tabs.map(([id, label]) => `<button data-tab="${id}" class="${id === sheet.tab ? 'on' : ''}">${label}</button>`).join('');
  const body = $('#sheet-body');
  if (sheet.shown) sheet.shown.scroll = body.scrollTop;
  body.innerHTML = '';
  top.view(body);
  body.scrollTop = top.scroll || 0;
  sheet.shown = top;
}

function switchTab(id) {
  sheet.tab = id;
  sheet.stack = [{ title: 'Guida', view: sheet.tabView }];
  sheet.shown = null;
  render();
  $(`#sheet-tabs [data-tab="${id}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

$('#sheet').addEventListener('click', (e) => {
  if (e.target.id === 'sheet') return closeSheet();
  if (e.target.closest('[data-action="close"]')) return closeSheet();
  if (e.target.closest('[data-action="back"]')) return popView();
  const t = e.target.closest('[data-tab]');
  if (t) switchTab(t.dataset.tab);
});

// Scorrimento orizzontale: scheda precedente o successiva.
(() => {
  const body = $('#sheet-body');
  let x0 = null;
  let y0 = 0;
  body.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('input, textarea')) return (x0 = null);
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (x0 == null || !sheet.tabs || sheet.stack.length !== 1) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    const ids = sheet.tabs.map(([id]) => id);
    const k = ids.indexOf(sheet.tab) + (dx < 0 ? 1 : -1);
    if (k >= 0 && k < ids.length) switchTab(ids[k]);
  }, { passive: true });
})();

window.onAndroidBack = () => {
  if (!$('#sheet').hidden) {
    if (!popView()) closeSheet();
    return true;
  }
  if (app.run) {
    openSheet('Menu', menuView);
    return true;
  }
  return false;
};
window.onAndroidPause = () => {
  app.controls?.releaseAll();
  app.emu?.pause();
  app.emu?.flush();
};
window.onAndroidResume = () => {
  if ($('#sheet').hidden) app.emu?.resume();
};
document.addEventListener('visibilitychange', () => (document.hidden ? window.onAndroidPause() : window.onAndroidResume()));

function on(root, sel, ev, fn) {
  root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(e, el)));
}

// ---------------------------------------------------------------- guida

const GUIDE_TABS = [
  ['cammino', 'Dove andare'],
  ['melodie', 'Melodie'],
  ['consigli', 'Consigli'],
  ['note', 'Note'],
];

function openGuide(tab) {
  openSheet('Guida', guideView, GUIDE_TABS, tab);
}

function guideView(body) {
  ({ cammino: pathView, melodie: melodiesView, consigli: tipsView, note: notesView })[sheet.tab](body);
}

const revealed = (key) => app.run.revealed[key] || 0;

async function reveal(key) {
  app.run.revealed[key] = Math.min(3, revealed(key) + 1);
  await persistRun();
  render();
}

function hintsHtml(key, hints) {
  const n = revealed(key);
  const shown = hints.slice(0, n).map((h, i) => `<div class="hint"><span class="lvl">${HINT_LEVELS[i]}</span>${esc(h)}</div>`).join('');
  const next = n < hints.length ? `<button class="btn small" data-reveal="${key}">Mostra ${HINT_LEVELS[n].toLowerCase()}</button>` : '';
  return `<div class="hint-steps">${shown}${next ? `<div>${next}</div>` : ''}</div>`;
}

function bindReveal(body) {
  on(body, '[data-reveal]', 'click', (e, el) => reveal(el.dataset.reveal));
}

function currentChapterIndex() {
  const done = new Set(app.run.chapters);
  const i = app.guide.chapters.findIndex((c) => !done.has(c.id));
  return i < 0 ? app.guide.chapters.length - 1 : i;
}

function pathView(body) {
  const cur = currentChapterIndex();
  const done = new Set(app.run.chapters);
  body.innerHTML = `
    <p class="hint">I suggerimenti si aprono un livello alla volta: prima uno spunto, poi un indizio, infine la soluzione.</p>
    <div class="list">${app.guide.chapters
      .map((c, i) => `<div class="chap ${done.has(c.id) ? 'done' : ''} ${i === cur ? 'current' : ''}" data-chap="${c.id}">
        <span class="num">${done.has(c.id) ? '✓' : i + 1}</span>
        <div class="main"><b>${esc(c.title)}</b><small>${esc(c.area)}${i === cur ? ' · sei qui' : ''}</small></div></div>`)
      .join('')}</div>`;
  on(body, '[data-chap]', 'click', (e, el) => pushView('Capitolo', (b) => chapterView(b, el.dataset.chap)));
  // porta in vista il capitolo attuale
  setTimeout(() => body.querySelector('.chap.current')?.scrollIntoView({ block: 'center' }), 0);
}

function chapterView(body, id) {
  const c = app.guide.chapters.find((x) => x.id === id);
  const isDone = app.run.chapters.includes(id);
  const mels = app.guide.melodies.filter((m) => m.chapter === id);
  body.innerHTML = `
    <div class="card"><b style="font-size:18px">${esc(c.title)}</b><br><small>${esc(c.area)}</small>
      <p style="margin:8px 0 0">${esc(c.goal)}</p>
      ${hintsHtml(`c:${id}`, c.hints)}</div>
    ${c.tips.length ? `<div class="card"><b>Consigli</b><ul class="tiplist">${c.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
    ${mels.length ? `<div class="card"><b>Melodie in questo capitolo</b><br><small>${mels.map((m) => `${m.id}ª · ${esc(m.where)}`).join('<br>')}</small></div>` : ''}
    <button class="btn ${isDone ? '' : 'primary'} block" id="btn-done">${isDone ? 'Segna come da fare' : 'Capitolo completato'}</button>`;
  bindReveal(body);
  $('#btn-done', body).addEventListener('click', async () => {
    const set = new Set(app.run.chapters);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    app.run.chapters = app.guide.chapters.map((x) => x.id).filter((x) => set.has(x));
    await persistRun();
    if (!isDone) toast('Capitolo completato');
    popView();
  });
}

function melodiesView(body) {
  const got = new Set(app.run.melodies);
  body.innerHTML = `
    <div class="mel-grid">${app.guide.melodies
      .map((m) => `<div class="mel ${got.has(m.id) ? 'got' : ''}" data-mel="${m.id}"><b>♪${m.id}</b><small>${got.has(m.id) ? 'Trovata' : '?'}</small></div>`)
      .join('')}</div>
    <p class="hint">Tocca una nota per segnarla o per vedere dove cercarla. Il luogo resta nascosto finché non chiedi un suggerimento.</p>`;
  on(body, '[data-mel]', 'click', (e, el) => pushView(`Melodia ${el.dataset.mel}`, (b) => melodyView(b, Number(el.dataset.mel))));
}

function melodyView(body, id) {
  const m = app.guide.melodies.find((x) => x.id === id);
  const got = app.run.melodies.includes(id);
  const key = `m:${id}`;
  const showWhere = got || revealed(key) >= 2;
  body.innerHTML = `
    <div class="card"><b style="font-size:18px">${id}ª melodia</b><br><small>${showWhere ? esc(m.where) : 'Luogo nascosto'}</small>
      ${got ? '<p style="margin:8px 0 0">Trovata. Puoi riascoltarla con l’ocarina.</p>' : hintsHtml(key, m.hints)}</div>
    <button class="btn ${got ? '' : 'primary'} block" id="btn-got">${got ? 'Segna come non trovata' : 'L’ho trovata'}</button>`;
  bindReveal(body);
  $('#btn-got', body).addEventListener('click', async () => {
    const set = new Set(app.run.melodies);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    app.run.melodies = [...set].sort((a, b) => a - b);
    await persistRun();
    if (!got) toast(app.run.melodies.length === 8 ? 'Tutte e otto le melodie!' : `Melodia ${id} trovata`);
    popView();
  });
}

function tipsView(body) {
  const cur = app.guide.chapters[currentChapterIndex()];
  body.innerHTML = `
    <div class="card"><b>Per il capitolo attuale</b><br><small>${esc(cur.title)}</small>
      <ul class="tiplist">${cur.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    <div class="card"><b>In generale</b>
      <ul class="tiplist">${app.guide.dangers.map((d) => `<li><b>${esc(d.name)}</b>: ${esc(d.tip)}</li>`).join('')}
      <li>Usa l’avanti veloce per i combattimenti contro nemici deboli e il turbo A per scorrere i dialoghi.</li>
      <li>Fai un salvataggio rapido prima delle zone nuove: se va male, torni indietro in un attimo.</li></ul></div>`;
}

function notesView(body) {
  body.innerHTML = `<textarea class="notes" id="notes" placeholder="Appunti di viaggio: password, posti da ricontrollare, oggetti lasciati in giro…">${esc(app.run.notes)}</textarea>
    <p class="hint">Le note si salvano da sole e sono separate per ogni partita.</p>`;
  let t;
  $('#notes', body).addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(async () => {
      app.run.notes = e.target.value;
      await persistRun();
    }, 500);
  });
}

// ---------------------------------------------------------------- salvataggi rapidi

function segHtml(id, value, options) {
  return `<div class="seg" data-seg="${id}">${options.map(([v, l]) => `<button data-v="${v}" class="${v === value ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

async function statesView(body) {
  const slots = [1, 2, 3, 4];
  const infos = await Promise.all(slots.map((s) => app.emu.stateInfo(s)));
  const when = (t) => new Date(t).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  body.innerHTML = `
    <p class="hint">Gli stati rapidi sono separati per ogni partita. Il salvataggio del gioco (dal telefono di papà) resta quello principale.</p>
    ${slots
      .map((s) => {
        const info = infos[s - 1];
        return `<div class="slot"><div class="main"><b>Slot ${s}</b><br><small>${info ? when(info.t) : 'Vuoto'}</small></div>
        <button class="btn small" data-save="${s}">Salva</button>
        <button class="btn small ${info ? '' : 'disabled'}" data-load="${s}">Carica</button></div>`;
      })
      .join('')}
    <div class="section-title">Riavvolgimento</div>
    <button class="btn block" id="rewind">Tieni premuto per riavvolgere</button>
    <div class="section-title">Velocità avanti veloce</div>
    ${segHtml('ff', String(app.settings.speed), [['2', '2×'], ['3', '3×'], ['4', '4×'], ['8', '8×']])}`;

  on(body, '[data-save]', 'click', async (e, el) => {
    const ok = await app.emu.saveState(Number(el.dataset.save));
    toast(ok ? `Stato salvato nello slot ${el.dataset.save}` : 'Salvataggio non riuscito');
    render();
  });
  on(body, '[data-load]', 'click', async (e, el) => {
    if (await app.emu.loadState(Number(el.dataset.load))) {
      closeSheet();
      toast(`Caricato slot ${el.dataset.load}`);
    } else toast('Caricamento non riuscito');
  });
  const rw = $('#rewind', body);
  const start = (e) => {
    e.preventDefault();
    app.emu.resume();
    app.emu.rewind(true);
  };
  const stop = () => {
    app.emu.rewind(false);
    app.emu.pause();
  };
  rw.addEventListener('pointerdown', start);
  rw.addEventListener('pointerup', stop);
  rw.addEventListener('pointercancel', stop);
  on(body, '[data-seg="ff"] button', 'click', async (e, el) => {
    app.settings.speed = Number(el.dataset.v);
    await kv.set('settings', app.settings);
    if (app.emu.speed !== 1) app.emu.setSpeed(app.settings.speed);
    render();
  });
}

// ---------------------------------------------------------------- menu

async function menuView(body) {
  const runs = await listRuns();
  const install = (await kv.get('install')) || {};
  body.innerHTML = `
    <div class="section-title">Partite</div>
    <div class="list">${runs
      .map((r) => `<div class="item" data-run="${r.id}"><div class="main"><b>${esc(r.name)}</b><small>${new Date(r.updated).toLocaleDateString('it-IT')}</small></div>
        ${app.run?.id === r.id ? '<span class="status current">In corso</span>' : ''}</div>`)
      .join('')}</div>
    <button class="btn block" id="btn-new" style="margin-top:8px">Nuova partita</button>

    <div class="section-title">Salvataggio di gioco</div>
    <div class="row"><button class="btn" id="btn-export" style="flex:1">Esporta .sav</button>
      <label class="btn" style="flex:1">Importa .sav<input type="file" id="sav-input" hidden></label></div>

    <div class="section-title">Comandi</div>
    <div class="toggle ${app.settings.haptics ? 'on' : ''}" data-toggle="haptics"><div class="main"><b>Vibrazione dei tasti</b><small>Un tocco leggero a ogni pressione</small></div><span class="switch"></span></div>
    <div class="section-title">Turbo A</div>
    ${segHtml('turbo', String(app.settings.turboRate), [['8', 'Lento'], ['12', 'Medio'], ['20', 'Veloce']])}
    <div class="section-title">Volume</div>
    <input type="range" id="vol" min="0" max="1" step="0.05" value="${app.settings.volume}" style="width:100%">

    <div class="section-title">Gioco installato</div>
    <div class="card"><b>${esc(install.label || 'Mother 1+2')}</b><br><small>CRC ${esc(install.crc || '?')}${install.patch ? ` · patch ${esc(install.patch)}` : ''}</small></div>
    <button class="btn block danger" id="btn-reinstall">Cambia ROM</button>
    <p class="hint">Mother Saga ${esc(window.AndroidBridge?.version?.() || 'web')} · la guida è scritta per questa app e non contiene testi del gioco.</p>`;

  on(body, '[data-run]', 'click', (e, el) => pushView('Partita', (b) => runView(b, el.dataset.run)));
  $('#btn-new', body).addEventListener('click', () => pushView('Nuova partita', newRunView));
  $('#btn-export', body).addEventListener('click', () => {
    const sav = app.emu.getSave();
    if (!sav) return toast('Nessun salvataggio di gioco ancora');
    downloadBytes(`${slug(app.run.name)}.sav`, sav);
  });
  $('#sav-input', body).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!confirm(`Sostituire il salvataggio di "${app.run.name}" con ${f.name}? Il gioco ripartirà.`)) return;
    await app.emu.importSave(app.run.id, new Uint8Array(await f.arrayBuffer()));
    await switchRun(app.run.id);
  });
  on(body, '[data-toggle="haptics"]', 'click', async (e, el) => {
    app.settings.haptics = app.settings.haptics ? 0 : 2;
    el.classList.toggle('on', !!app.settings.haptics);
    await kv.set('settings', app.settings);
  });
  on(body, '[data-seg="turbo"] button', 'click', async (e, el) => {
    app.settings.turboRate = Number(el.dataset.v);
    await kv.set('settings', app.settings);
    render();
  });
  $('#vol', body).addEventListener('change', async (e) => {
    app.settings.volume = Number(e.target.value);
    app.emu.setVolume(app.settings.volume);
    await kv.set('settings', app.settings);
  });
  $('#btn-reinstall', body).addEventListener('click', async () => {
    if (!confirm('Scegliere un’altra ROM? Partite e salvataggi restano dove sono.')) return;
    await app.emu.flush();
    await kv.del('rom-patched');
    app.emu.running = false;
    location.reload();
  });
}

async function runView(body, id) {
  const run = await getRun(id);
  const active = app.run?.id === id;
  body.innerHTML = `
    <div class="card"><b style="font-size:18px">${esc(run.name)}</b><br>
      <small>${run.melodies.length}/8 melodie · ${run.chapters.length}/${app.guide.chapters.length} capitoli</small></div>
    ${active ? '' : '<button class="btn primary block" id="btn-play">Gioca questa partita</button>'}
    <div class="section-title">Nome</div>
    <div class="row"><input id="run-name" value="${esc(run.name)}" style="flex:1;min-height:44px;padding:0 12px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit"><button class="btn" id="btn-rename">Salva</button></div>
    ${active ? '' : '<button class="btn danger block" id="btn-del" style="margin-top:16px">Elimina partita</button>'}`;
  $('#btn-play', body)?.addEventListener('click', () => switchRun(id));
  $('#btn-rename', body).addEventListener('click', async () => {
    run.name = $('#run-name', body).value.trim() || run.name;
    await saveRun(run);
    if (active) app.run.name = run.name;
    toast('Nome salvato');
    popView();
  });
  $('#btn-del', body)?.addEventListener('click', async () => {
    if (!confirm(`Eliminare "${run.name}" con salvataggi e stati? Non si può annullare.`)) return;
    await deleteRun(id);
    popView();
  });
}

function newRunView(body) {
  body.innerHTML = `
    <div class="section-title">Nome della partita</div>
    <input id="new-name" value="Partita ${new Date().toLocaleDateString('it-IT')}" style="width:100%;min-height:44px;padding:0 12px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit">
    <p class="hint">Ogni partita ha il suo salvataggio, i suoi stati rapidi, le sue note e i suoi progressi nella guida.</p>
    <button class="btn primary block" id="btn-create">Crea e gioca</button>`;
  $('#btn-create', body).addEventListener('click', async () => {
    const run = await createRun($('#new-name', body).value.trim());
    await switchRun(run.id);
  });
}

// ---------------------------------------------------------------- file

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mother';

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function downloadBytes(name, bytes) {
  if (isAndroid()) {
    window.onAndroidExportDone = (ok) => toast(ok ? 'File salvato' : 'Esportazione annullata');
    window.AndroidBridge.exportFile(name, bytesToBase64(bytes));
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes]));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

window.__app = app; // utile per il debug
boot();

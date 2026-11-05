// Accesso in tempo reale alla memoria del GBA (IWRAM ed EWRAM) dentro il core mGBA.
//
// Il core non espone un puntatore alla RAM: la ricavo da uno stato salvato (blocco "MEM "
// di RetroArch) e poi cerco la stessa regione nella memoria del WebAssembly. Trovata una
// volta, la posizione non cambia per tutta la sessione, quindi letture e scritture sono
// dirette e costano pochissimo.

const IWRAM = { base: 0x03000000, size: 0x8000, stateOff: 0x19000 };
const EWRAM = { base: 0x02000000, size: 0x40000, stateOff: 0x21000 };

function memBlock(state) {
  const dv = new DataView(state.buffer, state.byteOffset, state.byteLength);
  if (state[0] !== 0x52 || state[1] !== 0x41) return 0; // non è RASTATE: stato grezzo di mGBA
  let o = 8;
  while (o + 8 <= state.length) {
    const tag = String.fromCharCode(state[o], state[o + 1], state[o + 2], state[o + 3]);
    const size = dv.getUint32(o + 4, true);
    if (tag === 'MEM ') return o + 8;
    o = (o + 8 + size + 7) & ~7;
  }
  return 0;
}

/** Sceglie una finestra "riconoscibile" (molti byte diversi) dentro la regione. */
function probeOffset(bytes, len = 48) {
  let best = 0;
  let bestScore = -1;
  for (let o = 0; o + len <= bytes.length; o += 256) {
    const seen = new Set();
    for (let i = 0; i < len; i++) seen.add(bytes[o + i]);
    if (seen.size > bestScore) {
      bestScore = seen.size;
      best = o;
      if (seen.size >= len * 0.8) break;
    }
  }
  return best;
}

function findInHeap(heap, needle, from = 0) {
  const first = needle[0];
  const n = needle.length;
  let i = heap.indexOf(first, from);
  while (i !== -1 && i + n <= heap.length) {
    let ok = true;
    for (let k = 1; k < n; k++) {
      if (heap[i + k] !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
    i = heap.indexOf(first, i + 1);
  }
  return -1;
}

function similarity(a, b) {
  let same = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] === b[i]) same++;
  return same / Math.ceil(a.length / 4);
}

export class LiveMemory {
  constructor(emu) {
    this.emu = emu;
    this.ptr = { iw: -1, ew: -1 };
  }

  get ready() {
    return this.ptr.iw >= 0;
  }

  get heap() {
    return this.emu.mod.HEAPU8; // la vista cambia se la memoria del wasm cresce: la rileggo sempre
  }

  /** Trova IWRAM ed EWRAM nella memoria del core. Va chiamata con il gioco avviato. */
  locate() {
    const state = this.emu.getStateBytes();
    const core = memBlock(state);
    for (const [key, r] of [['iw', IWRAM], ['ew', EWRAM]]) {
      const copy = state.subarray(core + r.stateOff, core + r.stateOff + r.size);
      const p = probeOffset(copy);
      const needle = copy.subarray(p, p + 48);
      let at = findInHeap(this.heap, needle);
      // Il campione può comparire più volte: tengo la posizione in cui l'intera regione combacia.
      while (at !== -1) {
        const start = at - p;
        if (start >= 0 && similarity(copy, this.heap.subarray(start, start + r.size)) > 0.9) {
          this.ptr[key] = start;
          break;
        }
        at = findInHeap(this.heap, needle, at + 1);
      }
    }
    return this.ready;
  }

  _at(addr) {
    if (addr >= IWRAM.base && addr < IWRAM.base + IWRAM.size && this.ptr.iw >= 0) return this.ptr.iw + (addr - IWRAM.base);
    if (addr >= EWRAM.base && addr < EWRAM.base + EWRAM.size && this.ptr.ew >= 0) return this.ptr.ew + (addr - EWRAM.base);
    return -1;
  }

  u8(addr) {
    const o = this._at(addr);
    return o < 0 ? 0 : this.heap[o];
  }

  u16(addr) {
    return this.u8(addr) | (this.u8(addr + 1) << 8);
  }

  u24(addr) {
    return this.u16(addr) | (this.u8(addr + 2) << 16);
  }

  bytes(addr, n) {
    const o = this._at(addr);
    return o < 0 ? new Uint8Array(n) : this.heap.slice(o, o + n);
  }

  w8(addr, v) {
    const o = this._at(addr);
    if (o >= 0) this.heap[o] = v & 0xff;
  }

  w16(addr, v) {
    this.w8(addr, v);
    this.w8(addr + 1, v >> 8);
  }
}

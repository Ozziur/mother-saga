// Lettura in tempo reale dello stato di Mother 1 dalla memoria del GBA.
//
// Il gioco tiene i dati della partita in un blocco che rispecchia la RAM della versione
// NES ($7400-$77FF), spostato in IWRAM: NES $xxxx -> GBA $xxxx + 0x02FFBD90.
// Indirizzi verificati sulla ROM italiana 1.1.1 confrontandoli con la schermata di stato.
import { LiveMemory } from './memory.js';

const NES = (a) => a + 0x02ffbd90;

const ADDR = {
  party: NES(0x7408), // 4 byte: id dei membri del gruppo (0 = vuoto)
  money: NES(0x7410), // 16 bit
  bank: NES(0x7412), // 24 bit
  melodies: NES(0x761e), // un bit per melodia
  chars: NES(0x7400), // blocco del personaggio k a chars + 0x40*k
};

// Offset dentro il blocco di un personaggio (verificati su Ninten e Ana).
const C = { maxHp: 0x02, maxPp: 0x04, level: 0x10, exp: 0x11, hp: 0x14, pp: 0x16, ring: 0x2a, name: 0x38 };

export const CHAR_NAMES = { 1: 'Ninten', 2: 'Ana', 3: 'Lloyd', 4: 'Teddy', 5: 'Pippi', 6: 'EVE', 7: 'Uomo volante' };

function decodeName(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    const c = b - 0x80;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '·';
  }
  return s.trim();
}

export class Live {
  constructor(emu, { onMelody, onUpdate } = {}) {
    this.mem = new LiveMemory(emu);
    this.emu = emu;
    this.onMelody = onMelody;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.lastMelodies = null;
    this.snapshot = null;
    this.tries = 0;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Dopo un caricamento di stato il gioco può essere in un punto diverso: riparto da zero. */
  reset() {
    this.lastMelodies = null;
  }

  tick() {
    if (!this.emu.running || this.emu.paused) return;
    try {
      if (!this.mem.ready) {
        if (this.tries++ > 30) return this.stop(); // non trovata: niente funzioni automatiche
        this.mem.locate();
        if (!this.mem.ready) return;
      }
      const s = this.read();
      this.snapshot = s;
      if (!s.inGame) return;
      if (this.lastMelodies != null && s.melodyBits !== this.lastMelodies) {
        const fresh = s.melodies.filter((id) => !(this.lastMelodies & (1 << (id - 1))));
        if (fresh.length) this.onMelody?.(fresh, s);
      }
      this.lastMelodies = s.melodyBits;
      this.onUpdate?.(s);
    } catch (e) {
      console.warn('live', e);
    }
  }

  read() {
    const m = this.mem;
    const ids = [...m.bytes(ADDR.party, 4)].filter((id) => id > 0 && id < 8);
    // In partita Ninten è sempre il primo del gruppo e ha almeno il livello 1.
    const ninten = ADDR.chars + 0x40;
    const inGame = ids[0] === 1 && m.u8(ninten + C.level) >= 1 && m.u8(ninten + C.level) <= 99 && m.u16(ninten + C.maxHp) > 0;
    const bits = m.u8(ADDR.melodies);
    const party = ids.map((id) => {
      const b = ADDR.chars + 0x40 * id;
      return {
        id,
        who: CHAR_NAMES[id] || `#${id}`,
        name: decodeName(m.bytes(b + C.name, 8)),
        level: m.u8(b + C.level),
        exp: m.u24(b + C.exp),
        hp: m.u16(b + C.hp),
        maxHp: m.u16(b + C.maxHp),
        pp: m.u16(b + C.pp),
        maxPp: m.u16(b + C.maxPp),
      };
    });
    return {
      inGame,
      party,
      money: m.u16(ADDR.money),
      bank: m.u24(ADDR.bank),
      melodyBits: bits,
      melodies: [1, 2, 3, 4, 5, 6, 7, 8].filter((id) => bits & (1 << (id - 1))),
      easyRing: m.u8(ninten + C.ring) === 0x37,
    };
  }
}

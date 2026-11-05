// Aiuti anti-grind per Mother 1 (Mother 1+2 con la patch italiana 1.1.1).
//
// La traduzione contiene già il codice dell'"anello facile": se Ninten lo indossa,
// l'esperienza vale ×4, i soldi ×2 e gli incontri usano una tabella più bassa.
// Qui rendo quel codice attivo anche senza anello e ne regolo l'intensità,
// modificando pochi byte della copia della ROM caricata dall'emulatore.
// Prima di ogni modifica controllo i byte originali: con una ROM diversa non tocco niente.

const ROM_BASE = 0x08000000;
const NOP = [0xc0, 0x46];

// Byte originali attesi (indirizzo GBA -> byte).
const EXPECT = {
  0x08fec43c: [0x0a, 0xd1], // esperienza: salto se l'anello non c'è
  0x08fec440: [0x9b, 0x00], // esperienza: lsl r3,r3,#2 (×4)
  0x08fec468: [0x08, 0xd1], // soldi: salto se l'anello non c'è
  0x08fec46a: [0x40, 0x00], // soldi: lsl r0,r0,#1 (×2)
  0x08fec498: [0x10, 0xd1], // incontri: salto se l'anello non c'è
  0x08fec4c0: [0x08, 0x07, 0x06, 0x06, 0x05, 0x04, 0x03, 0x02], // tabella incontri dell'anello
  0x08f1bb48: [0x20, 0x15, 0x10, 0x0d, 0x0a, 0x08, 0x06, 0x04], // tabella incontri normale
};

export const EXP_OPTIONS = [
  ['1', 'Normale'],
  ['2', '×2'],
  ['4', '×4'],
  ['8', '×8'],
];
export const MONEY_OPTIONS = [
  ['1', 'Normale'],
  ['2', '×2'],
  ['4', '×4'],
];
export const ENC_OPTIONS = [
  ['normal', 'Normali'],
  ['half', 'Metà'],
  ['few', 'Pochi'],
  ['none', 'Nessuno'],
];

const ENC_TABLES = {
  half: [0x10, 0x0b, 0x08, 0x07, 0x05, 0x04, 0x03, 0x02],
  few: [0x08, 0x07, 0x06, 0x06, 0x05, 0x04, 0x03, 0x02], // quella dell'anello facile
  none: [0, 0, 0, 0, 0, 0, 0, 0],
};

const SHIFT = { 2: 1, 4: 2, 8: 3 };

export const DEFAULT_AIDS = { exp: 1, money: 1, enc: 'normal' };

/** true se la ROM ha il codice atteso (Mother 1+2 italiana 1.1.1). */
export function aidsSupported(rom) {
  return Object.entries(EXPECT).every(([addr, bytes]) => {
    const o = Number(addr) - ROM_BASE;
    return bytes.every((b, i) => rom[o + i] === b);
  });
}

export const aidsActive = (a) => !!a && (Number(a.exp) > 1 || Number(a.money) > 1 || (a.enc && a.enc !== 'normal'));

/** Restituisce una copia della ROM con gli aiuti richiesti, o la ROM stessa se non serve. */
export function applyAids(rom, aids) {
  if (!aidsActive(aids) || !aidsSupported(rom)) return rom;
  const out = new Uint8Array(rom);
  const put = (addr, bytes) => out.set(bytes, addr - ROM_BASE);

  const exp = Number(aids.exp);
  if (SHIFT[exp]) {
    put(0x08fec43c, NOP);
    put(0x08fec440, [(SHIFT[exp] << 6) | 0x1b, 0x00]); // lsl r3,r3,#n
  }
  const money = Number(aids.money);
  if (SHIFT[money]) {
    put(0x08fec468, NOP);
    put(0x08fec46a, [SHIFT[money] << 6, 0x00]); // lsl r0,r0,#n
  }
  if (ENC_TABLES[aids.enc]) {
    put(0x08fec498, NOP);
    put(0x08fec4c0, ENC_TABLES[aids.enc]);
  }
  return out;
}

export function aidsSummary(a) {
  if (!aidsActive(a)) return 'Nessun aiuto';
  const parts = [];
  if (Number(a.exp) > 1) parts.push(`esperienza ×${a.exp}`);
  if (Number(a.money) > 1) parts.push(`soldi ×${a.money}`);
  if (a.enc && a.enc !== 'normal') parts.push(`incontri: ${ENC_OPTIONS.find(([v]) => v === a.enc)?.[1].toLowerCase()}`);
  return parts.join(', ');
}

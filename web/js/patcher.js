// Riconoscimento della ROM e applicazione di patch IPS, UPS e BPS.
// Tutto avviene sul telefono: la ROM non viene mai inviata altrove.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const hex = (n) => n.toString(16).toUpperCase().padStart(8, '0');

// ---------- riconoscimento ----------

/** ROM conosciute. `ready`: si può giocare così com'è. */
export const KNOWN_ROMS = {
  0x1bb09cb3: { game: 'mother12', label: 'Mother 1+2 in italiano (patch 1.1.1)', lang: 'it', ready: true },
  0x0a44569c: { game: 'mother12', label: 'Mother 1+2 giapponese originale', lang: 'ja', ready: false },
};

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to)).replace(/\0+$/, '');

/** Legge l'intestazione GBA e riconosce il gioco. */
export function identify(rom) {
  if (rom.length < 0xc0) throw new Error('Il file è troppo piccolo per essere una ROM GBA.');
  const title = ascii(rom, 0xa0, 0xac);
  const code = ascii(rom, 0xac, 0xb0);
  const crc = crc32(rom);
  const known = KNOWN_ROMS[crc];
  if (known) return { ...known, crc, title, code, known: true };
  if (code === 'A2UJ') {
    return { game: 'mother12', label: 'Mother 1+2 modificata (versione non riconosciuta)', lang: '?', ready: true, crc, title, code, known: false };
  }
  return { game: null, label: title || 'ROM sconosciuta', crc, title, code, known: false, ready: false };
}

// ---------- IPS ----------

function applyIps(source, patch) {
  if (ascii(patch, 0, 5) !== 'PATCH') throw new Error('Il file non è una patch IPS valida.');
  // Prima passata: dimensione finale.
  let size = source.length;
  let p = 5;
  const records = [];
  while (p + 3 <= patch.length) {
    if (patch[p] === 0x45 && patch[p + 1] === 0x4f && patch[p + 2] === 0x46) {
      // "EOF", eventualmente seguito dalla dimensione di troncamento
      if (p + 6 <= patch.length) size = (patch[p + 3] << 16) | (patch[p + 4] << 8) | patch[p + 5];
      break;
    }
    const off = (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2];
    const len = (patch[p + 3] << 8) | patch[p + 4];
    p += 5;
    if (len) {
      records.push({ off, data: patch.subarray(p, p + len) });
      p += len;
      size = Math.max(size, off + len);
    } else {
      const rle = (patch[p] << 8) | patch[p + 1];
      records.push({ off, fill: patch[p + 2], len: rle });
      p += 3;
      size = Math.max(size, off + rle);
    }
  }
  const out = new Uint8Array(size);
  out.set(source.subarray(0, Math.min(size, source.length)));
  for (const r of records) {
    if (r.data) out.set(r.data, r.off);
    else out.fill(r.fill, r.off, r.off + r.len);
  }
  return out;
}

// ---------- UPS e BPS (stesso schema di numeri variabili) ----------

function readU32LE(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function varint(patch, state) {
  let data = 0;
  let shift = 1;
  for (;;) {
    const x = patch[state.p++];
    data += (x & 0x7f) * shift;
    if (x & 0x80) break;
    shift *= 128;
    data += shift;
  }
  return data;
}

function checkFooter(source, patch, kind) {
  const n = patch.length;
  const src = readU32LE(patch, n - 12);
  const tgt = readU32LE(patch, n - 8);
  if (crc32(patch, 0, n - 4) !== readU32LE(patch, n - 4)) throw new Error(`La patch ${kind} è danneggiata.`);
  return { src, tgt };
}

function applyUps(source, patch) {
  if (ascii(patch, 0, 4) !== 'UPS1') throw new Error('Il file non è una patch UPS valida.');
  const { src, tgt } = checkFooter(source, patch, 'UPS');
  const srcCrc = crc32(source);
  // Le UPS funzionano in entrambi i versi: capisco quale dalla ROM fornita.
  if (srcCrc !== src && srcCrc !== tgt) throw wrongRom(src, srcCrc);
  const s = { p: 4 };
  const inSize = varint(patch, s);
  const outSize = varint(patch, s);
  const size = srcCrc === src ? outSize : inSize;
  const out = new Uint8Array(size);
  out.set(source.subarray(0, Math.min(size, source.length)));
  let o = 0;
  const end = patch.length - 12;
  while (s.p < end) {
    o += varint(patch, s);
    while (s.p < end) {
      const x = patch[s.p++];
      if (x === 0) {
        o++;
        break;
      }
      if (o < size) out[o] ^= x;
      o++;
    }
  }
  const outCrc = crc32(out);
  if (outCrc !== (srcCrc === src ? tgt : src)) throw new Error('Patch applicata ma il risultato non è valido.');
  return out;
}

function applyBps(source, patch, onProgress) {
  if (ascii(patch, 0, 4) !== 'BPS1') throw new Error('Il file non è una patch BPS valida.');
  const { src, tgt } = checkFooter(source, patch, 'BPS');
  const srcCrc = crc32(source);
  if (srcCrc !== src) throw wrongRom(src, srcCrc);
  const s = { p: 4 };
  const sourceSize = varint(patch, s);
  const targetSize = varint(patch, s);
  s.p += varint(patch, s); // metadati
  if (sourceSize !== source.length) throw new Error('Dimensione della ROM inattesa.');

  const target = new Uint8Array(targetSize);
  let out = 0;
  let srcRel = 0;
  let tgtRel = 0;
  let last = 0;
  const end = patch.length - 12;
  while (s.p < end) {
    const data = varint(patch, s);
    const cmd = data % 4;
    let len = Math.floor(data / 4) + 1;
    if (cmd === 0) {
      target.set(source.subarray(out, out + len), out);
      out += len;
    } else if (cmd === 1) {
      target.set(patch.subarray(s.p, s.p + len), out);
      s.p += len;
      out += len;
    } else if (cmd === 2) {
      const d = varint(patch, s);
      srcRel += (d & 1 ? -1 : 1) * Math.floor(d / 2);
      target.set(source.subarray(srcRel, srcRel + len), out);
      srcRel += len;
      out += len;
    } else {
      const d = varint(patch, s);
      tgtRel += (d & 1 ? -1 : 1) * Math.floor(d / 2);
      while (len--) target[out++] = target[tgtRel++];
    }
    if (onProgress && out - last > 1 << 20) {
      last = out;
      onProgress(out / targetSize);
    }
  }
  if (crc32(target) !== tgt) throw new Error('Patch applicata ma il risultato non è valido.');
  return target;
}

function wrongRom(expected, found) {
  return new Error(`Questa patch richiede un'altra versione del gioco (CRC atteso ${hex(expected)}, trovato ${hex(found)}).`);
}

/** Applica una patch riconoscendone il formato dal contenuto. */
export function applyPatch(source, patch, onProgress) {
  const magic = ascii(patch, 0, 5);
  if (magic === 'PATCH') return applyIps(source, patch);
  if (magic.startsWith('UPS1')) return applyUps(source, patch);
  if (magic.startsWith('BPS1')) return applyBps(source, patch, onProgress);
  throw new Error('Formato di patch non riconosciuto: servono file IPS, UPS o BPS.');
}

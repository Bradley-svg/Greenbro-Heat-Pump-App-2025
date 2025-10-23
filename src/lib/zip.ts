// Minimal PKZip writer (method 0 - store). Worker-safe, no Node deps.

function crc32(buf: Uint8Array): number {
  const table = (crc32 as any)._t || ((crc32 as any)._t = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })());
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosTimeStamp(d: Date) {
  const year = d.getFullYear();
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2);
  return { dosDate, dosTime };
}

function u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }

export type ZipEntry = { name: string; data: Uint8Array };

export function zipStore(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const now = new Date();
  const { dosDate, dosTime } = dosTimeStamp(now);

  const fileRecords: { nameBytes: Uint8Array; crc: number; size: number; offset: number; header: Uint8Array; data: Uint8Array }[] = [];
  let offset = 0;
  const chunks: Uint8Array[] = [];

  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const header = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(dosTime),
      ...u16(dosDate),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
    ]);

    chunks.push(header, e.data);
    fileRecords.push({ nameBytes, crc, size, offset, header, data: e.data });
    offset += header.length + e.data.length;
  }

  const cdStart = offset;
  for (const fr of fileRecords) {
    const central = new Uint8Array([
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...fr.header.slice(10, 14),
      ...u32(fr.crc),
      ...u32(fr.size),
      ...u32(fr.size),
      ...u16(fr.nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(fr.offset),
      ...fr.nameBytes,
    ]);
    chunks.push(central);
    offset += central.length;
  }
  const cdSize = offset - cdStart;

  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0), ...u16(0),
    ...u16(fileRecords.length),
    ...u16(fileRecords.length),
    ...u32(cdSize),
    ...u32(cdStart),
    ...u16(0),
  ]);
  chunks.push(end);
  offset += end.length;

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

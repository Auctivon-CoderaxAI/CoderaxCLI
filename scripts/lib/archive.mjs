/**
 * Minimal, deterministic tar and zip writers and readers.
 *
 * Release artifacts must be byte-for-byte reproducible and must not depend on
 * the host's tar/zip implementation, so both formats are produced here with
 * fixed metadata: sorted entries, zeroed uid/gid, a caller-supplied mtime, and
 * fixed compression levels.
 */
import { deflateRawSync, gzipSync, inflateRawSync } from "node:zlib";

const BLOCK = 512;

function fail(message) {
  throw new Error(message);
}

function octal(value, width) {
  const text = Number(value).toString(8);
  if (text.length > width - 1) fail(`value ${value} does not fit in ${width} octal bytes`);
  return `${text.padStart(width - 1, "0")}\0`;
}

function field(text, width, label) {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length > width) fail(`${label} is too long for ustar (${encoded.length} > ${width}): ${text}`);
  const out = Buffer.alloc(width);
  encoded.copy(out);
  return out;
}

/** Split a tar path into the ustar name/prefix pair. */
function splitPath(path) {
  const encoded = Buffer.from(path, "utf8");
  if (encoded.length <= 100) return { name: path, prefix: "" };
  const slash = path.lastIndexOf("/");
  while (slash > 0) {
    const name = path.slice(slash + 1);
    const prefix = path.slice(0, slash);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
    break;
  }
  fail(`path cannot be represented in ustar: ${path}`);
}

function tarHeader({ path, mode, size, mtime, type = "0" }) {
  const { name, prefix } = splitPath(path);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(Math.floor(mtime / 1000), 12), 136, 12, "ascii");
  // The checksum field is spaces while the sum is computed.
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/**
 * entries: [{ path, data, mode }]
 * All entries are files; extractors create parent directories.
 */
export function createTar(entries, { mtime }) {
  if (!Number.isFinite(mtime) || mtime < 0) fail("mtime must be a non-negative millisecond timestamp");
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  for (const entry of sorted) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    chunks.push(tarHeader({ path: entry.path, mode: entry.mode ?? 0o644, size: data.length, mtime }));
    chunks.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

export function createTarGz(entries, { mtime, level = 9 }) {
  return gzipSync(createTar(entries, { mtime }), { level });
}

export function readTar(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const storedChecksum = Number.parseInt(header.toString("ascii", 148, 156).trim() || "0", 8);
    const copy = Buffer.from(header);
    copy.write("        ", 148, 8, "ascii");
    let checksum = 0;
    for (const byte of copy) checksum += byte;
    if (checksum !== storedChecksum) fail(`tar header checksum mismatch at offset ${offset}`);

    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const type = header.toString("ascii", 156, 157);
    const mode = Number.parseInt(header.toString("ascii", 100, 108).replace(/\0.*$/, "").trim() || "0", 8);
    const size = Number.parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim() || "0", 8);
    const path = prefix ? `${prefix}/${name}` : name;

    offset += BLOCK;
    const data = buffer.subarray(offset, offset + size);
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === "0" || type === "") entries.set(path, { data: Buffer.from(data), mode });
  }
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dostime(mtime) {
  const date = new Date(Math.max(Date.UTC(1980, 0, 1), mtime));
  const year = Math.min(2107, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * entries: [{ path, data, mode }]
 * Deflate is used for every entry so the bytes depend only on the input and
 * the fixed compression level.
 */
export function createZip(entries, { mtime, level = 9 }) {
  if (!Number.isFinite(mtime) || mtime < 0) fail("mtime must be a non-negative millisecond timestamp");
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const { time, date } = dostime(mtime);
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of sorted) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const name = Buffer.from(entry.path, "utf8");
    const compressed = deflateRawSync(data, { level });
    const mode = entry.mode ?? 0o644;
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    local.push(header, name, compressed);

    const entryRecord = Buffer.alloc(46);
    entryRecord.writeUInt32LE(0x02014b50, 0);
    entryRecord.writeUInt16LE(0x031e, 4); // UNIX, spec 3.0
    entryRecord.writeUInt16LE(20, 6);
    entryRecord.writeUInt16LE(0, 8);
    entryRecord.writeUInt16LE(8, 10);
    entryRecord.writeUInt16LE(time, 12);
    entryRecord.writeUInt16LE(date, 14);
    entryRecord.writeUInt32LE(crc, 16);
    entryRecord.writeUInt32LE(compressed.length, 20);
    entryRecord.writeUInt32LE(data.length, 24);
    entryRecord.writeUInt16LE(name.length, 28);
    entryRecord.writeUInt16LE(0, 30);
    entryRecord.writeUInt16LE(0, 32);
    entryRecord.writeUInt16LE(0, 34);
    entryRecord.writeUInt16LE(0, 36);
    entryRecord.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    entryRecord.writeUInt32LE(offset, 42);

    central.push(entryRecord, name);
    offset += header.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuffer, end]);
}

export function readZip(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end === -1) fail("zip end-of-central-directory record not found");

  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  let offset = centralOffset;

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) fail(`zip central directory is corrupt at ${offset}`);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== size) fail(`zip entry ${name} has the wrong size`);
    if (crc32(data) !== crc) fail(`zip entry ${name} failed its CRC check`);

    entries.set(name, { data, mode: (externalAttributes >>> 16) & 0o777 });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

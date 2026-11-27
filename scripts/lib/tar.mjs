import { gzipSync } from "node:zlib";

/**
 * A small, dependency-free ustar writer. npm tarballs only need regular files,
 * and writing them here (instead of shelling out to `tar`) makes the bytes
 * identical on Linux, macOS and Windows: fixed mtime, ownership, ordering and
 * gzip settings.
 */

function writeOctal(buffer, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buffer.write(text, offset, length - 1, "ascii");
  buffer.writeUInt8(0, offset + length - 1);
}

function splitPath(path) {
  if (Buffer.byteLength(path, "utf8") <= 100) return { prefix: "", name: path };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { prefix, name };
    }
  }
  throw new Error(`tar path is too long for ustar: ${path}`);
}

function header(path, mode, size) {
  const block = Buffer.alloc(512, 0);
  const { prefix, name } = splitPath(path);
  block.write(name, 0, 100, "utf8");
  writeOctal(block, mode, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, size, 124, 12);
  writeOctal(block, 0, 136, 12);
  block.fill(0x20, 148, 156);
  block.write("0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  if (prefix) block.write(prefix, 345, 155, "utf8");

  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  block.writeUInt8(0, 154);
  block.writeUInt8(0x20, 155);
  return block;
}

export function createDeterministicTar(entries) {
  const parts = [];
  const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of ordered) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    parts.push(header(entry.path, entry.mode ?? 0o644, content.length));
    parts.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

export function createDeterministicTarball(entries) {
  // gzip -n equivalent: no name and no timestamp in the header.
  const gzip = gzipSync(createDeterministicTar(entries), { level: 9 });
  gzip[9] = 255; // RFC 1952: OS unknown, independent of the build host.
  return gzip;
}

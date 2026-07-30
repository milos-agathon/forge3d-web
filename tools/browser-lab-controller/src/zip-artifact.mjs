import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function extractZipEntries(bytes) {
  const archive = Buffer.from(bytes);
  const eocdOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (
    entryCount < 1 ||
    centralOffset + centralSize > eocdOffset ||
    archive.readUInt16LE(eocdOffset + 4) !== 0 ||
    archive.readUInt16LE(eocdOffset + 6) !== 0
  ) {
    throw new Error("authorization ZIP must be a single-disk non-empty archive");
  }
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > archive.length ||
      archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("authorization ZIP central directory is malformed");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (
      flags & 0x1 ||
      ![0, 8].includes(method) ||
      !/^[A-Za-z0-9._-]+$/u.test(name) ||
      name.includes("..")
    ) {
      throw new Error(`authorization ZIP entry is unsafe: ${name}`);
    }
    const data = readLocalEntry({
      archive,
      localOffset,
      name,
      method,
      compressedSize,
      uncompressedSize,
    });
    entries.push({ name, bytes: data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("authorization ZIP central directory size is inconsistent");
  }
  return entries;
}

function readLocalEntry({
  archive,
  localOffset,
  name,
  method,
  compressedSize,
  uncompressedSize,
}) {
  if (
    localOffset + 30 > archive.length ||
    archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
  ) {
    throw new Error(`authorization ZIP local header is missing: ${name}`);
  }
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const localName = archive
    .subarray(localOffset + 30, localOffset + 30 + localNameLength)
    .toString("utf8");
  if (localName !== name) {
    throw new Error("authorization ZIP local/central names disagree");
  }
  const start = localOffset + 30 + localNameLength + localExtraLength;
  const end = start + compressedSize;
  if (end > archive.length) {
    throw new Error(`authorization ZIP entry is truncated: ${name}`);
  }
  const compressed = archive.subarray(start, end);
  const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
  if (data.length !== uncompressedSize) {
    throw new Error(`authorization ZIP entry size is inconsistent: ${name}`);
  }
  return data;
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("authorization ZIP end-of-central-directory is missing");
}

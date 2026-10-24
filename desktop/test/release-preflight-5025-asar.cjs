'use strict';
// Minimal, dependency-free ASAR reader/writer for the release-preflight-5025
// packaged checks (the old audit used @electron/asar, which is no longer a
// desktop devDependency). The reader is validated against a real
// electron-forge app.asar; the writer exists only to build small synthetic
// archives for the audit tool's negative self-test.

const fs = require('node:fs');

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(8);
    fs.readSync(fd, prefix, 0, 8, 0);
    const payloadSize = prefix.readUInt32LE(4);
    const payload = Buffer.alloc(payloadSize);
    fs.readSync(fd, payload, 0, payloadSize, 8);
    // payload is itself a pickle: [uint32 innerPayloadSize][uint32 jsonLen][json]
    const jsonSize = payload.readUInt32LE(4);
    const json = payload.subarray(8, 8 + jsonSize).toString('utf8');
    return { header: JSON.parse(json), payloadSize, dataStart: 8 + payloadSize };
  } finally {
    fs.closeSync(fd);
  }
}

function findEntry(asar, p) {
  const parts = p.split('/').filter(Boolean);
  let node = { files: asar.header.files };
  for (let index = 0; index < parts.length; index += 1) {
    const current = node.files ? node.files[parts[index]] : undefined;
    if (!current) return null;
    if (index === parts.length - 1) return current;
    node = current;
  }
  return null;
}

function listAll(asar) {
  const out = [];
  const walk = (files, prefix) => {
    for (const [name, entry] of Object.entries(files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry.files, p);
      else out.push(p);
    }
  };
  walk(asar.header.files, '');
  return out;
}

function extractFile(asarPath, asar, p) {
  const entry = findEntry(asar, p);
  if (!entry) throw new Error(`asar entry not found: ${p}`);
  if (entry.unpacked) {
    return fs.readFileSync(`${asarPath}.unpacked/${p}`);
  }
  const start = asar.dataStart + Number(entry.offset);
  const buf = Buffer.alloc(entry.size);
  const fd = fs.openSync(asarPath, 'r');
  try {
    fs.readSync(fd, buf, 0, entry.size, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

// asar wire format (matches @electron/asar's chromium pickle layout):
// | uint32 pickleHeaderSize (4) | uint32 payloadSize | payload |
// payload: uint32 jsonLen + utf8 json (+ padding to 4); data starts after.
function writeArchive(asarPath, flatFiles) {
  // flatFiles: [{ path, content: Buffer, unpacked?: boolean }] — unpacked
  // entries are recorded in the header only (real content lives beside the
  // archive as <asarPath>.unpacked/<path>, which callers must provide).
  const tree = {};
  const blobs = [];
  let offset = 0;
  for (const { path: p, content, unpacked } of flatFiles) {
    const parts = p.split('/');
    let node = tree;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (!node[part]) node[part] = { files: {} };
      node = node[part].files;
    }
    const leaf = parts[parts.length - 1];
    if (unpacked) {
      node[leaf] = { size: content.length, unpacked: true };
    } else {
      node[leaf] = { size: content.length, offset: String(offset) };
      blobs.push({ offset, content });
      offset += content.length;
    }
  }
  const jsonBuf = Buffer.from(JSON.stringify({ files: tree }), 'utf8');
  // pickle payload alignment is 8: [uint32 jsonLen][json][pad to 8]
  const innerLen = 4 + jsonBuf.length + ((8 - ((4 + jsonBuf.length) % 8)) % 8);
  const inner = Buffer.alloc(innerLen);
  inner.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(inner, 4);
  const payload = Buffer.alloc(4 + innerLen);
  payload.writeUInt32LE(innerLen, 0);
  inner.copy(payload, 4);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(payload.length, 4);
  const dataStart = 8 + payload.length;
  const fd = fs.openSync(asarPath, 'w');
  try {
    fs.writeSync(fd, header, 0, header.length, 0);
    fs.writeSync(fd, payload, 0, payload.length, 8);
    for (const { offset: blobOffset, content } of blobs) {
      fs.writeSync(fd, content, 0, content.length, dataStart + blobOffset);
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readHeader, findEntry, listAll, extractFile, writeArchive };

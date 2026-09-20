'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { cleanId, normalizeAttachments, IMAGE_MEDIA_TYPES } = require('../../contracts');

const EXTENSIONS = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'text/plain': '.txt', 'text/markdown': '.md', 'application/json': '.json.txt', 'text/csv': '.csv',
};

class AttachmentStore {
  constructor(options = {}) {
    if (!options.root) throw new Error('AttachmentStore root is required');
    this.root = path.resolve(options.root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  saveMany(sessionId, input) {
    const id = cleanId(sessionId, 'sessionId');
    const items = normalizeAttachments(input);
    for (const item of items) if (IMAGE_MEDIA_TYPES.includes(item.mediaType)) verifyImage(Buffer.from(item.data, 'base64'), item.mediaType);
    return items.map(item => this.save(id, item));
  }

  save(sessionId, input) {
    const sid = cleanId(sessionId, 'sessionId');
    const item = normalizeAttachments([input])[0];
    const isImage = IMAGE_MEDIA_TYPES.includes(item.mediaType);
    const id = item.id || `${isImage ? 'img' : 'file'}-${crypto.randomUUID()}`;
    const buffer = Buffer.from(item.data, 'base64');
    if (isImage) verifyImage(buffer, item.mediaType);
    const directory = path.join(this.root, hash(sid));
    const stem = hash(id);
    const extension = EXTENSIONS[item.mediaType];
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${stem}${extension}`);
    const metaFile = path.join(directory, `${stem}.json`);
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    const metadata = {
      id, sessionId: sid, name: item.name, mediaType: item.mediaType, size: buffer.length,
      width: item.width, height: item.height, createdAt: new Date().toISOString(), file: path.basename(file),
    };
    fs.writeFileSync(metaFile, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return metadata;
  }

  read(sessionId, attachmentId) {
    const sid = cleanId(sessionId, 'sessionId');
    const id = cleanId(attachmentId, 'attachmentId');
    const directory = path.join(this.root, hash(sid));
    const metaFile = path.join(directory, `${hash(id)}.json`);
    if (!fs.existsSync(metaFile)) return null;
    const metadata = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (metadata.id !== id || metadata.sessionId !== sid) return null;
    const file = path.resolve(directory, metadata.file);
    if (!file.startsWith(`${directory}${path.sep}`) || !fs.existsSync(file)) return null;
    return { metadata, data: fs.readFileSync(file) };
  }
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function verifyImage(buffer, mediaType) {
  const valid = mediaType === 'image/png'
    ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mediaType === 'image/jpeg'
      ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : mediaType === 'image/gif'
        ? buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
        : mediaType === 'image/webp'
          ? buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
          : false;
  if (!valid) throw Object.assign(new Error(`attachment content does not match ${mediaType}`), { status: 415 });
}

module.exports = { AttachmentStore, verifyImage };

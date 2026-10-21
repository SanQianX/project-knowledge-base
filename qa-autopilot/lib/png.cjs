'use strict';
const fs = require('node:fs'), zlib = require('node:zlib');
const { must } = require('./safety.cjs');
function crc32(b) { let c = 0xffffffff; for (const v of b) {
    c ^= v;
    for (let k = 0; k < 8; k++)
        c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
} return (c ^ 0xffffffff) >>> 0; }
function decode(input) {
    const b = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    must(b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG', 'Invalid PNG');
    let width, height, channels, seen = false, end = false;
    const parts = [];
    for (let o = 8; o + 12 <= b.length;) {
        const n = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8);
        must(o + 12 + n <= b.length, 'PNG_TRUNCATED', 'Truncated PNG');
        const data = b.subarray(o + 8, o + 8 + n);
        must(crc32(b.subarray(o + 4, o + 8 + n)) === b.readUInt32BE(o + 8 + n), 'PNG_CRC', 'Invalid PNG CRC');
        if (type === 'IHDR') {
            must(!seen, 'PNG_HEADER', 'Duplicate header');
            seen = true;
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
            must(data[8] === 8 && channels && data[10] === 0 && data[11] === 0 && data[12] === 0 && width > 0 && height > 0 && width * height <= 16000000, 'PNG_FORMAT', 'Only bounded non-interlaced 8-bit RGB/RGBA PNGs supported.');
        }
        else if (type === 'IDAT')
            parts.push(data);
        else if (type === 'IEND') {
            end = true;
            break;
        }
        o += n + 12;
    }
    must(seen && end && parts.length, 'PNG_INCOMPLETE', 'Missing PNG chunks');
    const stride = width * channels, raw = zlib.inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height });
    must(raw.length === (stride + 1) * height, 'PNG_LENGTH', 'PNG length mismatch');
    const pixels = Buffer.alloc(stride * height);
    function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        must(filter <= 4, 'PNG_FILTER', 'Unknown PNG filter');
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? pixels[y * stride + x - channels] : 0, b = y ? pixels[(y - 1) * stride + x] : 0, c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
            const add = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
            pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + add) & 255;
        }
    }
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = pixels[i * channels];
        rgba[i * 4 + 1] = pixels[i * channels + 1];
        rgba[i * 4 + 2] = pixels[i * channels + 2];
        rgba[i * 4 + 3] = channels === 4 ? pixels[i * channels + 3] : 255;
    }
    return { width, height, pixels: rgba };
}
function encode({ width, height, pixels }) { must(pixels.length === width * height * 4, 'PNG_ENCODE', 'RGBA length mismatch'); function chunk(type, data) { const t = Buffer.from(type), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([t, data])), data.length + 8); return out; } const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 6; const raw = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++)
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
function diff(a, b, { channelTolerance = 0, maxChangedRatio = 0 } = {}) { must(a.width === b.width && a.height === b.height, 'PNG_DIMENSIONS', 'Dimension changes require review'); must(Number.isFinite(channelTolerance) && channelTolerance >= 0 && channelTolerance <= 255 && Number.isFinite(maxChangedRatio) && maxChangedRatio >= 0 && maxChangedRatio <= .05, 'VISUAL_THRESHOLD', 'Invalid or too-permissive threshold'); let changed = 0; const pixels = Buffer.alloc(a.pixels.length); for (let i = 0; i < a.width * a.height; i++) {
    let different = false;
    for (let c = 0; c < 4; c++)
        if (Math.abs(a.pixels[4 * i + c] - b.pixels[4 * i + c]) > channelTolerance)
            different = true;
    if (different)
        changed++;
    pixels[4 * i] = different ? 255 : Math.round(b.pixels[4 * i] * .3);
    pixels[4 * i + 1] = different ? 0 : Math.round(b.pixels[4 * i + 1] * .3);
    pixels[4 * i + 2] = different ? 255 : Math.round(b.pixels[4 * i + 2] * .3);
    pixels[4 * i + 3] = 255;
} const ratio = changed / (a.width * a.height); return { status: ratio <= maxChangedRatio ? 'PASS' : 'FAIL', changedPixels: changed, changedRatio: ratio, diffImage: { width: a.width, height: a.height, pixels } }; }
module.exports = { crc32, decode, encode, diff };

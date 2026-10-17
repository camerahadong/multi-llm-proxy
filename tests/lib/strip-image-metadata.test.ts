import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stripImageMetadata, stripImageMetadataB64 } from '../../src/lib/strip-image-metadata.js';

const crc = (b: Buffer) => {
  let c = ~0;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c >>> 0);
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
const idat = deflateSync(Buffer.from([0, 255, 0, 0]));
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const clean = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('pHYs', Buffer.alloc(9)), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
const dirty = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('caBX', Buffer.alloc(64, 7)), chunk('pHYs', Buffer.alloc(9)),
  chunk('tEXt', Buffer.from('XML:com.adobe.xmp\0<x/>')), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

describe('stripImageMetadata', () => {
  it('removes C2PA/XMP chunks from PNG, keeps pixel and colour chunks', () => {
    expect(stripImageMetadata(dirty).equals(clean)).toBe(true);
    expect(stripImageMetadata(clean).equals(clean)).toBe(true); // idempotent
  });
  it('removes EXIF/C2PA segments from JPEG, keeps image data', () => {
    const seg = (m: number, data: Buffer) => { const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(data.length + 2, 2); return Buffer.concat([h, data]); };
    const scan = Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, Buffer.from('Exif')), seg(0xeb, Buffer.from('JUMBF')), seg(0xdb, Buffer.alloc(4)), scan]);
    expect(stripImageMetadata(jpeg).equals(Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xdb, Buffer.alloc(4)), scan]))).toBe(true);
  });
  it('keeps data-URI prefix, leaves unknown or truncated input alone', () => {
    const uri = `data:image/png;base64,${dirty.toString('base64')}`;
    expect(stripImageMetadataB64(uri)).toBe(`data:image/png;base64,${clean.toString('base64')}`);
    expect(stripImageMetadataB64(dirty.toString('base64'))).toBe(clean.toString('base64'));
    const gif = Buffer.from('GIF89a....');
    expect(stripImageMetadata(gif).equals(gif)).toBe(true);
    const truncated = dirty.subarray(0, 40);
    expect(stripImageMetadata(truncated).equals(truncated)).toBe(true);
  });
});

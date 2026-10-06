import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupTempFiles, fetchImageToTmp, isPrivateAddress, saveBase64Image } from '../../src/lib/image-store.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c00000000049454e44ae426082', 'hex');

describe('image-store', () => {
  it('rejects non-image bytes (e.g. JSON smuggled as an "image")', () => {
    expect(() => saveBase64Image(Buffer.from('{"apiKeys":[]}').toString('base64'))).toThrow(/không phải ảnh/);
  });

  it('stores each image in its own random dir and cleans the dir up', () => {
    const a = saveBase64Image('data:image/png;base64,' + PNG.toString('base64'));
    const b = saveBase64Image(PNG.toString('base64'));
    expect(path.dirname(a)).not.toBe(path.dirname(b));
    expect(a.endsWith('.png')).toBe(true);
    expect(readFileSync(a).equals(PNG)).toBe(true);
    cleanupTempFiles([a, b]);
    expect(existsSync(path.dirname(a))).toBe(false);
    expect(existsSync(path.dirname(b))).toBe(false);
  });

  it('classifies private / loopback addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.37', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', '0.0.0.0'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '104.21.44.165', '2606:4700::1'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('blocks SSRF to the proxy itself and to LAN / metadata hosts', async () => {
    for (const u of ['http://127.0.0.1:3456/config', 'http://localhost:3456/config', 'http://192.168.1.37:3456/x', 'http://169.254.169.254/latest', 'http://[::1]:3456/', 'file:///etc/passwd'])
      await expect(fetchImageToTmp(u), u).rejects.toThrow(/nội bộ|http/);
  });
});

import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { logger } from './logger.js';

const VISION_TMP_DIR = '/tmp/claude-vision';
mkdirSync(VISION_TMP_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface ImageCacheConfig {
  ttlSeconds: number;
  maxEntries: number;
}

// Kept for config compatibility. The shared content-hash cache was removed:
// it made different requests (and users) share one temp file, so a request's
// cleanup could delete a file another request was still reading.
export function configureImageCache(_cfg: ImageCacheConfig): void {
  /* no-op */
}

function pickExt(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase()] ?? 'jpg';
}

/** Detect the real image type from magic bytes; null if not an image. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Write one image into its OWN random directory. The model's Read permission
 * is scoped to that directory, so a request can never read another request's
 * images or any other host file. Non-image bytes are rejected (stops feeding
 * arbitrary files/JSON to the model as "images").
 */
function writeImage(buf: Buffer, _mimeHint: string): string {
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${buf.length} bytes, max ${MAX_IMAGE_BYTES})`);
  }
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error('unsupported image format (expected PNG, JPEG, GIF or WebP)');
  const dir = mkdtempSync(path.join(VISION_TMP_DIR, 'req-'));
  const fp = path.join(dir, `${randomUUID()}.${pickExt(mime)}`);
  writeFileSync(fp, buf, { mode: 0o600 });
  return fp;
}

export function saveBase64Image(dataUrlOrB64: string, mimeHint?: string): string {
  let mime = mimeHint ?? 'image/jpeg';
  let b64 = dataUrlOrB64;
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrlOrB64);
  if (m) {
    mime = m[1];
    b64 = m[2];
  }
  return writeImage(Buffer.from(b64, 'base64'), mime);
}

/** Loopback, private, link-local, CGNAT, multicast/reserved (v4 + v6). */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIPv6(ip) && ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || a >= 224;
  }
  const x = v.toLowerCase();
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('ff');
}

const MAX_FETCH_BYTES = MAX_IMAGE_BYTES;

/**
 * Download an image_url server-side. SSRF guard: only http(s), every resolved
 * address must be public (blocks 127.0.0.1 — where the proxy itself trusts
 * localhost — and LAN/cloud-metadata hosts), redirects are not followed, and
 * the body must really be an image.
 */
export async function fetchImageToTmp(url: string): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('invalid image url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('image url must be http(s)');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error('image url host is not allowed');
  const resp = await fetch(u, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!resp.ok) throw new Error(`fetch image failed: HTTP ${resp.status}`);
  const len = Number(resp.headers.get('content-length') ?? 0);
  if (len > MAX_FETCH_BYTES) throw new Error('image too large');
  const buf = Buffer.from(await resp.arrayBuffer());
  return writeImage(buf, (resp.headers.get('content-type') ?? '').split(';')[0]);
}

export function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      const dir = path.dirname(p);
      // Only ever remove our own per-request dirs.
      if (path.dirname(dir) === VISION_TMP_DIR && path.basename(dir).startsWith('req-')) rmSync(dir, { recursive: true, force: true });
      else rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Periodic cleanup of vision tmp dir. Entries older than 1h are removed. */
export function startVisionDirSweeper(): NodeJS.Timeout {
  const t = setInterval(() => {
    try {
      const now = Date.now();
      for (const f of readdirSync(VISION_TMP_DIR)) {
        const fp = path.join(VISION_TMP_DIR, f);
        try {
          if (now - statSync(fp).mtimeMs > 60 * 60 * 1000) rmSync(fp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'vision sweep failed');
    }
  }, 10 * 60 * 1000);
  t.unref();
  return t;
}

export { VISION_TMP_DIR };

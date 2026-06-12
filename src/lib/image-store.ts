import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { TtlLruCache } from './lru-cache.js';

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

let hashCache: TtlLruCache<string> | null = null;

export function configureImageCache(cfg: ImageCacheConfig): void {
  hashCache = new TtlLruCache<string>(cfg.maxEntries, cfg.ttlSeconds * 1000);
}

function hashBuffer(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

function pickExt(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase()] ?? 'jpg';
}

function writeImage(buf: Buffer, mime: string): string {
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${buf.length} bytes, max ${MAX_IMAGE_BYTES})`);
  }
  const hash = hashBuffer(buf);
  if (hashCache) {
    const cached = hashCache.get(hash);
    if (cached) {
      try {
        statSync(cached);
        return cached;
      } catch {
        hashCache.delete(hash);
      }
    }
  }
  const ext = pickExt(mime);
  const name = `vision-${Date.now()}-${hash.slice(0, 8)}.${ext}`;
  const fp = path.join(VISION_TMP_DIR, name);
  writeFileSync(fp, buf);
  if (hashCache) hashCache.set(hash, fp);
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

export async function fetchImageToTmp(url: string): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`fetch image failed: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const mime = (resp.headers.get('content-type') ?? '').split(';')[0].toLowerCase();
  const ext = MIME_TO_EXT[mime] ?? path.extname(new URL(url).pathname).slice(1) ?? 'jpg';
  return writeImage(buf, ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
}

export function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/** Periodic cleanup of vision tmp dir. Files older than 1h are removed. */
export function startVisionDirSweeper(): NodeJS.Timeout {
  const t = setInterval(() => {
    try {
      const now = Date.now();
      for (const f of readdirSync(VISION_TMP_DIR)) {
        const fp = path.join(VISION_TMP_DIR, f);
        try {
          const s = statSync(fp);
          if (now - s.mtimeMs > 60 * 60 * 1000) unlinkSync(fp);
        } catch {
          /* ignore */
        }
      }
      if (hashCache) hashCache.sweep();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'vision sweep failed');
    }
  }, 10 * 60 * 1000);
  t.unref?.();
  return t;
}

export { VISION_TMP_DIR };

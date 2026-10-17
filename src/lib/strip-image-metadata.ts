/**
 * Drop metadata from generated images before returning them: PNG ancillary chunks
 * (caBX/C2PA, tEXt/zTXt/iTXt XMP, eXIf, tIME…) and JPEG APP1/APP11/APP13/COM
 * segments. Pixel data is copied untouched, so the decoded image is identical.
 * Unknown formats and malformed input are returned as-is.
 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'PLTE']);
const JPEG_DROP = new Set([0xe1, 0xeb, 0xed, 0xfe]);

function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [PNG_SIG];
  let i = 8;
  let ended = false;
  while (i + 8 <= b.length) {
    const n = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + n;
    if (end > b.length) return b; // truncated: leave untouched
    const critical = type[0] >= 'A' && type[0] <= 'Z';
    if (critical || PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  return ended ? Buffer.concat(out) : b; // no IEND = not a complete PNG: leave untouched
}

function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda) break; // start of scan: rest is image data
    const end = i + 2 + b.readUInt16BE(i + 2);
    if (end > b.length) return b;
    if (!JPEG_DROP.has(m)) out.push(b.subarray(i, end));
    i = end;
  }
  out.push(b.subarray(i));
  return Buffer.concat(out);
}

export function stripImageMetadata(buf: Buffer): Buffer {
  if (buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIG)) return stripPng(buf);
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return stripJpeg(buf);
  return buf;
}

/** Same for a base64 string or data URI; keeps the data-URI prefix if present. */
export function stripImageMetadataB64(s: string): string {
  const m = /^(data:[^;]+;base64,)/.exec(s);
  const prefix = m ? m[1] : '';
  try {
    const raw = Buffer.from(s.slice(prefix.length), 'base64');
    return prefix + stripImageMetadata(raw).toString('base64');
  } catch {
    return s;
  }
}

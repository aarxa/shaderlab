// Thumbnail uploads come from browsers, so they're untrusted bytes. We never trust the declared
// Content-Type: we read the format from the file's own header ("magic bytes"), parse its pixel
// size, and only store PNG, JPEG, or WebP within the limits below. When served back, the stored type
// plus `nosniff` and a locked-down CSP mean a file can't be passed off as HTML or script.

export const THUMB_MAX_BYTES = 150 * 1024;
export const THUMB_MAX_SIDE = 640;
export const THUMB_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const;
export type ThumbType = (typeof THUMB_TYPES)[number];

export interface ImageInfo {
  type: ThumbType;
  width: number;
  height: number;
}

const ascii = (b: Uint8Array, at: number, s: string) =>
  b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);

/** Identifies a PNG, JPEG, or WebP and reads its dimensions. Null if it's anything else or malformed. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  // PNG: 8-byte signature, then the IHDR chunk with width and height as big-endian u32.
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n') && ascii(b, 12, 'IHDR')) {
    return { type: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  // JPEG: starts FF D8; the size is in the first "start of frame" segment, so walk the segments.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; } // padding
      const len = u16be(b, i + 2);
      // SOF0..SOF15, except C4 (Huffman tables), C8 (reserved), CC (arithmetic coding tables).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  // WebP: a RIFF container with "WEBP", then one of three chunk kinds that store the size differently.
  if (b.length >= 30 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    if (ascii(b, 12, 'VP8 ')) return { type: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (ascii(b, 12, 'VP8L')) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(b, 12, 'VP8X')) return { type: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

/** Why an upload is refused, or null if it's acceptable. */
export function checkThumbnail(b: Uint8Array): { error: string } | { info: ImageInfo } {
  if (b.length === 0) return { error: 'empty' };
  if (b.length > THUMB_MAX_BYTES) return { error: 'too large' };
  const info = sniffImage(b);
  if (!info) return { error: 'not a PNG, JPEG, or WebP image' };
  if (!info.width || !info.height || info.width > THUMB_MAX_SIDE || info.height > THUMB_MAX_SIDE) {
    return { error: `image must be at most ${THUMB_MAX_SIDE}x${THUMB_MAX_SIDE}` };
  }
  return { info };
}

/**
 * At most one stored write per shader per interval. Several people editing together would each
 * upload; this keeps the database write rate bounded no matter how many clients (or scripts) try.
 */
export class WriteLimiter {
  private last = new Map<string, number>();
  constructor(private intervalMs: number) {}
  /** Milliseconds until this key may write again; 0 means allowed now (and records the write). */
  take(key: string, now = Date.now()): number {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.intervalMs) return this.intervalMs - (now - prev);
    this.last.set(key, now);
    // Forget old entries so the map can't grow without limit.
    if (this.last.size > 10_000) for (const [k, t] of this.last) if (now - t >= this.intervalMs) this.last.delete(k);
    return 0;
  }
}

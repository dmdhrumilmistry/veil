/** Byte/encoding helpers. All binary data is Uint8Array; never strings. */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Length-prefixed concatenation so field boundaries are unambiguous in transcripts. */
export function lpConcat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const framed: Uint8Array[] = [];
  for (const p of parts) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, p.length);
    framed.push(len, p);
  }
  return concat(...framed);
}

export function toB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison for equal-length secrets/tags. */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function randomId(): string {
  return toB64u(randomBytes(16));
}

/** Best-effort zeroization of key material held in JS memory. */
export function wipe(...arrs: (Uint8Array | undefined)[]): void {
  for (const a of arrs) a?.fill(0);
}

import { fromB64u, fromUtf8, toB64u, utf8 } from '../crypto/encoding';

/**
 * Out-of-band signaling. There is no signaling server: the SDP offer/answer travels
 * as a compact code (link, QR, or copy-paste) through any channel the users choose.
 *
 * The code also carries the sender's identity key, so if the channel is trusted
 * (e.g. scanning a QR in person) the handshake is pinned to that identity and a
 * man-in-the-middle is impossible even before safety numbers are compared.
 *
 * Codes are deflate-compressed JSON in base64url. Nothing in them is secret on its
 * own (ICE credentials are single-use and the DTLS certificate is ephemeral), but
 * they do reveal network addresses, so share them only with the intended person.
 */

export type SignalKind = 'offer' | 'answer';

export interface Signal {
  v: 1;
  k: SignalKind;
  sdp: string;
  /** Sender identity public key (base64url). */
  id: string;
  /** Sender display name hint (untrusted, shown only as a suggestion). */
  name: string;
  /** Random id tying an answer to the offer it replies to. */
  ref: string;
}

const PREFIX = 'VEIL1';
const MAX_DECOMPRESSED = 32 * 1024;
const MAX_CODE = 24 * 1024;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  let total = 0;
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(stream).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error('code too large');
    }
    out.push(value);
  }
  const res = new Uint8Array(total);
  let off = 0;
  for (const c of out) {
    res.set(c, off);
    off += c.length;
  }
  return res;
}

export async function encodeSignal(s: Signal): Promise<string> {
  const packed = await pipe(utf8(JSON.stringify(s)), new CompressionStream('deflate-raw'));
  return `${PREFIX}${s.k === 'offer' ? 'O' : 'A'}.${toB64u(packed)}`;
}

/** Extracts a code from raw text, a full invite link, or a link fragment. */
export function extractCode(text: string): string | undefined {
  const m = text.match(/VEIL1[OA]\.[A-Za-z0-9_-]+/);
  return m?.[0];
}

export async function decodeSignal(text: string): Promise<Signal> {
  const code = extractCode(text.trim());
  if (!code || code.length > MAX_CODE) throw new Error('That does not look like a Veil code');
  const body = code.slice(PREFIX.length + 2);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(await pipe(fromB64u(body), new DecompressionStream('deflate-raw'), MAX_DECOMPRESSED)));
  } catch {
    throw new Error('This code is damaged or incomplete - copy it again');
  }
  const s = parsed as Partial<Signal>;
  if (
    s.v !== 1 ||
    (s.k !== 'offer' && s.k !== 'answer') ||
    typeof s.sdp !== 'string' ||
    typeof s.id !== 'string' ||
    fromB64u(s.id).length !== 32 ||
    typeof s.ref !== 'string' ||
    s.ref.length > 64
  ) {
    throw new Error('Unsupported or invalid Veil code');
  }
  const kindFromPrefix = code[PREFIX.length] === 'O' ? 'offer' : 'answer';
  if (kindFromPrefix !== s.k) throw new Error('Invalid Veil code');
  return { v: 1, k: s.k, sdp: s.sdp, id: s.id, ref: s.ref, name: typeof s.name === 'string' ? s.name.slice(0, 48) : '' };
}

/** Shareable link. The code is in the URL fragment, which browsers never send to servers. */
export function signalLink(code: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = code;
  return url.toString();
}

/** Parses the DTLS certificate fingerprint from an SDP blob. */
export function sdpFingerprint(sdp: string): string {
  const fps = [...sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm)].map((m) => `${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`);
  const unique = [...new Set(fps)];
  if (unique.length !== 1) throw new Error('SDP must contain exactly one DTLS fingerprint');
  return unique[0]!;
}

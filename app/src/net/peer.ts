import type { Settings } from '../storage/repo';

/**
 * RTCPeerConnection setup. Two pre-negotiated data channels share one DTLS/SCTP
 * association:
 *   - ctrl (id 0): chat, receipts, file control - small and latency sensitive
 *   - bulk (id 1): file chunks - so a large transfer never delays a chat message
 * Pre-negotiation avoids an extra round trip and keeps the SDP identical in shape.
 */

export interface PeerLink {
  pc: RTCPeerConnection;
  ctrl: RTCDataChannel;
  bulk: RTCDataChannel;
}

export function iceServers(s: Settings): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  if (s.useStun) {
    const urls = s.stunUrls.map((u) => u.trim()).filter((u) => /^stuns?:/.test(u));
    if (urls.length) servers.push({ urls });
  }
  if (s.turnUrl.trim()) {
    servers.push({ urls: s.turnUrl.trim(), username: s.turnUser, credential: s.turnPass });
  }
  return servers;
}

export function createPeer(settings: Settings): PeerLink {
  const pc = new RTCPeerConnection({
    iceServers: iceServers(settings),
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });
  const ctrl = pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
  const bulk = pc.createDataChannel('bulk', { negotiated: true, id: 1, ordered: true });
  ctrl.binaryType = 'arraybuffer';
  bulk.binaryType = 'arraybuffer';
  return { pc, ctrl, bulk };
}

/**
 * Without a signaling server we cannot trickle ICE candidates, so wait for gathering
 * to finish (or a timeout) and ship one complete description.
 */
export function gatherComplete(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export async function makeOffer(link: PeerLink): Promise<string> {
  await link.pc.setLocalDescription(await link.pc.createOffer());
  await gatherComplete(link.pc);
  return link.pc.localDescription!.sdp;
}

export async function acceptOffer(link: PeerLink, offerSdp: string): Promise<string> {
  await link.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  await link.pc.setLocalDescription(await link.pc.createAnswer());
  await gatherComplete(link.pc);
  return link.pc.localDescription!.sdp;
}

export async function acceptAnswer(link: PeerLink, answerSdp: string): Promise<void> {
  await link.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
}

/** Largest safe payload for a single data channel message. */
export function maxMessageSize(pc: RTCPeerConnection): number {
  const m = pc.sctp?.maxMessageSize ?? 65536;
  return Math.min(m || 65536, 256 * 1024);
}

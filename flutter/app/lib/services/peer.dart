import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'models.dart';

/// RTCPeerConnection with the same two pre-negotiated data channels as the web app:
/// ctrl (id 0) for chat/control, bulk (id 1) for file data.
class PeerLink {
  final RTCPeerConnection pc;
  final RTCDataChannel ctrl;
  final RTCDataChannel bulk;
  PeerLink(this.pc, this.ctrl, this.bulk);

  Future<void> close() async {
    try {
      await ctrl.close();
      await bulk.close();
      await pc.close();
    } catch (_) {}
  }
}

List<Map<String, Object>> iceServers(Settings s) => [
      if (s.useStun) {'urls': s.stunUrls.where((u) => u.startsWith('stun:') || u.startsWith('stuns:')).toList()},
      if (s.turnUrl.trim().isNotEmpty) {'urls': s.turnUrl.trim(), 'username': s.turnUser, 'credential': s.turnPass},
    ];

Future<PeerLink> createPeer(Settings s) async {
  final pc = await createPeerConnection({'iceServers': iceServers(s), 'bundlePolicy': 'max-bundle', 'rtcpMuxPolicy': 'require', 'sdpSemantics': 'unified-plan'});
  RTCDataChannelInit init(int id) => RTCDataChannelInit()
    ..negotiated = true
    ..id = id
    ..ordered = true
    ..binaryType = 'binary';
  final ctrl = await pc.createDataChannel('ctrl', init(0));
  final bulk = await pc.createDataChannel('bulk', init(1));
  return PeerLink(pc, ctrl, bulk);
}

/// No signaling server, so wait for ICE gathering (or a timeout) and ship one description.
Future<String> _gathered(RTCPeerConnection pc) async {
  final done = Completer<void>();
  pc.onIceGatheringState = (s) {
    if (s == RTCIceGatheringState.RTCIceGatheringStateComplete && !done.isCompleted) done.complete();
  };
  await done.future.timeout(const Duration(seconds: 4), onTimeout: () {});
  return (await pc.getLocalDescription())!.sdp!;
}

Future<String> makeOffer(PeerLink l) async {
  await l.pc.setLocalDescription(await l.pc.createOffer());
  return _gathered(l.pc);
}

Future<String> acceptOffer(PeerLink l, String sdp) async {
  await l.pc.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
  await l.pc.setLocalDescription(await l.pc.createAnswer());
  return _gathered(l.pc);
}

Future<void> acceptAnswer(PeerLink l, String sdp) => l.pc.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));

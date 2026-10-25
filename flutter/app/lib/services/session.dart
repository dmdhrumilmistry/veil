import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:veil_core/veil_core.dart';

import 'peer.dart';

/// Authenticated, end-to-end encrypted live session (mirrors app/src/net/session.ts).
/// Handshake messages are JSON text on ctrl; after that every frame is binary:
///   seq(8) || AES-256-GCM(message key, plaintext)
class Session {
  final PeerLink link;
  final Role role;
  final void Function(Uint8List peer, Uint8List asyncRoot) onReady;
  final void Function(Map<String, Object?> msg) onMessage;
  final void Function(String reason) onClosed;

  late final Handshake _hs;
  SendChain? _tx;
  RecvChain? _rx;
  String? closedReason;
  Uint8List? peer;
  Future<void> _rxQueue = Future.value();
  Future<void> _txQueue = Future.value();
  Timer? _timer;

  Session(this.link, this.role, Identity identity, Uint8List? expectedPeer, {required this.onReady, required this.onMessage, required this.onClosed, required String localSdp, required String remoteSdp}) {
    _hs = Handshake(role: role, identity: identity, localFingerprint: sdpFingerprint(localSdp), remoteFingerprint: sdpFingerprint(remoteSdp), expectedPeer: expectedPeer);
    link.ctrl.onMessage = (m) => _rxQueue = _rxQueue.then((_) => _onCtrl(m)).catchError((Object e) => _fail(e));
    // File transfer over the bulk channel is not implemented in this app yet: ignore.
    link.bulk.onMessage = (_) {};
    link.pc.onConnectionState = (s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) close('Connection lost');
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) close('Connection closed');
    };
    _timer = Timer(const Duration(seconds: 20), () => close('Secure handshake timed out'));
    link.ctrl.onDataChannelState = (s) {
      if (s == RTCDataChannelState.RTCDataChannelOpen) _begin();
      if (s == RTCDataChannelState.RTCDataChannelClosed) close('Connection closed');
    };
    if (link.ctrl.state == RTCDataChannelState.RTCDataChannelOpen) _begin();
  }

  bool get isReady => _tx != null && closedReason == null;

  bool _begun = false;
  Future<void> _begin() async {
    if (_begun || role != Role.initiator) return;
    _begun = true;
    try {
      await link.ctrl.send(RTCDataChannelMessage(jsonEncode(await _hs.start())));
    } catch (e) {
      _fail(e);
    }
  }

  Future<void> _onCtrl(RTCDataChannelMessage m) async {
    if (closedReason != null) return;
    if (_tx == null) {
      if (m.isBinary || m.text.length > 16 * 1024) throw const ChainError('unexpected frame before handshake');
      final r = await _hs.receive(jsonDecode(m.text));
      if (r.reply != null) await link.ctrl.send(RTCDataChannelMessage(jsonEncode(r.reply)));
      final k = r.keys;
      if (k != null) {
        _timer?.cancel();
        _tx = SendChain(k.ctrlSend, 'veil/v1/ctrl');
        _rx = RecvChain(k.ctrlRecv, 'veil/v1/ctrl');
        peer = k.peerIdentity;
        onReady(k.peerIdentity, k.asyncRoot);
      }
      return;
    }
    if (!m.isBinary || m.binary.length > 256 * 1024) throw const ChainError('invalid frame');
    final msg = jsonDecode(utf8.decode(await _rx!.open(m.binary)));
    if (msg is! Map || msg['t'] is! String) throw const FormatException('invalid message');
    onMessage(msg.cast());
  }

  Future<void> send(Map<String, Object?> msg) {
    final f = _txQueue.then((_) async {
      if (!isReady) throw StateError('not connected');
      await link.ctrl.send(RTCDataChannelMessage.fromBinary(await _tx!.seal(utf8.encode(jsonEncode(msg)))));
    });
    _txQueue = f.catchError((_) {});
    return f;
  }

  void _fail(Object e) => close(e is ChainError ? 'Security check failed - connection closed' : '$e');

  void close([String reason = 'Disconnected']) {
    if (closedReason != null) return;
    closedReason = reason;
    _timer?.cancel();
    _tx?.destroy();
    _rx?.destroy();
    link.close();
    onClosed(reason);
  }
}

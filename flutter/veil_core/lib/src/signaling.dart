import 'dart:convert';

import 'compress.dart';
import 'encoding.dart';

/// One-time connection codes for peer-to-peer-only mode (mirrors app/src/net/signaling.ts):
///   VEIL1O.<b64u(deflate(JSON{ v:1, k:"offer", sdp, id, name, ref }))>   and VEIL1A. for answers
class Signal {
  final String kind; // 'offer' | 'answer'
  final String sdp, id, name, ref;
  Signal({required this.kind, required this.sdp, required this.id, required this.name, required this.ref});
  Map<String, Object> toJson() => {'v': 1, 'k': kind, 'sdp': sdp, 'id': id, 'name': name, 'ref': ref};
}

String? extractCode(String text) => RegExp(r'VEIL1[OA]\.[A-Za-z0-9_-]+').firstMatch(text)?.group(0);

String encodeSignal(Signal s) => 'VEIL1${s.kind == 'offer' ? 'O' : 'A'}.${toB64u(deflateRaw(utf8.encode(jsonEncode(s.toJson()))))}';

Signal decodeSignal(String text) {
  final code = extractCode(text.trim());
  if (code == null || code.length > 24 * 1024) throw const FormatException('That does not look like a Veil code');
  final Map<String, Object?> s;
  try {
    s = (jsonDecode(utf8.decode(inflateRaw(fromB64u(code.substring(7))))) as Map).cast();
  } catch (_) {
    throw const FormatException('This code is damaged or incomplete - copy it again');
  }
  final k = s['k'];
  final id = s['id'];
  if (s['v'] != 1 || (k != 'offer' && k != 'answer') || s['sdp'] is! String || id is! String || fromB64u(id).length != 32 || s['ref'] is! String || (s['ref'] as String).length > 64) {
    throw const FormatException('Unsupported or invalid Veil code');
  }
  if ((code[5] == 'O' ? 'offer' : 'answer') != k) throw const FormatException('Invalid Veil code');
  final name = s['name'] is String ? s['name'] as String : '';
  return Signal(kind: k as String, sdp: s['sdp'] as String, id: id, name: name.length > 48 ? name.substring(0, 48) : name, ref: s['ref'] as String);
}

/// The single DTLS certificate fingerprint in an SDP, normalised like the web app.
String sdpFingerprint(String sdp) {
  final fps = RegExp(r'^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$', multiLine: true)
      .allMatches(sdp)
      .map((m) => '${m.group(1)!.toLowerCase()} ${m.group(2)!.toUpperCase()}')
      .toSet();
  if (fps.length != 1) throw const FormatException('SDP must contain exactly one DTLS fingerprint');
  return fps.first;
}

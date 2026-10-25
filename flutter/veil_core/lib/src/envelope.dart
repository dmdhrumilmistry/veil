import 'dart:typed_data';

import 'encoding.dart';
import 'primitives.dart';

/// Padded offline-message envelope (mirrors app/src/net/mailbox.ts):
///   envelope = iv(12) || AES-256-GCM(envKey, iv, pad(u32 len || payload), aad)
const _buckets = [1024, 4096, 16384, 49152];
final _aad = utf8Bytes('veil/v1/mailbox/envelope');

Uint8List _pad(List<int> data) {
  final need = data.length + 4;
  final size = _buckets.firstWhere((b) => b >= need + 28, orElse: () => -1);
  if (size < 0) throw ArgumentError('message too large for the mailbox');
  final out = Uint8List(size - 28);
  out.setAll(0, u32(data.length));
  out.setAll(4, data);
  return out;
}

Uint8List _unpad(List<int> p) {
  final len = readU32(p);
  if (len > p.length - 4) throw const FormatException('bad padding');
  return Uint8List.fromList(p.sublist(4, 4 + len));
}

Future<Uint8List> sealEnvelope(List<int> envKey, List<int> message) async {
  final iv = randomBytes(12);
  return concat([iv, await aesGcmEncrypt(envKey, iv, _pad(message), _aad)]);
}

/// Null when the envelope was not made with this key.
Future<Uint8List?> openEnvelope(List<int> envKey, List<int> envelope) async {
  if (envelope.length < 12 + 16 + 4) return null;
  try {
    return _unpad(await aesGcmDecrypt(envKey, envelope.sublist(0, 12), envelope.sublist(12), _aad));
  } on CryptoFailure {
    return null;
  } on FormatException {
    return null;
  }
}

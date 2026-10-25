import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

/// Byte helpers. Mirrors app/src/crypto/encoding.ts.

final _rng = Random.secure();

Uint8List utf8Bytes(String s) => Uint8List.fromList(utf8.encode(s));
String fromUtf8(List<int> b) => utf8.decode(b);

Uint8List concat(List<List<int>> parts) {
  final out = BytesBuilder(copy: false);
  for (final p in parts) {
    out.add(p);
  }
  return out.toBytes();
}

/// Length-prefixed concatenation (u32 big-endian lengths), as used in transcripts.
Uint8List lpConcat(List<List<int>> parts) {
  final out = BytesBuilder(copy: false);
  for (final p in parts) {
    final len = ByteData(4)..setUint32(0, p.length);
    out.add(len.buffer.asUint8List());
    out.add(p);
  }
  return out.toBytes();
}

String toB64u(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

Uint8List fromB64u(String s) {
  if (!RegExp(r'^[A-Za-z0-9_-]*$').hasMatch(s)) throw const FormatException('invalid base64url');
  return base64Url.decode(s.padRight((s.length + 3) ~/ 4 * 4, '='));
}

String toHex(List<int> bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

Uint8List fromHex(String hex) {
  if (hex.length.isOdd || !RegExp(r'^[0-9a-fA-F]*$').hasMatch(hex)) throw const FormatException('invalid hex');
  return Uint8List.fromList([for (var i = 0; i < hex.length; i += 2) int.parse(hex.substring(i, i + 2), radix: 16)]);
}

/// Constant-time comparison for equal-length secrets.
bool ctEqual(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}

Uint8List randomBytes(int n) => Uint8List.fromList(List<int>.generate(n, (_) => _rng.nextInt(256)));

String randomId() => toB64u(randomBytes(16));

/// Best-effort zeroization.
void wipe(List<int>? b) {
  if (b == null) return;
  for (var i = 0; i < b.length; i++) {
    b[i] = 0;
  }
}

Uint8List u32(int n) => (ByteData(4)..setUint32(0, n)).buffer.asUint8List();
Uint8List u64(int n) => (ByteData(8)..setUint64(0, n)).buffer.asUint8List();
int readU32(List<int> b, [int offset = 0]) => ByteData.sublistView(Uint8List.fromList(b.sublist(offset, offset + 4))).getUint32(0);
int readU64(List<int> b, [int offset = 0]) => ByteData.sublistView(Uint8List.fromList(b.sublist(offset, offset + 8))).getUint64(0);

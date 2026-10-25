import 'dart:typed_data';

import 'package:cryptography/cryptography.dart' show Sha512;

import 'encoding.dart';
import 'primitives.dart';

/// Long-term device identity (Ed25519). Mirrors app/src/crypto/identity.ts.
class Identity {
  final Uint8List pub;
  final Uint8List seed;
  Identity(this.pub, this.seed);

  String get id => toB64u(pub);

  static Future<Identity> generate() => fromSeed(randomBytes(32));

  static Future<Identity> fromSeed(List<int> seed) async {
    final kp = await ed25519FromSeed(seed);
    return Identity(kp.pub, kp.seed);
  }

  /// Interop with the web app's stored/backed-up identity (PKCS#8).
  static Future<Identity> fromPkcs8(List<int> pkcs8) => fromSeed(seedFromPkcs8(pkcs8, ed25519: true));
  Uint8List toPkcs8() => pkcs8FromSeed(seed, ed25519: true);

  Future<Uint8List> sign(List<int> message) => ed25519Sign(seed, message);
}

const _iterations = 5200;
final _sha512 = Sha512().toSync();

String _fingerprintDigits(List<int> pub) {
  var h = _sha512.hashSync(concat([
    [0, 1],
    pub,
    utf8Bytes('veil/safety-number'),
  ])).bytes;
  for (var i = 0; i < _iterations; i++) {
    h = _sha512.hashSync(concat([h, pub])).bytes;
  }
  final out = StringBuffer();
  for (var i = 0; i < 30; i += 5) {
    var n = 0;
    for (var j = 0; j < 5; j++) {
      n = n * 256 + h[i + j];
    }
    out.write((n % 100000).toString().padLeft(5, '0'));
  }
  return out.toString();
}

int _cmp(List<int> a, List<int> b) {
  for (var i = 0; i < a.length && i < b.length; i++) {
    if (a[i] != b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/// 60-digit safety number shared by both parties (order independent).
String safetyNumber(List<int> a, List<int> b) {
  final (x, y) = _cmp(a, b) <= 0 ? (a, b) : (b, a);
  return _fingerprintDigits(x) + _fingerprintDigits(y);
}

List<String> formatSafetyNumber(String n) => [for (var i = 0; i + 5 <= n.length; i += 5) n.substring(i, i + 5)];

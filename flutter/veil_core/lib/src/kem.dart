import 'dart:typed_data';

import 'package:pqcrypto/pqcrypto.dart';

/// ML-KEM-768 (FIPS 203) via package:pqcrypto. Verified against the web app's
/// @noble/post-quantum output in protocol/vectors.json.
class MlKem768 {
  static const publicKeyLength = 1184;
  static const secretKeyLength = 2400;
  static const ciphertextLength = 1088;

  /// Deterministic when [seed] (d || z, 64 bytes) is given.
  static ({Uint8List publicKey, Uint8List secretKey}) keygen([Uint8List? seed]) {
    final (a, b) = PqcKem.kyber768.generateKeyPair(seed);
    // Order is not documented; tell them apart by their fixed sizes.
    final pk = a.length == publicKeyLength ? a : b;
    final sk = a.length == publicKeyLength ? b : a;
    if (pk.length != publicKeyLength || sk.length != secretKeyLength) throw StateError('unexpected ML-KEM key sizes');
    return (publicKey: pk, secretKey: sk);
  }

  /// Deterministic when [m] (32 bytes) is given.
  static ({Uint8List cipherText, Uint8List sharedSecret}) encapsulate(Uint8List publicKey, [Uint8List? m]) {
    final (ct, ss) = PqcKem.kyber768.encapsulate(publicKey, m);
    return (cipherText: ct, sharedSecret: ss);
  }

  static Uint8List decapsulate(Uint8List cipherText, Uint8List secretKey) => PqcKem.kyber768.decapsulate(secretKey, cipherText);
}

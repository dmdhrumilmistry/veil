import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

import 'encoding.dart';

/// Every primitive Veil uses, in one place (mirrors app/src/crypto/primitives.ts).
/// AES-GCM output format matches WebCrypto: ciphertext || 16-byte tag.

final _sha256 = Sha256();
final _sha512 = Sha512();
final _x25519 = X25519();
final _ed25519 = Ed25519();
final _aes = AesGcm.with256bits(nonceLength: 12);

class CryptoFailure implements Exception {
  final String message;
  const CryptoFailure(this.message);
  @override
  String toString() => 'CryptoFailure: $message';
}

Future<Uint8List> sha256(List<int> data) async => Uint8List.fromList((await _sha256.hash(data)).bytes);
Future<Uint8List> sha512(List<int> data) async => Uint8List.fromList((await _sha512.hash(data)).bytes);

Future<Uint8List> hkdf(List<int> ikm, List<int> salt, List<int> info, int length) async {
  final out = await Hkdf(hmac: Hmac.sha256(), outputLength: length).deriveKey(secretKey: SecretKey(ikm), nonce: salt, info: info);
  return Uint8List.fromList(await out.extractBytes());
}

Future<Uint8List> hmacSha256(List<int> key, List<int> data) async =>
    Uint8List.fromList((await Hmac.sha256().calculateMac(data, secretKey: SecretKey(key))).bytes);

Future<Uint8List> aesGcmEncrypt(List<int> key, List<int> iv, List<int> plaintext, [List<int> aad = const []]) async {
  if (key.length != 32) throw const CryptoFailure('AES-256 key must be 32 bytes');
  final box = await _aes.encrypt(plaintext, secretKey: SecretKey(key), nonce: iv, aad: aad);
  return concat([box.cipherText, box.mac.bytes]);
}

Future<Uint8List> aesGcmDecrypt(List<int> key, List<int> iv, List<int> data, [List<int> aad = const []]) async {
  if (data.length < 16) throw const CryptoFailure('ciphertext too short');
  try {
    final clear = await _aes.decrypt(
      SecretBox(data.sublist(0, data.length - 16), nonce: iv, mac: Mac(data.sublist(data.length - 16))),
      secretKey: SecretKey(key),
      aad: aad,
    );
    return Uint8List.fromList(clear);
  } on SecretBoxAuthenticationError {
    throw const CryptoFailure('authentication failed');
  }
}

// ---- X25519

class X25519Pair {
  final Uint8List priv; // 32-byte private scalar seed
  final Uint8List pub;
  X25519Pair(this.priv, this.pub);
}

Future<X25519Pair> x25519FromSeed(List<int> seed) async {
  final kp = await _x25519.newKeyPairFromSeed(seed);
  return X25519Pair(Uint8List.fromList(seed), Uint8List.fromList((await kp.extractPublicKey()).bytes));
}

Future<X25519Pair> x25519Generate() => x25519FromSeed(randomBytes(32));

Future<Uint8List> x25519(List<int> priv, List<int> peerPub) async {
  if (peerPub.length != 32) throw const CryptoFailure('bad X25519 public key');
  final kp = await _x25519.newKeyPairFromSeed(priv);
  final shared = await _x25519.sharedSecretKey(keyPair: kp, remotePublicKey: SimplePublicKey(peerPub, type: KeyPairType.x25519));
  final out = Uint8List.fromList(await shared.extractBytes());
  if (out.every((b) => b == 0)) throw const CryptoFailure('X25519 produced all-zero secret');
  return out;
}

// ---- Ed25519

class Ed25519Pair {
  final Uint8List seed;
  final Uint8List pub;
  Ed25519Pair(this.seed, this.pub);
}

Future<Ed25519Pair> ed25519FromSeed(List<int> seed) async {
  final kp = await _ed25519.newKeyPairFromSeed(seed);
  return Ed25519Pair(Uint8List.fromList(seed), Uint8List.fromList((await kp.extractPublicKey()).bytes));
}

Future<Uint8List> ed25519Sign(List<int> seed, List<int> message) async {
  final kp = await _ed25519.newKeyPairFromSeed(seed);
  return Uint8List.fromList((await _ed25519.sign(message, keyPair: kp)).bytes);
}

Future<bool> ed25519Verify(List<int> pub, List<int> sig, List<int> message) async {
  if (pub.length != 32 || sig.length != 64) return false;
  try {
    return await _ed25519.verify(message, signature: Signature(sig, publicKey: SimplePublicKey(pub, type: KeyPairType.ed25519)));
  } catch (_) {
    return false;
  }
}

// ---- PKCS#8 interop with WebCrypto (fixed 16-byte prefixes for these curves)

final _edPkcs8 = fromB64u('MC4CAQAwBQYDK2VwBCIEIA');
final _xPkcs8 = fromB64u('MC4CAQAwBQYDK2VuBCIEIA');

Uint8List seedFromPkcs8(List<int> pkcs8, {required bool ed25519}) {
  final prefix = ed25519 ? _edPkcs8 : _xPkcs8;
  if (pkcs8.length != 48 || !ctEqual(pkcs8.sublist(0, 16), prefix)) throw const CryptoFailure('unsupported PKCS#8 key');
  return Uint8List.fromList(pkcs8.sublist(16));
}

Uint8List pkcs8FromSeed(List<int> seed, {required bool ed25519}) => concat([ed25519 ? _edPkcs8 : _xPkcs8, seed]);

// ---- PBKDF2 (passphrases are NFKC-normalised, exactly like the web app)

Future<Uint8List> pbkdf2(String passphrase, List<int> salt, int iterations) async {
  final key = await Pbkdf2(macAlgorithm: Hmac.sha256(), iterations: iterations, bits: 256)
      .deriveKey(secretKey: SecretKey(utf8Bytes(unorm.nfkc(passphrase))), nonce: salt);
  return Uint8List.fromList(await key.extractBytes());
}

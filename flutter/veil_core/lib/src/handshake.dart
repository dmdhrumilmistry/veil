import 'dart:typed_data';

import 'encoding.dart';
import 'identity.dart';
import 'kem.dart';
import 'primitives.dart';

/// Veil handshake v1 (mirrors app/src/crypto/handshake.ts - see that file and
/// docs/ARCHITECTURE.md for the full description).
///
///   I -> R  HELLO  { id_I, eph_I, kem_pk_I, nonce_I }
///   R -> I  HELLO  { id_R, eph_R, kem_ct_R, nonce_R, sig_R }
///   I -> R  FIN    { sig_I }
///
///   T    = SHA-256(lp("veil/v1/handshake", fp_I, fp_R, hello_I..., hello_R...))
///   ss   = X25519(eph_I, eph_R) || ML-KEM-768 shared secret
///   keys = HKDF-SHA-256(ss, salt = T, info = "veil/v1/chains", 160)

const protocolVersion = 1;

enum Role { initiator, responder }

class HandshakeError implements Exception {
  final String message;
  const HandshakeError(this.message);
  @override
  String toString() => 'HandshakeError: $message';
}

class SessionKeys {
  final Uint8List ctrlSend, ctrlRecv, bulkSend, bulkRecv, asyncRoot, peerIdentity, transcript;
  SessionKeys({
    required this.ctrlSend,
    required this.ctrlRecv,
    required this.bulkSend,
    required this.bulkRecv,
    required this.asyncRoot,
    required this.peerIdentity,
    required this.transcript,
  });
}

class HelloI {
  final Uint8List id, eph, kem, n;
  HelloI(this.id, this.eph, this.kem, this.n);
}

class HelloR {
  final Uint8List id, eph, ct, n;
  HelloR(this.id, this.eph, this.ct, this.n);
}

final _label = utf8Bytes('veil/v1/handshake');
final _sigI = utf8Bytes('veil/v1/sig/I');
final _sigR = utf8Bytes('veil/v1/sig/R');
final _info = utf8Bytes('veil/v1/chains');

/// Exported for cross-implementation test vectors.
Future<Uint8List> transcriptHash(List<int> fpI, List<int> fpR, HelloI i, HelloR r) =>
    sha256(lpConcat([_label, fpI, fpR, i.id, i.eph, i.kem, i.n, r.id, r.eph, r.ct, r.n]));

/// [ctrl I->R, ctrl R->I, bulk I->R, bulk R->I, async root].
Future<List<Uint8List>> deriveKeyMaterial(List<int> ss, List<int> transcript) async {
  final okm = await hkdf(ss, transcript, _info, 160);
  final keys = [for (var i = 0; i < 5; i++) Uint8List.fromList(okm.sublist(i * 32, (i + 1) * 32))];
  wipe(okm);
  return keys;
}

Uint8List _b(Object? v, [int? len]) {
  if (v is! String) throw const HandshakeError('malformed handshake field');
  final Uint8List out;
  try {
    out = fromB64u(v);
  } on FormatException {
    throw const HandshakeError('malformed handshake field');
  }
  if (len != null && out.length != len) throw const HandshakeError('bad field length');
  return out;
}

class Handshake {
  final Role role;
  final Identity identity;
  final String localFingerprint;
  final String remoteFingerprint;
  final Uint8List? expectedPeer;

  X25519Pair? _eph;
  ({Uint8List publicKey, Uint8List secretKey})? _kem;
  final Uint8List _nonce = randomBytes(32);
  HelloI? _helloI;
  ({SessionKeys keys, Uint8List transcript, Uint8List peer})? _pending;
  bool _done = false;

  Handshake({required this.role, required this.identity, required this.localFingerprint, required this.remoteFingerprint, this.expectedPeer});

  (Uint8List, Uint8List) _fps() {
    final local = utf8Bytes(localFingerprint.toLowerCase());
    final remote = utf8Bytes(remoteFingerprint.toLowerCase());
    return role == Role.initiator ? (local, remote) : (remote, local);
  }

  void _checkPeer(Uint8List id) {
    if (ctEqual(id, identity.pub)) throw const HandshakeError('peer presented our own identity');
    final exp = expectedPeer;
    if (exp != null && !ctEqual(id, exp)) throw const HandshakeError('peer identity does not match the invite - possible interception');
  }

  /// Initiator: the first message.
  Future<Map<String, Object>> start() async {
    if (role != Role.initiator) throw const HandshakeError('only the initiator starts');
    _eph = await x25519Generate();
    _kem = MlKem768.keygen();
    return {'t': 'hello', 'v': protocolVersion, 'r': 'I', 'id': toB64u(identity.pub), 'eph': toB64u(_eph!.pub), 'kem': toB64u(_kem!.publicKey), 'n': toB64u(_nonce)};
  }

  /// Feed a peer message; returns a reply to send and/or the final keys.
  Future<({Map<String, Object>? reply, SessionKeys? keys})> receive(Object? msg) async {
    if (_done) throw const HandshakeError('handshake already complete');
    if (msg is! Map) throw const HandshakeError('malformed message');
    final m = msg.cast<String, Object?>();
    if (m['t'] == 'hello' && m['v'] != protocolVersion) throw HandshakeError('unsupported protocol version ${m['v']}');
    if (role == Role.responder && m['t'] == 'hello' && m['r'] == 'I' && _helloI == null) return _onHelloI(m);
    if (role == Role.initiator && m['t'] == 'hello' && m['r'] == 'R' && _kem != null && _pending == null) return _onHelloR(m);
    if (role == Role.responder && m['t'] == 'fin' && _pending != null) return _onFin(m);
    throw const HandshakeError('unexpected handshake message');
  }

  Future<SessionKeys> _derive(Uint8List ss, Uint8List transcript, Uint8List peer) async {
    final k = await deriveKeyMaterial(ss, transcript);
    wipe(ss);
    final initiator = role == Role.initiator;
    return SessionKeys(
      ctrlSend: initiator ? k[0] : k[1],
      ctrlRecv: initiator ? k[1] : k[0],
      bulkSend: initiator ? k[2] : k[3],
      bulkRecv: initiator ? k[3] : k[2],
      asyncRoot: k[4],
      peerIdentity: peer,
      transcript: transcript,
    );
  }

  Future<({Map<String, Object>? reply, SessionKeys? keys})> _onHelloI(Map<String, Object?> m) async {
    final i = HelloI(_b(m['id'], 32), _b(m['eph'], 32), _b(m['kem'], MlKem768.publicKeyLength), _b(m['n'], 32));
    _checkPeer(i.id);
    _helloI = i;
    _eph = await x25519Generate();
    final ({Uint8List cipherText, Uint8List sharedSecret}) enc;
    try {
      enc = MlKem768.encapsulate(i.kem);
    } catch (_) {
      throw const HandshakeError('invalid ML-KEM public key');
    }
    final dh = await x25519(_eph!.priv, i.eph);
    final r = HelloR(identity.pub, _eph!.pub, enc.cipherText, _nonce);
    final (fpI, fpR) = _fps();
    final transcript = await transcriptHash(fpI, fpR, i, r);
    final sig = await identity.sign(concat([_sigR, transcript]));
    final keys = await _derive(concat([dh, enc.sharedSecret]), transcript, i.id);
    wipe(dh);
    wipe(enc.sharedSecret);
    // Keys stay pending until the initiator proves its identity.
    _pending = (keys: keys, transcript: transcript, peer: i.id);
    return (
      reply: <String, Object>{'t': 'hello', 'v': protocolVersion, 'r': 'R', 'id': toB64u(r.id), 'eph': toB64u(r.eph), 'ct': toB64u(r.ct), 'n': toB64u(r.n), 'sig': toB64u(sig)},
      keys: null,
    );
  }

  Future<({Map<String, Object>? reply, SessionKeys? keys})> _onHelloR(Map<String, Object?> m) async {
    final r = HelloR(_b(m['id'], 32), _b(m['eph'], 32), _b(m['ct'], MlKem768.ciphertextLength), _b(m['n'], 32));
    final sigR = _b(m['sig'], 64);
    _checkPeer(r.id);
    final i = HelloI(identity.pub, _eph!.pub, _kem!.publicKey, _nonce);
    final (fpI, fpR) = _fps();
    final transcript = await transcriptHash(fpI, fpR, i, r);
    if (!await ed25519Verify(r.id, sigR, concat([_sigR, transcript]))) {
      throw const HandshakeError('responder signature invalid - connection may be intercepted');
    }
    final kemSs = MlKem768.decapsulate(r.ct, _kem!.secretKey);
    wipe(_kem!.secretKey);
    final dh = await x25519(_eph!.priv, r.eph);
    final keys = await _derive(concat([dh, kemSs]), transcript, r.id);
    wipe(dh);
    wipe(kemSs);
    final sig = await identity.sign(concat([_sigI, transcript]));
    _done = true;
    _pending = (keys: keys, transcript: transcript, peer: r.id);
    return (reply: <String, Object>{'t': 'fin', 'sig': toB64u(sig)}, keys: keys);
  }

  Future<({Map<String, Object>? reply, SessionKeys? keys})> _onFin(Map<String, Object?> m) async {
    final sig = _b(m['sig'], 64);
    final p = _pending!;
    if (!await ed25519Verify(p.peer, sig, concat([_sigI, p.transcript]))) {
      throw const HandshakeError('initiator signature invalid - connection may be intercepted');
    }
    _done = true;
    return (reply: null, keys: p.keys);
  }
}

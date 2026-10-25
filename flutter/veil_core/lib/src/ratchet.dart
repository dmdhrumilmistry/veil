import 'dart:collection';
import 'dart:typed_data';

import 'encoding.dart';
import 'primitives.dart';

/// Double Ratchet (Signal spec) for offline messages. Mirrors
/// app/src/crypto/ratchet.ts, including the JSON state format, so state and
/// messages are interchangeable between the web and Flutter apps.
///
///   KDF_RK(rk, dh) = HKDF(salt = rk, ikm = dh, "veil/v1/ratchet/rk") -> rk', ck
///   KDF_CK(ck)     = HMAC(ck, 0x01) -> mk, HMAC(ck, 0x02) -> ck'
///   ENCRYPT(mk)    = HKDF(mk, salt = 0^32, "veil/v1/ratchet/mk") -> key(32) || iv(12)
///   header         = dh_pub(32) || pn(u32) || n(u32)  (authenticated as AD)
const maxSkip = 1000;
const _maxStoredSkipped = 2000;
const _headerLen = 40;
final _rkInfo = utf8Bytes('veil/v1/ratchet/rk');
final _mkInfo = utf8Bytes('veil/v1/ratchet/mk');

class RatchetError implements Exception {
  final String message;
  const RatchetError(this.message);
  @override
  String toString() => 'RatchetError: $message';
}

/// X25519 key pair in the web app's interchange format (raw pub + PKCS#8 private).
class DhKeyPair {
  final Uint8List pub;
  final Uint8List pkcs8;
  DhKeyPair(this.pub, this.pkcs8);
  Uint8List get seed => seedFromPkcs8(pkcs8, ed25519: false);
}

Future<DhKeyPair> generateRatchetKey() async {
  final kp = await x25519Generate();
  return DhKeyPair(kp.pub, pkcs8FromSeed(kp.priv, ed25519: false));
}

Future<Uint8List> _dh(DhKeyPair pair, List<int> pub) => x25519(pair.seed, pub);

Future<(Uint8List, Uint8List)> _kdfRk(List<int> rk, Uint8List dhOut) async {
  final out = await hkdf(dhOut, rk, _rkInfo, 64);
  wipe(dhOut);
  return (Uint8List.fromList(out.sublist(0, 32)), Uint8List.fromList(out.sublist(32)));
}

Future<(Uint8List, Uint8List)> _kdfCk(List<int> ck) async => (await hmacSha256(ck, [1]), await hmacSha256(ck, [2]));

Future<(Uint8List, Uint8List)> _messageKey(List<int> mk) async {
  final out = await hkdf(mk, Uint8List(32), _mkInfo, 44);
  return (Uint8List.fromList(out.sublist(0, 32)), Uint8List.fromList(out.sublist(32)));
}

Uint8List _header(List<int> pub, int pn, int n) => concat([pub, u32(pn), u32(n)]);

String _skKey(List<int> pub, int n) => '${toB64u(pub)}:$n';

bool _eq(Uint8List? a, Uint8List? b) => a != null && b != null && ctEqual(a, b);

class _State {
  DhKeyPair dhs;
  Uint8List? dhr;
  Uint8List rk;
  Uint8List? cks;
  Uint8List? ckr;
  int ns, nr, pn;
  LinkedHashMap<String, Uint8List> skipped;
  final Uint8List ad;
  _State({required this.dhs, this.dhr, required this.rk, this.cks, this.ckr, this.ns = 0, this.nr = 0, this.pn = 0, required this.skipped, required this.ad});

  _State clone() => _State(
        dhs: DhKeyPair(Uint8List.fromList(dhs.pub), Uint8List.fromList(dhs.pkcs8)),
        dhr: dhr == null ? null : Uint8List.fromList(dhr!),
        rk: Uint8List.fromList(rk),
        cks: cks == null ? null : Uint8List.fromList(cks!),
        ckr: ckr == null ? null : Uint8List.fromList(ckr!),
        ns: ns,
        nr: nr,
        pn: pn,
        skipped: LinkedHashMap.of(skipped),
        ad: ad,
      );
}

class Ratchet {
  _State _s;
  Ratchet._(this._s);

  static Future<Ratchet> initAlice(List<int> sk, List<int> bobPub, List<int> ad) async {
    final dhs = await generateRatchetKey();
    final (rk, cks) = await _kdfRk(sk, await _dh(dhs, bobPub));
    return Ratchet._(_State(dhs: dhs, dhr: Uint8List.fromList(bobPub), rk: rk, cks: cks, skipped: LinkedHashMap(), ad: Uint8List.fromList(ad)));
  }

  static Ratchet initBob(List<int> sk, DhKeyPair bobPair, List<int> ad) =>
      Ratchet._(_State(dhs: bobPair, rk: Uint8List.fromList(sk), skipped: LinkedHashMap(), ad: Uint8List.fromList(ad)));

  bool get canSend => _s.cks != null;

  Future<Uint8List> encrypt(List<int> plaintext) async {
    final s = _s;
    if (s.cks == null) throw const RatchetError('sending chain not initialised');
    final (mk, ck) = await _kdfCk(s.cks!);
    wipe(s.cks);
    s.cks = ck;
    final h = _header(s.dhs.pub, s.pn, s.ns);
    s.ns++;
    final (key, iv) = await _messageKey(mk);
    wipe(mk);
    return concat([h, await aesGcmEncrypt(key, iv, plaintext, concat([s.ad, h]))]);
  }

  Future<Uint8List> decrypt(List<int> message) async {
    if (message.length < _headerLen + 16) throw const RatchetError('message too short');
    final h = Uint8List.fromList(message.sublist(0, _headerLen));
    final ct = message.sublist(_headerLen);
    final pub = Uint8List.fromList(h.sublist(0, 32));
    final pn = readU32(h, 32);
    final n = readU32(h, 36);
    // Work on a copy; commit only after successful authentication.
    final s = _s.clone();
    final ad = concat([s.ad, h]);

    final skipped = s.skipped[_skKey(pub, n)];
    if (skipped != null) {
      final plain = await _open(skipped, ct, ad);
      s.skipped.remove(_skKey(pub, n));
      _s = s;
      return plain;
    }
    if (!_eq(pub, s.dhr)) {
      await _skip(s, pn);
      s.pn = s.ns;
      s.ns = 0;
      s.nr = 0;
      s.dhr = pub;
      final (rk1, ckr) = await _kdfRk(s.rk, await _dh(s.dhs, pub));
      s.rk = rk1;
      s.ckr = ckr;
      s.dhs = await generateRatchetKey();
      final (rk2, cks) = await _kdfRk(s.rk, await _dh(s.dhs, pub));
      s.rk = rk2;
      s.cks = cks;
    }
    await _skip(s, n);
    if (s.ckr == null) throw const RatchetError('no receiving chain');
    final (mk, ck) = await _kdfCk(s.ckr!);
    s.ckr = ck;
    s.nr++;
    final plain = await _open(mk, ct, ad);
    _s = s;
    return plain;
  }

  Future<Uint8List> _open(List<int> mk, List<int> ct, List<int> ad) async {
    final (key, iv) = await _messageKey(mk);
    try {
      return await aesGcmDecrypt(key, iv, ct, ad);
    } on CryptoFailure {
      throw const RatchetError('message failed authentication');
    }
  }

  Future<void> _skip(_State s, int until) async {
    if (s.ckr == null || until < s.nr) return;
    if (until - s.nr > maxSkip) throw const RatchetError('too many skipped messages');
    while (s.nr < until) {
      final (mk, ck) = await _kdfCk(s.ckr!);
      s.skipped[_skKey(s.dhr!, s.nr)] = mk;
      s.ckr = ck;
      s.nr++;
    }
    while (s.skipped.length > _maxStoredSkipped) {
      s.skipped.remove(s.skipped.keys.first);
    }
  }

  /// Same JSON shape as the web app's RatchetJSON.
  Map<String, Object?> toJson() {
    final s = _s;
    String? b(Uint8List? x) => x == null ? null : toB64u(x);
    return {
      'v': 1,
      'dhs': {'pub': toB64u(s.dhs.pub), 'pkcs8': toB64u(s.dhs.pkcs8)},
      if (s.dhr != null) 'dhr': b(s.dhr),
      'rk': toB64u(s.rk),
      if (s.cks != null) 'cks': b(s.cks),
      if (s.ckr != null) 'ckr': b(s.ckr),
      'ns': s.ns,
      'nr': s.nr,
      'pn': s.pn,
      'skipped': [
        for (final e in s.skipped.entries) [e.key, toB64u(e.value)],
      ],
      'ad': toB64u(s.ad),
    };
  }

  static Ratchet fromJson(Map<String, Object?> j) {
    if (j['v'] != 1) throw const RatchetError('unsupported ratchet state');
    Uint8List? b(Object? x) => x == null ? null : fromB64u(x as String);
    final dhs = (j['dhs'] as Map).cast<String, Object?>();
    return Ratchet._(_State(
      dhs: DhKeyPair(fromB64u(dhs['pub'] as String), fromB64u(dhs['pkcs8'] as String)),
      dhr: b(j['dhr']),
      rk: fromB64u(j['rk'] as String),
      cks: b(j['cks']),
      ckr: b(j['ckr']),
      ns: j['ns'] as int,
      nr: j['nr'] as int,
      pn: j['pn'] as int,
      skipped: LinkedHashMap.fromEntries([
        for (final e in (j['skipped'] as List)) MapEntry((e as List)[0] as String, fromB64u(e[1] as String)),
      ]),
      ad: fromB64u(j['ad'] as String),
    ));
  }
}

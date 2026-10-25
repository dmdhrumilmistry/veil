import 'dart:typed_data';

import 'encoding.dart';
import 'primitives.dart';

/// Symmetric KDF chain for live sessions (mirrors app/src/crypto/chain.ts).
///   mk_n = HMAC(ck_n, 0x01), ck_n+1 = HMAC(ck_n, 0x02)
///   frame = seq(u64) || AES-256-GCM(mk_n, iv = 0^32 || seq, aad = label || seq)
class ChainError implements Exception {
  final String message;
  const ChainError(this.message);
  @override
  String toString() => 'ChainError: $message';
}

abstract class _Chain {
  Uint8List _ck;
  int _seq = 0;
  final Uint8List _label;
  _Chain(List<int> chainKey, String label)
      : _ck = Uint8List.fromList(chainKey),
        _label = utf8Bytes(label) {
    if (chainKey.length != 32) throw const ChainError('chain key must be 32 bytes');
  }

  Future<({Uint8List key, Uint8List iv, Uint8List aad, int seq})> _step() async {
    final mk = await hmacSha256(_ck, [1]);
    final next = await hmacSha256(_ck, [2]);
    wipe(_ck);
    _ck = next;
    final seq = _seq++;
    final s = u64(seq);
    return (key: mk, iv: concat([Uint8List(4), s]), aad: concat([_label, s]), seq: seq);
  }

  void destroy() => wipe(_ck);
}

class SendChain extends _Chain {
  SendChain(super.chainKey, super.label);

  Future<Uint8List> seal(List<int> plaintext) async {
    final st = await _step();
    final ct = await aesGcmEncrypt(st.key, st.iv, plaintext, st.aad);
    wipe(st.key);
    return concat([u64(st.seq), ct]);
  }
}

class RecvChain extends _Chain {
  RecvChain(super.chainKey, super.label);

  Future<Uint8List> open(List<int> frame) async {
    if (frame.length < 8 + 16) throw const ChainError('frame too short');
    final seq = readU64(frame);
    if (seq != _seq) throw ChainError('out-of-order frame: got $seq, want $_seq');
    final st = await _step();
    try {
      return await aesGcmDecrypt(st.key, st.iv, frame.sublist(8), st.aad);
    } on CryptoFailure {
      throw const ChainError('authentication failed');
    } finally {
      wipe(st.key);
    }
  }
}

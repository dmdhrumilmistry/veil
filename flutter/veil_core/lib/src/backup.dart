import 'dart:convert';
import 'dart:typed_data';

import 'encoding.dart';
import 'primitives.dart';

/// `.veilbackup` v1 (mirrors app/src/storage/backup.ts) - backups move freely between
/// the web app and the Flutter app.
///   file   = "VEILBAK\x01" || u32 hlen || header JSON || record*
///   key    = HKDF(PBKDF2(pass, salt, iter), salt = SHA-256(magic||hlen||header), "veil/backup/v1")
///   record = u32 len || iv || AES-256-GCM(key, iv, type || payload, aad = u64 index || final)
final _magic = utf8Bytes('VEILBAK\x01');
final _info = utf8Bytes('veil/backup/v1');
const backupIterations = 600000;

enum BackupErrorCode { notABackup, unsupported, wrongPassphrase, corrupt, truncated }

class BackupError implements Exception {
  final BackupErrorCode code;
  const BackupError(this.code);
  String get message => switch (code) {
        BackupErrorCode.notABackup => 'This file is not a Veil backup',
        BackupErrorCode.unsupported => 'This backup was made by a newer version of Veil',
        BackupErrorCode.wrongPassphrase => 'Incorrect backup passphrase',
        BackupErrorCode.corrupt => 'This backup is damaged or has been tampered with',
        BackupErrorCode.truncated => 'This backup is incomplete - it may not have finished saving',
      };
  @override
  String toString() => message;
}

sealed class BackupEntry {}

class JsonEntry extends BackupEntry {
  final String k;
  final Object? d;
  JsonEntry(this.k, this.d);
}

class ChunkEntry extends BackupEntry {
  final String fileId;
  final int index;
  final Uint8List data;
  ChunkEntry(this.fileId, this.index, this.data);
}

Uint8List _aad(int index, bool last) => concat([u64(index), [last ? 1 : 0]]);

Future<Uint8List> _deriveKey(String pass, Uint8List header, List<int> salt, int iter) async {
  final kek = await pbkdf2(pass, salt, iter);
  final key = await hkdf(kek, await sha256(header), _info, 32);
  wipe(kek);
  return key;
}

class BackupWriter {
  final Uint8List _key;
  final Uint8List header;
  int _index = 0;
  bool _ended = false;
  BackupWriter._(this._key, this.header);

  static Future<BackupWriter> create(String passphrase, {int iterations = backupIterations}) async {
    final salt = randomBytes(16);
    final json = utf8Bytes(jsonEncode({'v': 1, 'kdf': 'PBKDF2-SHA-256', 'iter': iterations, 'salt': toB64u(salt)}));
    final header = concat([_magic, u32(json.length), json]);
    return BackupWriter._(await _deriveKey(passphrase, header, salt, iterations), header);
  }

  Future<Uint8List> _record(List<int> plain, {bool last = false}) async {
    if (_ended) throw StateError('backup already finished');
    final iv = randomBytes(12);
    final ct = await aesGcmEncrypt(_key, iv, plain, _aad(_index++, last));
    return concat([u32(iv.length + ct.length), iv, ct]);
  }

  Future<Uint8List> json(String k, Object? d) => _record(concat([
        [1],
        utf8Bytes(jsonEncode({'k': k, 'd': d})),
      ]));

  Future<Uint8List> chunk(String fileId, int index, List<int> data) => _record(concat([
        [2],
        fromB64u(fileId),
        u32(index),
        data,
      ]));

  Future<Uint8List> end() async {
    final r = await _record(concat([
      [0xff],
      utf8Bytes(jsonEncode({'records': _index})),
    ]), last: true);
    _ended = true;
    return r;
  }
}

Map<String, Object?> _json(List<int> b) {
  try {
    final v = jsonDecode(utf8.decode(b));
    if (v is Map) return v.cast();
  } catch (_) {}
  throw const BackupError(BackupErrorCode.corrupt);
}

/// Streams and authenticates every entry. Do not commit anything until it completes.
Stream<BackupEntry> readBackup(Uint8List file, String passphrase) async* {
  if (file.length < _magic.length + 4 || !ctEqual(file.sublist(0, _magic.length), _magic)) throw const BackupError(BackupErrorCode.notABackup);
  final hlen = readU32(file, _magic.length);
  if (hlen > 4096 || file.length < _magic.length + 4 + hlen) throw const BackupError(BackupErrorCode.notABackup);
  final hjson = file.sublist(_magic.length + 4, _magic.length + 4 + hlen);
  final Map<String, Object?> h;
  try {
    h = (jsonDecode(utf8.decode(hjson)) as Map).cast();
  } catch (_) {
    throw const BackupError(BackupErrorCode.notABackup);
  }
  if (h['v'] != 1 || h['kdf'] != 'PBKDF2-SHA-256') throw const BackupError(BackupErrorCode.unsupported);
  final iter = h['iter'];
  if (iter is! int || iter < 100000 || iter > 10000000 || h['salt'] is! String) throw const BackupError(BackupErrorCode.corrupt);
  final Uint8List salt;
  try {
    salt = fromB64u(h['salt'] as String);
  } on FormatException {
    throw const BackupError(BackupErrorCode.corrupt);
  }
  if (salt.length != 16) throw const BackupError(BackupErrorCode.corrupt);
  final header = Uint8List.fromList(file.sublist(0, _magic.length + 4 + hlen));
  final key = await _deriveKey(passphrase, header, salt, iter);

  var off = header.length;
  var index = 0;
  while (true) {
    if (off + 4 > file.length) throw const BackupError(BackupErrorCode.truncated);
    final len = readU32(file, off);
    if (len < 12 + 16 + 1 || len > 4 * 1024 * 1024) throw const BackupError(BackupErrorCode.corrupt);
    if (off + 4 + len > file.length) throw const BackupError(BackupErrorCode.truncated);
    final rec = file.sublist(off + 4, off + 4 + len);
    off += 4 + len;
    Uint8List? plain;
    var last = false;
    for (final f in [false, true]) {
      try {
        plain = await aesGcmDecrypt(key, rec.sublist(0, 12), rec.sublist(12), _aad(index, f));
        last = f;
        break;
      } on CryptoFailure {
        // try the other flag
      }
    }
    if (plain == null) throw BackupError(index == 0 ? BackupErrorCode.wrongPassphrase : BackupErrorCode.corrupt);
    index++;
    final type = plain[0];
    final body = plain.sublist(1);
    if (last) {
      if (type != 0xff) throw const BackupError(BackupErrorCode.corrupt);
      if (_json(body)['records'] != index - 1 || off != file.length) throw const BackupError(BackupErrorCode.corrupt);
      return;
    }
    if (type == 1) {
      final m = _json(body);
      if (m['k'] is! String) throw const BackupError(BackupErrorCode.corrupt);
      yield JsonEntry(m['k'] as String, m['d']);
    } else if (type == 2) {
      if (body.length < 20) throw const BackupError(BackupErrorCode.corrupt);
      yield ChunkEntry(toB64u(body.sublist(0, 16)), readU32(body, 16), Uint8List.fromList(body.sublist(20)));
    } else {
      throw const BackupError(BackupErrorCode.corrupt);
    }
  }
}

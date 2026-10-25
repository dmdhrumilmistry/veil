import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:veil_core/veil_core.dart';

/// Encrypted local storage.
///
/// The 32-byte master key is random and lives in the OS keystore (Android Keystore /
/// iOS Keychain / platform secret service), never in the database. It is expanded with
/// HKDF into an AES-256-GCM record key and an HMAC index key - the same sealed-record
/// design as the web app: every value has a fresh IV, its storage slot as AAD, and
/// lookup keys are HMAC tags so the database holds no plaintext identifiers.
class Vault {
  static const _masterKeyName = 'veil-master-key-v1';
  static const _storage = FlutterSecureStorage();

  final Database db;
  final Uint8List _recordKey;
  final Uint8List _indexKey;
  Vault._(this.db, this._recordKey, this._indexKey);

  static Future<File> _dbFile() async => File('${(await getApplicationSupportDirectory()).path}/veil.db');

  static Future<bool> exists() async => await _storage.read(key: _masterKeyName) != null && (await _dbFile()).existsSync();

  static Future<Vault> open({bool create = false}) async {
    var master = await _storage.read(key: _masterKeyName);
    if (master == null) {
      if (!create) throw StateError('No Veil data on this device');
      master = toB64u(randomBytes(32));
      await _storage.write(key: _masterKeyName, value: master);
    }
    final okm = await hkdf(fromB64u(master), Uint8List(32), utf8Bytes('veil/vault/v1/keys'), 64);
    final file = await _dbFile();
    final db = sqlite3.open(file.path);
    db.execute('''
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, iv BLOB NOT NULL, ct BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS msgs (chat TEXT NOT NULL, seq INTEGER NOT NULL, iv BLOB NOT NULL, ct BLOB NOT NULL, PRIMARY KEY (chat, seq));
      CREATE TABLE IF NOT EXISTS chunks (k TEXT PRIMARY KEY, iv BLOB NOT NULL, ct BLOB NOT NULL);
    ''');
    return Vault._(db, Uint8List.fromList(okm.sublist(0, 32)), Uint8List.fromList(okm.sublist(32)));
  }

  /// Erase everything: database file and keystore entry.
  static Future<void> wipe() async {
    await _storage.delete(key: _masterKeyName);
    final f = await _dbFile();
    for (final p in [f.path, '${f.path}-wal', '${f.path}-shm']) {
      final x = File(p);
      if (x.existsSync()) x.deleteSync();
    }
  }

  Future<String> tag(String label) async => toB64u((await hmacSha256(_indexKey, utf8Bytes(label))).sublist(0, 16));

  Future<(Uint8List, Uint8List)> _seal(String slot, List<int> data) async {
    final iv = randomBytes(12);
    return (iv, await aesGcmEncrypt(_recordKey, iv, data, utf8Bytes(slot)));
  }

  Future<Uint8List> _open(String slot, List<int> iv, List<int> ct) => aesGcmDecrypt(_recordKey, iv, ct, utf8Bytes(slot));

  Future<void> putJson(String k, Object? value) async {
    final (iv, ct) = await _seal('kv:$k', utf8.encode(jsonEncode(value)));
    db.execute('INSERT OR REPLACE INTO kv (k, iv, ct) VALUES (?, ?, ?)', [k, iv, ct]);
  }

  Future<Object?> getJson(String k) async {
    final rows = db.select('SELECT iv, ct FROM kv WHERE k = ?', [k]);
    if (rows.isEmpty) return null;
    return jsonDecode(utf8.decode(await _open('kv:$k', rows.first['iv'] as List<int>, rows.first['ct'] as List<int>)));
  }

  Future<List<Object?>> listJson(String prefix) async {
    final out = <Object?>[];
    for (final r in db.select("SELECT k, iv, ct FROM kv WHERE k >= ? AND k < ? ORDER BY k", [prefix, '$prefix￿'])) {
      try {
        out.add(jsonDecode(utf8.decode(await _open('kv:${r['k']}', r['iv'] as List<int>, r['ct'] as List<int>))));
      } catch (_) {
        // corrupted record: skip
      }
    }
    return out;
  }

  void delete(String k) => db.execute('DELETE FROM kv WHERE k = ?', [k]);

  // ---- messages: ordered by a per-chat sequence number, paged newest-first

  Future<void> putMessage(String chatTag, int seq, Map<String, Object?> m) async {
    final (iv, ct) = await _seal('msgs:$chatTag/$seq', utf8.encode(jsonEncode(m)));
    db.execute('INSERT OR REPLACE INTO msgs (chat, seq, iv, ct) VALUES (?, ?, ?, ?)', [chatTag, seq, iv, ct]);
  }

  int lastSeq(String chatTag) => (db.select('SELECT MAX(seq) AS s FROM msgs WHERE chat = ?', [chatTag]).first['s'] as int?) ?? 0;

  Future<List<Map<String, Object?>>> pageMessages(String chatTag, int? beforeSeq, int limit) async {
    final rows = db.select('SELECT seq, iv, ct FROM msgs WHERE chat = ? AND seq < ? ORDER BY seq DESC LIMIT ?', [chatTag, beforeSeq ?? 1 << 62, limit]);
    final out = <Map<String, Object?>>[];
    for (final r in rows.reversed) {
      try {
        out.add((jsonDecode(utf8.decode(await _open('msgs:$chatTag/${r['seq']}', r['iv'] as List<int>, r['ct'] as List<int>))) as Map).cast());
      } catch (_) {}
    }
    return out;
  }

  void deleteMessage(String chatTag, int seq) => db.execute('DELETE FROM msgs WHERE chat = ? AND seq = ?', [chatTag, seq]);
  void deleteChat(String chatTag) => db.execute('DELETE FROM msgs WHERE chat = ?', [chatTag]);

  // ---- file chunks (from restored backups)

  Future<void> putChunk(String k, List<int> data) async {
    final (iv, ct) = await _seal('chunks:$k', data);
    db.execute('INSERT OR REPLACE INTO chunks (k, iv, ct) VALUES (?, ?, ?)', [k, iv, ct]);
  }

  Future<Uint8List?> getChunk(String k) async {
    final rows = db.select('SELECT iv, ct FROM chunks WHERE k = ?', [k]);
    if (rows.isEmpty) return null;
    return _open('chunks:$k', rows.first['iv'] as List<int>, rows.first['ct'] as List<int>);
  }

  void close() {
    wipe8(_recordKey);
    wipe8(_indexKey);
    db.close();
  }
}

void wipe8(Uint8List b) => b.fillRange(0, b.length, 0);

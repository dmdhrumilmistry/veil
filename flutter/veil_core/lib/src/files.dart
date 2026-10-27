import 'dart:typed_data';

import 'package:cryptography/cryptography.dart' show HashSink, Sha256;

import 'encoding.dart';

/// Live file transfer framing (mirrors app/src/net/session.ts + app/src/state/app.ts):
///   bulk plaintext = fileId(16) || index(u32) || bytes, sealed with the bulk KDF chain
///   control (ctrl channel): file-offer, file-accept, file-decline, file-cancel,
///                           file-done { sha256 hex, size }
/// Files are persisted in sealed 1 MiB blocks.
const bulkHeader = 20;
const storeBlockSize = 1024 * 1024;
const maxFileSize = 4 * 1024 * 1024 * 1024;

Uint8List bulkFrame(String fileId, int index, List<int> data) => concat([fromB64u(fileId), u32(index), data]);

({String fileId, int index, Uint8List data}) parseBulkFrame(List<int> plain) {
  if (plain.length < bulkHeader) throw const FormatException('short bulk frame');
  return (fileId: toB64u(plain.sublist(0, 16)), index: readU32(plain, 16), data: Uint8List.fromList(plain.sublist(bulkHeader)));
}

/// Streaming SHA-256 (hex), matching the web app's @noble/hashes digest.
class Sha256Stream {
  final HashSink _sink = Sha256().newHashSink();
  void add(List<int> data) => _sink.add(data);
  Future<String> hex() async {
    _sink.close();
    return toHex((await _sink.hash()).bytes);
  }
}

class FileTransferError implements Exception {
  final String message;
  const FileTransferError(this.message);
  @override
  String toString() => 'FileTransferError: $message';
}

/// Reassembles an incoming file: strict chunk order, size cap, streaming hash, and
/// 1 MiB sealed blocks handed to [store].
class IncomingFile {
  final String fileId;
  final int size;
  final Future<void> Function(int blockIndex, Uint8List block) store;
  int expectIndex = 0;
  int received = 0;
  int blocks = 0;
  final _hash = Sha256Stream();
  final _buffer = BytesBuilder(copy: false);

  IncomingFile(this.fileId, this.size, this.store);

  Future<void> add(int index, Uint8List data) async {
    if (index != expectIndex) throw const FileTransferError('file chunk out of order');
    expectIndex++;
    received += data.length;
    if (received > size) throw const FileTransferError('peer sent more data than announced');
    _hash.add(data);
    _buffer.add(data);
    if (_buffer.length >= storeBlockSize) await _flush();
  }

  Future<void> _flush() async {
    if (_buffer.isEmpty) return;
    await store(blocks++, _buffer.takeBytes());
  }

  /// Verifies size and SHA-256. Returns the number of stored blocks.
  Future<int> finish(String expectedSha256) async {
    await _flush();
    final digest = await _hash.hex();
    if (received != size || digest != expectedSha256) throw const FileTransferError('integrity check failed');
    return blocks;
  }
}

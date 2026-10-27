import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:veil_core/veil_core.dart';

void main() {
  test('bulk frames round-trip and match the web layout', () {
    final id = randomId();
    final f = bulkFrame(id, 7, [1, 2, 3]);
    expect(f.length, 20 + 3);
    final p = parseBulkFrame(f);
    expect(p.fileId, id);
    expect(p.index, 7);
    expect(p.data, [1, 2, 3]);
  });

  test('incoming files: order, size cap, hash, 1 MiB blocks', () async {
    final data = Uint8List.fromList(List.generate(2 * storeBlockSize + 123, (i) => i * 31 & 0xff));
    final h = Sha256Stream()..add(data);
    final digest = await h.hex();
    final blocks = <int, Uint8List>{};
    final f = IncomingFile('A' * 22, data.length, (i, b) async => blocks[i] = b);
    for (var i = 0, off = 0; off < data.length; i++, off += 30000) {
      await f.add(i, data.sublist(off, (off + 30000).clamp(0, data.length)));
    }
    // Blocks flush once >= 1 MiB is buffered (same rule as the web app).
    expect(await f.finish(digest), 2);
    expect(blocks.values.fold<int>(0, (n, b) => n + b.length), data.length);

    final bad = IncomingFile('A' * 22, 10, (_, _) async {});
    await expectLater(bad.add(1, Uint8List(5)), throwsA(isA<FileTransferError>()));
    final big = IncomingFile('A' * 22, 3, (_, _) async {});
    await expectLater(big.add(0, Uint8List(5)), throwsA(isA<FileTransferError>()));
    final tampered = IncomingFile('A' * 22, 3, (_, _) async {});
    await tampered.add(0, Uint8List(3));
    await expectLater(tampered.finish(digest), throwsA(isA<FileTransferError>()));
  });
}

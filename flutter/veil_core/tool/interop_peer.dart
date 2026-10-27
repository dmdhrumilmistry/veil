// Cross-implementation interop peer: speaks the Veil handshake and live-frame
// protocol over JSON lines on stdin/stdout, driven by app/test/interop.test.ts.
import 'dart:convert';
import 'dart:io';

import 'package:veil_core/veil_core.dart';

Future<void> main() async {
  late Handshake hs;
  late Identity me;
  // ignore: unused_local_variable
  SessionKeys? keys;
  SendChain? tx;
  RecvChain? rx;
  SendChain? bulkTx;
  RecvChain? bulkRx;
  void send(Map<String, Object?> m) => stdout.writeln(jsonEncode(m));

  await for (final line in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
    final m = (jsonDecode(line) as Map).cast<String, Object?>();
    try {
      switch (m['cmd']) {
        case 'init':
          me = await Identity.generate();
          final peer = m['expectedPeer'] as String?;
          hs = Handshake(
            role: m['role'] == 'initiator' ? Role.initiator : Role.responder,
            identity: me,
            localFingerprint: m['fpLocal'] as String,
            remoteFingerprint: m['fpRemote'] as String,
            expectedPeer: peer == null ? null : fromB64u(peer),
          );
          send({'id': me.id, if (m['role'] == 'initiator') 'hs': await hs.start()});
        case 'hs':
          final r = await hs.receive(m['msg']);
          final k = r.keys;
          if (k != null) {
            keys = k;
            tx = SendChain(k.ctrlSend, 'veil/v1/ctrl');
            rx = RecvChain(k.ctrlRecv, 'veil/v1/ctrl');
            bulkTx = SendChain(k.bulkSend, 'veil/v1/bulk');
            bulkRx = RecvChain(k.bulkRecv, 'veil/v1/bulk');
          }
          send({'hs': r.reply, 'done': k != null, if (k != null) 'asyncRoot': toHex(await sha256(k.asyncRoot)), if (k != null) 'peer': toB64u(k.peerIdentity)});
        case 'frames':
          final opened = [for (final f in m['in'] as List) utf8.decode(await rx!.open(fromB64u(f as String)))];
          final out = [for (final p in m['send'] as List) toB64u(await tx!.seal(utf8.encode(p as String)))];
          send({'opened': opened, 'out': out});
        case 'bulk':
          // Receive a file the web app sent, then send one back.
          final file = IncomingFile(m['fileId'] as String, m['size'] as int, (_, _) async {});
          for (final f in m['in'] as List) {
            final p = parseBulkFrame(await bulkRx!.open(fromB64u(f as String)));
            await file.add(p.index, p.data);
          }
          await file.finish(m['sha256'] as String); // throws if the digest differs
          final back = utf8.encode(m['reply'] as String);
          final out = [for (var i = 0; i * 7 < back.length; i++) toB64u(await bulkTx!.seal(bulkFrame(m['fileId'] as String, i, back.sublist(i * 7, (i * 7 + 7).clamp(0, back.length)))))];
          final h = Sha256Stream()..add(back);
          send({'received': file.received, 'out': out, 'sha256': await h.hex()});
        case 'quit':
          exit(0);
      }
    } catch (e) {
      send({'error': e.toString()});
    }
  }
}

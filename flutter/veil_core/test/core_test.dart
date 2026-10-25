import 'dart:convert';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:veil_core/veil_core.dart';

const fpI = 'sha-256 AA:BB';
const fpR = 'sha-256 CC:DD';

Map<String, Object?> wire(Object? m) => (jsonDecode(jsonEncode(m)) as Map).cast();

void main() {
  group('handshake (Dart <-> Dart)', () {
    test('derives matching, crossed keys', () async {
      final a = await Identity.generate();
      final b = await Identity.generate();
      final i = Handshake(role: Role.initiator, identity: a, localFingerprint: fpI, remoteFingerprint: fpR, expectedPeer: b.pub);
      final r = Handshake(role: Role.responder, identity: b, localFingerprint: fpR, remoteFingerprint: fpI, expectedPeer: a.pub);
      final r1 = await r.receive(wire(await i.start()));
      final r2 = await i.receive(wire(r1.reply));
      final r3 = await r.receive(wire(r2.reply));
      expect(toB64u(r2.keys!.ctrlSend), toB64u(r3.keys!.ctrlRecv));
      expect(toB64u(r2.keys!.bulkRecv), toB64u(r3.keys!.bulkSend));
      expect(toB64u(r2.keys!.asyncRoot), toB64u(r3.keys!.asyncRoot));
    });

    test('rejects MITM (fingerprint mismatch), wrong pinned peer and forged FIN', () async {
      final a = await Identity.generate();
      final b = await Identity.generate();
      final mitm = Handshake(role: Role.responder, identity: b, localFingerprint: fpR, remoteFingerprint: 'sha-256 EE:FF');
      final i = Handshake(role: Role.initiator, identity: a, localFingerprint: fpI, remoteFingerprint: fpR);
      final r1 = await mitm.receive(wire(await i.start()));
      await expectLater(i.receive(wire(r1.reply)), throwsA(isA<HandshakeError>()));

      final other = await Identity.generate();
      final pinned = Handshake(role: Role.responder, identity: b, localFingerprint: fpR, remoteFingerprint: fpI, expectedPeer: other.pub);
      final i2 = Handshake(role: Role.initiator, identity: a, localFingerprint: fpI, remoteFingerprint: fpR);
      final hello2 = wire(await i2.start());
      await expectLater(pinned.receive(hello2), throwsA(isA<HandshakeError>()));

      final r = Handshake(role: Role.responder, identity: b, localFingerprint: fpR, remoteFingerprint: fpI);
      final i3 = Handshake(role: Role.initiator, identity: a, localFingerprint: fpI, remoteFingerprint: fpR);
      await r.receive(wire(await i3.start()));
      await expectLater(r.receive({'t': 'fin', 'sig': toB64u(randomBytes(64))}), throwsA(isA<HandshakeError>()));
    });
  });

  group('chain', () {
    test('rejects replay, reorder, tamper and cross-channel frames', () async {
      final ck = randomBytes(32);
      final tx = SendChain(ck, 'ctrl');
      final f1 = await tx.seal(utf8.encode('a'));
      final f2 = await tx.seal(utf8.encode('b'));
      expect(() => RecvChain(ck, 'ctrl').open(f2), throwsA(isA<ChainError>()));
      final rx = RecvChain(ck, 'ctrl');
      await rx.open(f1);
      expect(() => rx.open(f1), throwsA(isA<ChainError>()));
      final t = Uint8List.fromList(f1)..[f1.length - 1] ^= 1;
      expect(() => RecvChain(ck, 'ctrl').open(t), throwsA(isA<ChainError>()));
      expect(() => RecvChain(ck, 'bulk').open(f1), throwsA(isA<ChainError>()));
    });
  });

  group('double ratchet (Dart <-> Dart)', () {
    Future<(Ratchet, Ratchet)> pair() async {
      final sk = randomBytes(32);
      final ad = utf8.encode('alice|bob');
      final bobKey = await generateRatchetKey();
      return (await Ratchet.initAlice(sk, bobKey.pub, ad), Ratchet.initBob(sk, bobKey, ad));
    }

    test('both directions, out of order, persisted, replay rejected', () async {
      final (alice, bob) = await pair();
      final m1 = await alice.encrypt(utf8.encode('one'));
      final m2 = await alice.encrypt(utf8.encode('two'));
      expect(utf8.decode(await bob.decrypt(m2)), 'two');
      expect(utf8.decode(await alice.decrypt(await bob.encrypt(utf8.encode('reply')))), 'reply');
      expect(utf8.decode(await bob.decrypt(m1)), 'one');
      expect(() => bob.decrypt(m1), throwsA(isA<RatchetError>()));
      final a2 = Ratchet.fromJson(wire(alice.toJson()));
      final b2 = Ratchet.fromJson(wire(bob.toJson()));
      expect(utf8.decode(await b2.decrypt(await a2.encrypt(utf8.encode('after restart')))), 'after restart');
    });

    test('tampering never corrupts state', () async {
      final (alice, bob) = await pair();
      final m = await alice.encrypt(utf8.encode('hi'));
      final bad = Uint8List.fromList(m)..[m.length - 1] ^= 1;
      expect(() => bob.decrypt(bad), throwsA(isA<RatchetError>()));
      expect(utf8.decode(await bob.decrypt(m)), 'hi');
    });
  });

  group('backup', () {
    test('round-trips and detects truncation and tampering', () async {
      final w = await BackupWriter.create('a backup passphrase', iterations: 100000);
      final frames = [w.header, await w.json('profile', {'name': 'Zoë'}), await w.end()];
      final file = concat(frames);
      final entries = await readBackup(file, 'a backup passphrase').toList();
      expect((entries.single as JsonEntry).d, {'name': 'Zoë'});
      expect(readBackup(concat(frames.sublist(0, 2)), 'a backup passphrase').toList(), throwsA(isA<BackupError>()));
      final t = Uint8List.fromList(file)..[file.length - 1] ^= 1;
      expect(readBackup(t, 'a backup passphrase').toList(), throwsA(isA<BackupError>()));
    });
  });

  test('relay addresses must be wss', () {
    expect(normalizeRelay('wss://nos.lol/'), 'wss://nos.lol');
    expect(() => normalizeRelay('ws://nos.lol'), throwsFormatException);
    expect(() => normalizeRelay('https://nos.lol'), throwsFormatException);
    expect(normalizeRelay('ws://127.0.0.1:7000', allowLocal: true), 'ws://127.0.0.1:7000');
  });
}

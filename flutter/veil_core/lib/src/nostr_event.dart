import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:bip340/bip340.dart' as schnorr;

import 'encoding.dart';
import 'primitives.dart';

/// NIP-59 style gift wraps (mirrors app/src/net/nostr.ts):
/// kind 1059, signed by a throwaway key per event, ["p", recipient], NIP-40 expiry.
const wrapKind = 1059;
const defaultRelays = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.damus.io'];
const maxRelays = 6;

bool isHexKey(Object? s) => s is String && RegExp(r'^[0-9a-f]{64}$').hasMatch(s);

String normalizeRelay(String input, {bool allowLocal = false}) {
  final u = Uri.tryParse(input.trim());
  if (u == null || !u.hasScheme) throw FormatException('Not a valid relay address: $input');
  final local = u.host == 'localhost' || u.host == '127.0.0.1';
  if (u.scheme != 'wss' && !(allowLocal && local && u.scheme == 'ws')) throw FormatException('Relays must use wss:// ($input)');
  if (u.userInfo.isNotEmpty || u.hasQuery || u.hasFragment) throw FormatException('Use a plain relay address ($input)');
  final path = u.path.replaceAll(RegExp(r'/+$'), '');
  return '${u.scheme}://${u.host}${u.hasPort ? ':${u.port}' : ''}$path';
}

class MailboxKey {
  final String sk;
  final String pk;
  MailboxKey(this.sk, this.pk);
  static MailboxKey generate() {
    while (true) {
      final sk = toHex(randomBytes(32));
      try {
        return MailboxKey(sk, schnorr.getPublicKey(sk));
      } catch (_) {
        // vanishingly rare out-of-range scalar: retry
      }
    }
  }

  Map<String, String> toJson() => {'sk': sk, 'pk': pk};
}

Future<String> _eventId(String pubkey, int createdAt, int kind, List<List<String>> tags, String content) async =>
    toHex(await sha256(utf8.encode(jsonEncode([0, pubkey, createdAt, kind, tags, content]))));

Future<Map<String, Object>> wrapEvent(String recipientPk, String content, int ttlSeconds) async {
  final key = MailboxKey.generate();
  final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
  final createdAt = now - Random.secure().nextInt(60);
  final tags = [
    ['p', recipientPk],
    ['expiration', '${now + ttlSeconds}'],
  ];
  final id = await _eventId(key.pk, createdAt, wrapKind, tags, content);
  final sig = schnorr.sign(key.sk, id, toHex(randomBytes(32)));
  return {'id': id, 'pubkey': key.pk, 'created_at': createdAt, 'kind': wrapKind, 'tags': tags, 'content': content, 'sig': sig};
}

Future<bool> verifyEvent(Map<String, Object?> ev) async {
  try {
    final pubkey = ev['pubkey'], content = ev['content'], id = ev['id'], sig = ev['sig'];
    if (!isHexKey(pubkey) || ev['kind'] != wrapKind || content is! String || content.length > 200000 || id is! String || sig is! String) return false;
    final tags = [for (final t in ev['tags'] as List) (t as List).cast<String>()];
    if (await _eventId(pubkey as String, ev['created_at'] as int, wrapKind, tags, content) != id) return false;
    return schnorr.verify(pubkey, id, sig);
  } catch (_) {
    return false;
  }
}

/// A peer's mailbox card { pk, relays }.
class MailboxCard {
  final String pk;
  final List<String> relays;
  MailboxCard(this.pk, this.relays);
  Map<String, Object> toJson() => {'pk': pk, 'relays': relays};

  static MailboxCard? parse(Object? pk, Object? relays, {bool allowLocal = false}) {
    if (!isHexKey(pk) || relays is! List) return null;
    try {
      final rl = <String>{for (final r in relays.take(maxRelays)) normalizeRelay('$r', allowLocal: allowLocal)}.toList();
      return rl.isEmpty ? null : MailboxCard(pk as String, rl);
    } on FormatException {
      return null;
    }
  }
}

Uint8List? decodeContent(String content) {
  try {
    return fromB64u(content);
  } on FormatException {
    return null;
  }
}

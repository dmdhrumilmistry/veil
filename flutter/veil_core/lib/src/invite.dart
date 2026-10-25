import 'dart:convert';
import 'dart:typed_data';

import 'compress.dart';
import 'encoding.dart';
import 'envelope.dart';
import 'nostr_event.dart';
import 'primitives.dart';

/// Invite links v3 and sealed join notes (mirrors app/src/net/invite.ts).
const invitePrefix = 'VEIL3I.';
final _info = utf8Bytes('veil/v1/invite');

class InviteV3 {
  final String id, name, mb, ik, tok, iid;
  final List<String> rl;
  final int exp;
  InviteV3({required this.id, required this.name, required this.mb, required this.rl, required this.ik, required this.tok, required this.iid, required this.exp});

  Map<String, Object> toJson() => {'v': 3, 'id': id, 'name': name, 'mb': mb, 'rl': rl, 'ik': ik, 'tok': tok, 'iid': iid, 'exp': exp};
}

String? extractInvite(String text) => RegExp(r'VEIL[23]I\.[A-Za-z0-9_-]+').firstMatch(text)?.group(0);

String encodeInvite(InviteV3 inv) => invitePrefix + toB64u(deflateRaw(utf8.encode(jsonEncode(inv.toJson()))));

bool _isB64(Object? s, int bytes) {
  if (s is! String) return false;
  try {
    return fromB64u(s).length == bytes;
  } on FormatException {
    return false;
  }
}

InviteV3 decodeInvite(String text, {bool allowLocal = false}) {
  final code = extractInvite(text);
  if (code == null || code.length > 4096) throw const FormatException('That does not look like a Veil invite');
  if (code.startsWith('VEIL2I.')) throw const FormatException('This invite is from an older version of Veil. Ask for a new link.');
  final Map<String, Object?> j;
  try {
    j = (jsonDecode(utf8.decode(inflateRaw(fromB64u(code.substring(invitePrefix.length))))) as Map).cast();
  } catch (_) {
    throw const FormatException('This invite link is damaged - ask for a new one');
  }
  final card = MailboxCard.parse(j['mb'], j['rl'], allowLocal: allowLocal);
  if (j['v'] != 3 || !_isB64(j['id'], 32) || !_isB64(j['ik'], 32) || !_isB64(j['tok'], 16) || !_isB64(j['iid'], 16) || card == null || j['exp'] is! int) {
    throw const FormatException('Unsupported or invalid Veil invite');
  }
  final name = j['name'] is String ? j['name'] as String : '';
  return InviteV3(id: j['id'] as String, name: name.length > 48 ? name.substring(0, 48) : name, mb: card.pk, rl: card.relays, ik: j['ik'] as String, tok: j['tok'] as String, iid: j['iid'] as String, exp: j['exp'] as int);
}

/// What the inviter keeps locally (same JSON as the web app's InviteSecret).
class InviteSecret {
  final String iid, tok, ikPub, ikPkcs8;
  final int exp, created;
  String? claimedBy, claimedName;
  int? usedAt;
  bool conflictReported;
  InviteSecret({required this.iid, required this.tok, required this.ikPub, required this.ikPkcs8, required this.exp, required this.created, this.claimedBy, this.claimedName, this.usedAt, this.conflictReported = false});

  static Future<InviteSecret> create(Duration ttl) async {
    final kp = await x25519Generate();
    final now = DateTime.now().millisecondsSinceEpoch;
    return InviteSecret(iid: toB64u(randomBytes(16)), tok: toB64u(randomBytes(16)), ikPub: toB64u(kp.pub), ikPkcs8: toB64u(pkcs8FromSeed(kp.priv, ed25519: false)), exp: now + ttl.inMilliseconds, created: now);
  }

  Map<String, Object?> toJson() => {'iid': iid, 'tok': tok, 'ikPub': ikPub, 'ikPkcs8': ikPkcs8, 'exp': exp, 'created': created, 'claimedBy': claimedBy, 'claimedName': claimedName, 'usedAt': usedAt, 'conflictReported': conflictReported};

  static InviteSecret fromJson(Map<String, Object?> j) => InviteSecret(
        iid: j['iid'] as String,
        tok: j['tok'] as String,
        ikPub: j['ikPub'] as String,
        ikPkcs8: j['ikPkcs8'] as String,
        exp: j['exp'] as int,
        created: j['created'] as int,
        claimedBy: j['claimedBy'] as String?,
        claimedName: j['claimedName'] as String?,
        usedAt: j['usedAt'] as int?,
        conflictReported: j['conflictReported'] == true,
      );
}

Future<(Uint8List, Uint8List)> _split(Uint8List dh, String iid) async {
  final okm = await hkdf(dh, fromB64u(iid), _info, 64);
  wipe(dh);
  return (Uint8List.fromList(okm.sublist(0, 32)), Uint8List.fromList(okm.sublist(32)));
}

class JoinNote {
  final String iid, tok, id, name, aid;
  final MailboxCard reply;
  final int ts;
  JoinNote({required this.iid, required this.tok, required this.id, required this.name, required this.reply, required this.aid, required this.ts});
  Map<String, Object> toJson() => {'t': 'join', 'iid': iid, 'tok': tok, 'id': id, 'name': name, 'reply': reply.toJson(), 'aid': aid, 'ts': ts};
}

/// Joiner: seal a join note to the invite key. Returns the envelope and channel key.
Future<({Uint8List envelope, Uint8List chan})> sealJoin(InviteV3 inv, JoinNote note) async {
  final eph = await x25519Generate();
  final (join, chan) = await _split(await x25519(eph.priv, fromB64u(inv.ik)), inv.iid);
  final env = await sealEnvelope(join, utf8.encode(jsonEncode(note.toJson())));
  return (envelope: concat([eph.pub, env]), chan: chan);
}

/// Inviter: open a join note with one of our invites, or null.
Future<({JoinNote note, Uint8List chan})?> openJoin(InviteSecret secret, List<int> envelope) async {
  if (envelope.length < 32 + 12 + 16) return null;
  Uint8List dh;
  try {
    dh = await x25519(seedFromPkcs8(fromB64u(secret.ikPkcs8), ed25519: false), envelope.sublist(0, 32));
  } on CryptoFailure {
    return null;
  }
  final (join, chan) = await _split(dh, secret.iid);
  final plain = await openEnvelope(join, envelope.sublist(32));
  if (plain == null) return null;
  try {
    final m = (jsonDecode(utf8.decode(plain)) as Map).cast<String, Object?>();
    if (m['t'] != 'join' || m['iid'] != secret.iid || m['tok'] is! String || !ctEqual(utf8Bytes(m['tok'] as String), utf8Bytes(secret.tok))) return null;
    final r = (m['reply'] as Map).cast<String, Object?>();
    if (!_isB64(m['id'], 32) || !isHexKey(r['pk']) || r['relays'] is! List || m['aid'] is! String) return null;
    return (
      note: JoinNote(iid: secret.iid, tok: m['tok'] as String, id: m['id'] as String, name: (m['name'] as String?) ?? '', reply: MailboxCard(r['pk'] as String, (r['relays'] as List).cast<String>()), aid: m['aid'] as String, ts: m['ts'] as int),
      chan: chan,
    );
  } catch (_) {
    return null;
  }
}

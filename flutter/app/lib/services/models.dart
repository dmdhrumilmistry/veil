// Data models. JSON shapes match the web app (app/src/storage/repo.ts) so
// encrypted backups move between the web and Flutter apps.
import 'package:veil_core/veil_core.dart';

class Preview {
  final String kind, text, dir;
  final int ts;
  final int? expiresAt;
  Preview({required this.kind, required this.text, required this.dir, required this.ts, this.expiresAt});
  Map<String, Object?> toJson() => {'kind': kind, 'text': text, 'dir': dir, 'ts': ts, 'expiresAt': expiresAt};
  static Preview? fromJson(Object? j) {
    if (j is! Map) return null;
    return Preview(kind: '${j['kind']}', text: '${j['text']}', dir: '${j['dir']}', ts: j['ts'] as int? ?? 0, expiresAt: j['expiresAt'] as int?);
  }
}

class Contact {
  final String id; // base64url Ed25519 identity key
  String name;
  String? alias;
  final int addedAt;
  int lastSeen;
  bool verified;
  int disappearSecs;
  int unread;
  Preview? preview;
  MailboxCard? mailbox;
  Contact({required this.id, required this.name, this.alias, required this.addedAt, required this.lastSeen, this.verified = false, this.disappearSecs = 0, this.unread = 0, this.preview, this.mailbox});

  String get displayName => (alias?.isNotEmpty ?? false) ? alias! : (name.isNotEmpty ? name : 'Unnamed contact');

  Map<String, Object?> toJson() => {
        'id': id,
        'name': name,
        if (alias != null) 'alias': alias,
        'addedAt': addedAt,
        'lastSeen': lastSeen,
        'verified': verified,
        'disappearSecs': disappearSecs,
        'unread': unread,
        if (preview != null) 'preview': preview!.toJson(),
        if (mailbox != null) 'mailbox': mailbox!.toJson(),
      };

  static Contact fromJson(Map<String, Object?> j) => Contact(
        id: j['id'] as String,
        name: (j['name'] as String?) ?? '',
        alias: j['alias'] as String?,
        addedAt: j['addedAt'] as int? ?? 0,
        lastSeen: j['lastSeen'] as int? ?? 0,
        verified: j['verified'] == true,
        disappearSecs: j['disappearSecs'] as int? ?? 0,
        unread: j['unread'] as int? ?? 0,
        preview: Preview.fromJson(j['preview']),
        mailbox: j['mailbox'] is Map ? MailboxCard.parse((j['mailbox'] as Map)['pk'], (j['mailbox'] as Map)['relays'], allowLocal: true) : null,
      );
}

class FileMeta {
  final String fileId, name, mime;
  final int size;
  String state;
  int chunks;
  FileMeta({required this.fileId, required this.name, required this.mime, required this.size, required this.state, this.chunks = 0});
  Map<String, Object?> toJson() => {'fileId': fileId, 'name': name, 'mime': mime, 'size': size, 'state': state, 'progress': 0, 'chunks': chunks};
  static FileMeta fromJson(Map j) =>
      FileMeta(fileId: '${j['fileId']}', name: '${j['name']}', mime: '${j['mime']}', size: j['size'] as int? ?? 0, state: '${j['state']}', chunks: j['chunks'] as int? ?? 0);
}

class Message {
  final String id, chat, dir, kind;
  final int ts;
  final String? text;
  FileMeta? file;
  String status; // sending | queued | sent | delivered | read | failed
  final int? expiresAt;
  int? seq;
  Message({required this.id, required this.chat, required this.dir, required this.ts, required this.kind, this.text, this.file, required this.status, this.expiresAt, this.seq});

  bool get isSystem => id.startsWith('sys-');

  Map<String, Object?> toJson() => {
        'id': id,
        'chat': chat,
        'dir': dir,
        'ts': ts,
        'kind': kind,
        if (text != null) 'text': text,
        if (file != null) 'file': file!.toJson(),
        'status': status,
        if (expiresAt != null) 'expiresAt': expiresAt,
        if (seq != null) 'seq': seq,
      };

  static Message fromJson(Map<String, Object?> j) => Message(
        id: j['id'] as String,
        chat: j['chat'] as String,
        dir: j['dir'] as String,
        ts: j['ts'] as int,
        kind: j['kind'] as String,
        text: j['text'] as String?,
        file: j['file'] is Map ? FileMeta.fromJson(j['file'] as Map) : null,
        status: j['status'] as String? ?? 'sent',
        expiresAt: j['expiresAt'] as int?,
        seq: j['seq'] as int?,
      );
}

class Settings {
  bool useStun;
  List<String> stunUrls;
  String turnUrl, turnUser, turnPass;
  bool useRelays;
  List<String> relays;
  bool autoConnect;
  int inviteDays;
  bool enterToSend;
  int autoAcceptMB;
  bool notifications;
  bool notifyNames;
  Settings({
    this.useStun = true,
    this.stunUrls = const ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
    this.turnUrl = '',
    this.turnUser = '',
    this.turnPass = '',
    this.useRelays = true,
    this.relays = defaultRelays,
    this.autoConnect = true,
    this.inviteDays = 7,
    this.enterToSend = false,
    this.autoAcceptMB = 25,
    this.notifications = true,
    this.notifyNames = false,
  });

  Map<String, Object?> toJson() => {
        'useStun': useStun,
        'stunUrls': stunUrls,
        'turnUrl': turnUrl,
        'turnUser': turnUser,
        'turnPass': turnPass,
        'useRelays': useRelays,
        'relays': relays,
        'autoConnect': autoConnect,
        'inviteDays': inviteDays,
        'enterToSend': enterToSend,
        'autoAcceptMB': autoAcceptMB,
        'notifications': notifications,
        'notifyNames': notifyNames,
      };

  static Settings fromJson(Object? j) {
    final s = Settings();
    if (j is! Map) return s;
    return Settings(
      useStun: j['useStun'] as bool? ?? s.useStun,
      stunUrls: (j['stunUrls'] as List?)?.cast<String>() ?? s.stunUrls,
      turnUrl: j['turnUrl'] as String? ?? '',
      turnUser: j['turnUser'] as String? ?? '',
      turnPass: j['turnPass'] as String? ?? '',
      useRelays: j['useRelays'] as bool? ?? true,
      relays: (j['relays'] as List?)?.cast<String>() ?? defaultRelays,
      autoConnect: j['autoConnect'] as bool? ?? true,
      inviteDays: j['inviteDays'] as int? ?? 7,
      enterToSend: j['enterToSend'] as bool? ?? false,
      autoAcceptMB: j['autoAcceptMB'] as int? ?? 25,
      notifications: j['notifications'] as bool? ?? true,
      notifyNames: j['notifyNames'] as bool? ?? false,
    );
  }
}

/// One Double Ratchet epoch for offline messages (newest first, max 2).
class AsyncEpoch {
  final Map<String, Object?> ratchet;
  final String envKey;
  final int created;
  AsyncEpoch(this.ratchet, this.envKey, this.created);
  Map<String, Object?> toJson() => {'ratchet': ratchet, 'envKey': envKey, 'created': created};
  static AsyncEpoch fromJson(Map j) => AsyncEpoch((j['ratchet'] as Map).cast(), j['envKey'] as String, j['created'] as int);
}

/// Signaling channel created by an invite link until the two devices meet.
class ChannelRecord {
  final String iid, role, key, peerId, peerName;
  final MailboxCard sendTo;
  final int expires;
  ChannelRecord({required this.iid, required this.role, required this.key, required this.peerId, required this.peerName, required this.sendTo, required this.expires});
  Map<String, Object?> toJson() => {'iid': iid, 'role': role, 'key': key, 'peerId': peerId, 'peerName': peerName, 'sendTo': sendTo.toJson(), 'expires': expires};
  static ChannelRecord? fromJson(Map j) {
    final card = j['sendTo'] is Map ? MailboxCard.parse((j['sendTo'] as Map)['pk'], (j['sendTo'] as Map)['relays'], allowLocal: true) : null;
    if (card == null) return null;
    return ChannelRecord(iid: '${j['iid']}', role: '${j['role']}', key: '${j['key']}', peerId: '${j['peerId']}', peerName: '${j['peerName']}', sendTo: card, expires: j['expires'] as int);
  }
}

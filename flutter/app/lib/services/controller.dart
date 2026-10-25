import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show StringCharacters;
import 'package:local_auth/local_auth.dart';
import 'package:veil_core/veil_core.dart';

import 'models.dart';
import 'peer.dart';
import 'relay_pool.dart';
import 'session.dart';
import 'vault.dart';

/// Application controller: the Flutter counterpart of app/src/state/app.ts. Every
/// message on the wire matches the web app, so the two talk to each other.

enum Phase { loading, onboarding, locked, ready }

const pageSize = 60;
const _mailboxTypes = {'msg', 'receipt', 'profile', 'disappear', 'mailbox', 'rtc'};
const _mailTtl = 30 * 86400;
const _rtcTtl = 3600;
const _knockTtl = Duration(minutes: 3);
const _offerTtl = Duration(seconds: 90);
const _maxText = 16000;
const appLink = 'https://dmdhrumilmistry.github.io/veil/app/';

class ConnectState {
  final String mode; // invite | join
  final String step; // creating | link | waiting | connecting | error | input | confirm | requested
  final String? link, code, error, peerName;
  final int? expires;
  const ConnectState(this.mode, this.step, {this.link, this.code, this.error, this.peerName, this.expires});
}

class _Pending {
  final PeerLink link;
  final String ref;
  final Role role;
  String hint;
  Session? session;
  _Pending(this.link, this.ref, this.role, this.hint);
}

class _Attempt {
  final String aid;
  final String role; // knocker | offerer | answerer
  final PeerLink? link;
  final DateTime started = DateTime.now();
  _Attempt(this.aid, this.role, [this.link]);
}

class _Seed {
  final Role role;
  final Uint8List sk;
  final String env;
  final Uint8List ad;
  DhKeyPair? bob;
  _Seed(this.role, this.sk, this.env, this.ad);
}

class AppController extends ChangeNotifier {
  Phase phase = Phase.loading;
  Vault? _vault;
  Identity? identity;
  String profileName = '';
  Settings settings = Settings();
  List<Contact> contacts = [];
  final Map<String, List<Message>> messages = {};
  final Map<String, bool> older = {};
  final Map<String, String> presence = {}; // online | connecting
  final Map<String, DateTime> typing = {};
  ConnectState? connect;
  List<(String, RelayState)> relayStatus = [];
  final toasts = StreamController<String>.broadcast();

  final Map<String, Session> _sessions = {};
  _Pending? _pending;
  MailboxKey? _mailbox;
  RelayPool? _pool;
  final Map<String, List<AsyncEpoch>> _async = {};
  final Map<String, _Seed> _seeds = {};
  final Map<String, InviteSecret> _invites = {};
  final Map<String, ChannelRecord> _channels = {};
  final Map<String, _Attempt> _attempts = {};
  final Map<String, DateTime> _lastKnock = {};
  final Map<String, int> _seqs = {};
  final Set<String> _processed = {};
  int _lastEventAt = 0;
  InviteV3? _previewed;
  Timer? _outboxTimer;

  String get myId => identity?.id ?? '';
  Vault get _v => _vault ?? (throw StateError('locked'));
  void _toast(String m) => toasts.add(m);

  // ------------------------------------------------------------------ lifecycle

  Future<void> boot() async {
    phase = await Vault.exists() ? Phase.locked : Phase.onboarding;
    notifyListeners();
  }

  /// Device biometrics / PIN guard the keystore-held master key.
  Future<bool> _authenticate() async {
    final auth = LocalAuthentication();
    try {
      if (!await auth.isDeviceSupported()) return true; // no screen lock configured: nothing to check
      return await auth.authenticate(localizedReason: 'Unlock Veil');
    } catch (_) {
      return false;
    }
  }

  Future<void> createAccount(String name, {required bool useRelays}) async {
    _vault = await Vault.open(create: true);
    final id = await Identity.generate();
    await _v.putJson('identity', {'pub': toB64u(id.pub), 'pkcs8': toB64u(id.toPkcs8())});
    await _v.putJson('profile', {'name': name.trim()});
    await _v.putJson('settings', Settings(useRelays: useRelays).toJson());
    await _enter();
  }

  Future<bool> unlock() async {
    if (!await _authenticate()) return false;
    _vault = await Vault.open();
    await _enter();
    return true;
  }

  Future<void> _enter() async {
    final idj = (await _v.getJson('identity') as Map?)?.cast<String, Object?>();
    if (idj == null) throw StateError('identity missing');
    identity = await Identity.fromPkcs8(fromB64u(idj['pkcs8'] as String));
    profileName = ((await _v.getJson('profile') as Map?)?['name'] as String?) ?? '';
    settings = Settings.fromJson(await _v.getJson('settings'));
    contacts = [for (final c in await _v.listJson('contact/')) Contact.fromJson((c as Map).cast())]..sort((a, b) => b.lastSeen.compareTo(a.lastSeen));
    phase = Phase.ready;
    notifyListeners();
    await _loadOffline();
  }

  void lock() {
    for (final s in _sessions.values.toList()) {
      s.close('Locked');
    }
    _sessions.clear();
    _pending?.link.close();
    _pending = null;
    _pool?.close();
    _pool = null;
    _outboxTimer?.cancel();
    for (final a in _attempts.values) {
      a.link?.close();
    }
    _attempts.clear();
    _async.clear();
    _seeds.clear();
    _invites.clear();
    _channels.clear();
    _seqs.clear();
    messages.clear();
    older.clear();
    presence.clear();
    contacts = [];
    connect = null;
    identity = null;
    _vault?.close();
    _vault = null;
    phase = Phase.locked;
    notifyListeners();
  }

  Future<void> wipeEverything() async {
    lock();
    await Vault.wipe();
    phase = Phase.onboarding;
    notifyListeners();
  }

  Future<void> saveProfileName(String name) async {
    profileName = name.trim();
    await _v.putJson('profile', {'name': profileName});
    for (final s in _sessions.values) {
      unawaited(s.send({'t': 'profile', 'name': profileName}).catchError((_) {}));
    }
    notifyListeners();
  }

  Future<void> saveSettings(Settings s) async {
    settings = s;
    await _v.putJson('settings', s.toJson());
    notifyListeners();
  }

  // ------------------------------------------------------------------ contacts & messages

  Contact? contact(String id) => contacts.where((c) => c.id == id).firstOrNull;

  Future<String> _contactSlot(String id) async => 'contact/${await _v.tag('contact:$id')}';
  Future<String> _chatTag(String id) => _v.tag('chat:$id');

  Future<void> _saveContact(Contact c) async {
    await _v.putJson(await _contactSlot(c.id), c.toJson());
    contacts = [...contacts.where((x) => x.id != c.id), c]..sort((a, b) => b.lastSeen.compareTo(a.lastSeen));
    notifyListeners();
  }

  Future<void> updateContact(String id, void Function(Contact c) change) async {
    final c = contact(id);
    if (c == null) return;
    change(c);
    await _saveContact(c);
  }

  Future<void> deleteContact(String id) async {
    _sessions[id]?.close('Contact deleted');
    _v.deleteChat(await _chatTag(id));
    _v.delete(await _contactSlot(id));
    _v.delete('async/${await _v.tag('async:$id')}');
    _async.remove(id);
    messages.remove(id);
    contacts = contacts.where((c) => c.id != id).toList();
    notifyListeners();
  }

  Future<void> openChat(String id) async {
    if (!messages.containsKey(id)) await _loadFirstPage(id);
    await markRead(id);
    if (settings.autoConnect && !(_sessions[id]?.isReady ?? false) && canMail(id) && DateTime.now().difference(_lastKnock[id] ?? DateTime(2000)) > const Duration(minutes: 5)) {
      unawaited(connectContact(id, quiet: true));
    }
  }

  Future<void> _loadFirstPage(String chat) async {
    final tag = await _chatTag(chat);
    final rows = await _v.pageMessages(tag, null, pageSize + 1);
    older[chat] = rows.length > pageSize;
    messages[chat] = [for (final r in rows.skip(rows.length > pageSize ? 1 : 0)) Message.fromJson(r)];
    notifyListeners();
  }

  bool _loadingOlder = false;
  Future<void> loadOlder(String chat) async {
    final list = messages[chat];
    if (_loadingOlder || list == null || list.isEmpty || older[chat] != true) return;
    _loadingOlder = true;
    try {
      final rows = await _v.pageMessages(await _chatTag(chat), list.first.seq, pageSize + 1);
      older[chat] = rows.length > pageSize;
      messages[chat] = [for (final r in rows.skip(rows.length > pageSize ? 1 : 0)) Message.fromJson(r), ...list];
      notifyListeners();
    } finally {
      _loadingOlder = false;
    }
  }

  Future<void> _saveMessage(Message m) async {
    final tag = await _chatTag(m.chat);
    if (m.seq == null) {
      final n = (_seqs[tag] ?? _v.lastSeq(tag)) + 1;
      _seqs[tag] = n;
      m.seq = n;
    }
    await _v.putMessage(tag, m.seq!, m.toJson());
  }

  Future<void> _setMessage(Message m) async {
    await _saveMessage(m);
    final list = messages[m.chat];
    if (list != null) {
      final i = list.indexWhere((x) => x.id == m.id);
      if (i >= 0) {
        list[i] = m;
      } else {
        list.add(m);
      }
    }
    notifyListeners();
  }

  Future<void> _addMessage(Message m) async {
    await _saveMessage(m);
    if (!messages.containsKey(m.chat)) {
      await _loadFirstPage(m.chat);
    } else {
      messages[m.chat]!.add(m);
    }
    if (!m.isSystem) {
      await updateContact(m.chat, (c) {
        c.preview = Preview(kind: m.kind, text: m.kind == 'file' ? m.file!.name : (m.text ?? '').characters.take(120).toString(), dir: m.dir, ts: m.ts, expiresAt: m.expiresAt);
      });
    }
    notifyListeners();
  }

  Future<void> _systemNote(String chat, String text) =>
      _addMessage(Message(id: 'sys-${randomId()}', chat: chat, dir: 'in', ts: DateTime.now().millisecondsSinceEpoch, kind: 'text', text: text, status: 'read'));

  Message? _find(String chat, String id) => messages[chat]?.where((x) => x.id == id).firstOrNull;

  Future<void> markRead(String chat) async {
    await updateContact(chat, (c) => c.unread = 0);
    final unread = (messages[chat] ?? []).where((m) => m.dir == 'in' && m.status != 'read' && !m.isSystem).toList();
    if (unread.isEmpty) return;
    for (final m in unread) {
      m.status = 'read';
      await _saveMessage(m);
    }
    unawaited(_sendApp(chat, {'t': 'receipt', 's': 'read', 'ids': unread.map((m) => m.id).toList()}).catchError((_) => ''));
    notifyListeners();
  }

  String? activeChat;

  Future<void> sendText(String chat, String text) async {
    final body = text.trim();
    if (body.isEmpty) return;
    if (body.length > _maxText) return _toast('Messages are limited to $_maxText characters');
    if (!(_sessions[chat]?.isReady ?? false) && !canMail(chat)) return _toast('Not connected - reconnect to send');
    final c = contact(chat)!;
    final ts = DateTime.now().millisecondsSinceEpoch;
    final m = Message(id: randomId(), chat: chat, dir: 'out', ts: ts, kind: 'text', text: body, status: 'sending', expiresAt: c.disappearSecs > 0 ? ts + c.disappearSecs * 1000 : null);
    await _addMessage(m);
    try {
      final via = await _sendApp(chat, {'t': 'msg', 'id': m.id, 'ts': ts, 'text': body, if (c.disappearSecs > 0) 'ttl': c.disappearSecs});
      m.status = via == 'live' ? 'sent' : via == 'mailbox' ? 'queued' : 'sending';
    } catch (_) {
      m.status = 'failed';
    }
    await _setMessage(m);
    await updateContact(chat, (c) => c.lastSeen = DateTime.now().millisecondsSinceEpoch);
  }

  DateTime _lastTyping = DateTime(2000);
  void sendTyping(String chat) {
    if (DateTime.now().difference(_lastTyping) < const Duration(seconds: 3)) return;
    _lastTyping = DateTime.now();
    unawaited(_sessions[chat]?.send({'t': 'typing'}).catchError((_) {}));
  }

  Future<void> deleteMessage(Message m) async {
    if (m.seq != null) _v.deleteMessage(await _chatTag(m.chat), m.seq!);
    messages[m.chat]?.removeWhere((x) => x.id == m.id);
    notifyListeners();
  }

  // ------------------------------------------------------------------ incoming application messages

  String? _str(Object? v, int max) => v is String && v.length <= max ? v : null;
  int? _num(Object? v) => v is int && v >= 0 ? v : null;
  bool _isId(Object? v) => v is String && RegExp(r'^[A-Za-z0-9_-]{16,32}$').hasMatch(v);

  Future<void> _onAppMessage(String chat, Map<String, Object?> m, {bool viaMailbox = false}) async {
    if (viaMailbox && !_mailboxTypes.contains(m['t'])) return;
    switch (m['t']) {
      case 'profile':
        final name = _str(m['name'], 48);
        if (name != null) await updateContact(chat, (c) => c.name = name);
      case 'msg':
        final text = _str(m['text'], _maxText);
        if (!_isId(m['id']) || text == null || _find(chat, m['id'] as String) != null) return;
        final now = DateTime.now().millisecondsSinceEpoch;
        final ttl = _num(m['ttl']);
        final ts = _num(m['ts']) ?? now;
        await _addMessage(Message(id: m['id'] as String, chat: chat, dir: 'in', ts: ts > now + 60000 ? now : ts, kind: 'text', text: text, status: 'delivered', expiresAt: ttl != null && ttl > 0 ? now + ttl * 1000 : null));
        unawaited(_sendApp(chat, {'t': 'receipt', 's': 'delivered', 'ids': [m['id']]}).catchError((_) => ''));
        if (activeChat == chat) {
          await markRead(chat);
        } else {
          await updateContact(chat, (c) => c.unread++);
        }
      case 'receipt':
        final st = m['s'] == 'read' ? 'read' : m['s'] == 'delivered' ? 'delivered' : null;
        if (st == null || m['ids'] is! List) return;
        for (final id in (m['ids'] as List).where(_isId).take(500)) {
          final msg = _find(chat, id as String);
          if (msg != null && msg.dir == 'out' && msg.status != 'read') {
            msg.status = st;
            await _setMessage(msg);
          }
        }
      case 'typing':
        typing[chat] = DateTime.now();
        notifyListeners();
        Timer(const Duration(milliseconds: 4200), notifyListeners);
      case 'disappear':
        final secs = _num(m['secs']);
        if (secs == null || secs > 365 * 86400) return;
        await updateContact(chat, (c) => c.disappearSecs = secs);
        await _systemNote(chat, secs > 0 ? 'Disappearing messages turned on' : 'Disappearing messages turned off');
      case 'mailbox':
        if (m['remove'] == true) return updateContact(chat, (c) => c.mailbox = null);
        final card = MailboxCard.parse(m['pk'], m['relays']);
        if (card != null) await updateContact(chat, (c) => c.mailbox = card);
        unawaited(_flushOutbox());
      case 'ratchet-init':
        return _onRatchetInit(chat, m);
      case 'ratchet-hello':
        return _onRatchetHello(chat, m);
      case 'rtc':
        return _handleRtc(chat, null, m, contact(chat)?.displayName ?? '');
      case 'file-offer':
        // Live file transfer is not in this app yet: decline politely so the sender sees it.
        if (_isId(m['fileId'])) unawaited(_sessions[chat]?.send({'t': 'file-decline', 'fileId': m['fileId']}).catchError((_) {}));
        await _systemNote(chat, '${contact(chat)?.displayName ?? 'Your contact'} tried to send a file. File transfer is available in the web app for now.');
    }
  }

  // ------------------------------------------------------------------ live sessions

  Session _startSession(_Pending p, PeerLink link, Role role, Uint8List? expectedPeer, String localSdp, String remoteSdp) {
    String chat = '';
    final early = <Map<String, Object?>>[];
    late Session s;
    s = Session(
      link,
      role,
      identity!,
      expectedPeer,
      localSdp: localSdp,
      remoteSdp: remoteSdp,
      onReady: (peer, asyncRoot) async {
        chat = await _onReady(p, s, peer, asyncRoot);
        for (final m in early) {
          unawaited(_onAppMessage(chat, m));
        }
        early.clear();
      },
      onMessage: (m) => chat.isEmpty ? early.add(m) : unawaited(_onAppMessage(chat, m)),
      onClosed: (reason) {
        _attempts.removeWhere((_, a) => identical(a.link, link));
        if (identical(_pending, p)) {
          _pending = null;
          if (connect != null) connect = ConnectState(connect!.mode, 'error', error: reason);
        }
        if (chat.isNotEmpty && identical(_sessions[chat], s)) {
          _sessions.remove(chat);
          presence.remove(chat);
          if (reason != 'Locked' && reason != 'Replaced by a new connection') _toast('${contact(chat)?.displayName ?? 'Contact'}: $reason');
        }
        notifyListeners();
      },
    );
    p.session = s;
    return s;
  }

  Future<String> _onReady(_Pending p, Session s, Uint8List peer, Uint8List asyncRoot) async {
    final id = toB64u(peer);
    final now = DateTime.now().millisecondsSinceEpoch;
    final existing = contact(id);
    if (existing == null) {
      await _saveContact(Contact(id: id, name: p.hint, addedAt: now, lastSeen: now));
    } else {
      await updateContact(id, (c) => c.lastSeen = now);
    }
    final old = _sessions[id];
    _sessions[id] = s;
    if (old != null && !identical(old, s)) old.close('Replaced by a new connection');
    if (identical(_pending, p)) _pending = null;
    presence[id] = 'online';
    connect = null;
    notifyListeners();
    unawaited(s.send({'t': 'profile', 'name': profileName}).catchError((_) {}));
    await _startAsync(p.role, id, s, peer, asyncRoot);
    await _onConnected(id);
    if (existing == null) await _systemNote(id, 'Connected. Compare safety numbers to verify this contact.');
    _toast('Securely connected to ${contact(id)?.displayName ?? 'contact'}');
    return id;
  }

  bool isOnline(String chat) => _sessions[chat]?.isReady ?? false;

  void disconnect(String chat) => _sessions[chat]?.close('Disconnected');

  // ---- manual one-time codes (peer-to-peer only mode)

  void closeConnect() {
    if (_pending != null && !(_pending!.session?.isReady ?? false)) _pending!.link.close();
    _pending = null;
    connect = null;
    notifyListeners();
  }

  Future<void> createInvite({bool liveCode = false}) async {
    if (!liveCode && _myCard() != null) return createInviteLink();
    closeConnect();
    connect = const ConnectState('invite', 'creating');
    notifyListeners();
    try {
      final link = await createPeer(settings);
      final ref = randomId();
      final p = _Pending(link, ref, Role.initiator, '');
      _pending = p;
      final sdp = await makeOffer(link);
      final code = encodeSignal(Signal(kind: 'offer', sdp: sdp, id: myId, name: profileName, ref: ref));
      if (!identical(_pending, p)) return;
      connect = ConnectState('invite', 'waiting', code: code, link: '$appLink#$code');
    } catch (e) {
      connect = ConnectState('invite', 'error', error: '$e');
    }
    notifyListeners();
  }

  void startJoin() {
    closeConnect();
    connect = const ConnectState('join', 'input');
    notifyListeners();
  }

  /// Handles any pasted/scanned text: invite links, one-time offers and replies.
  Future<void> openCode(String text) async {
    if (extractInvite(text) != null) return _previewInvite(text);
    try {
      final sig = decodeSignal(text);
      if (sig.kind == 'answer') {
        await submitAnswer(text);
        return;
      }
      if (sig.id == myId) throw const FormatException('This is your own invite - send it to someone else');
      closeConnect();
      connect = ConnectState('join', 'creating', peerName: sig.name);
      notifyListeners();
      final link = await createPeer(settings);
      final p = _Pending(link, sig.ref, Role.responder, sig.name);
      _pending = p;
      final sdp = await acceptOffer(link, sig.sdp);
      _startSession(p, link, Role.responder, fromB64u(sig.id), sdp, sig.sdp);
      final code = encodeSignal(Signal(kind: 'answer', sdp: sdp, id: myId, name: profileName, ref: sig.ref));
      if (identical(_pending, p)) connect = ConnectState('join', 'waiting', code: code, link: '$appLink#$code', peerName: sig.name);
    } catch (e) {
      connect = ConnectState('join', 'error', error: e is FormatException ? e.message : '$e');
    }
    notifyListeners();
  }

  Future<void> submitAnswer(String text) async {
    try {
      final sig = decodeSignal(text);
      if (sig.kind != 'answer') throw const FormatException('That is an invite, not a reply.');
      final p = _pending;
      if (p == null || p.role != Role.initiator || p.ref != sig.ref) throw const FormatException('This reply belongs to a different or expired invite');
      p.hint = sig.name;
      connect = const ConnectState('invite', 'connecting');
      notifyListeners();
      await acceptAnswer(p.link, sig.sdp);
      final local = (await p.link.pc.getLocalDescription())!.sdp!;
      _startSession(p, p.link, Role.initiator, fromB64u(sig.id), local, sig.sdp);
    } catch (e) {
      _toast(e is FormatException ? e.message : '$e');
    }
  }

  // ------------------------------------------------------------------ offline messages (Nostr + Double Ratchet)

  bool get _relaysOn => settings.useRelays && settings.relays.isNotEmpty;
  MailboxCard? _myCard() => _mailbox != null && _relaysOn ? MailboxCard(_mailbox!.pk, settings.relays) : null;

  bool canMail(String chat) => _relaysOn && contact(chat)?.mailbox != null && (_async[chat]?.isNotEmpty ?? false);

  Future<void> _loadOffline() async {
    final mb = await _v.getJson('mailbox');
    if (mb is Map && isHexKey(mb['pk']) && mb['sk'] is String) {
      _mailbox = MailboxKey(mb['sk'] as String, mb['pk'] as String);
    } else {
      _mailbox = MailboxKey.generate();
      await _v.putJson('mailbox', _mailbox!.toJson());
    }
    final seen = await _v.getJson('relay-seen');
    if (seen is Map) {
      _processed.addAll((seen['ids'] as List).cast<String>());
      _lastEventAt = seen['last'] as int? ?? 0;
    }
    for (final c in contacts) {
      final st = await _v.getJson('async/${await _v.tag('async:${c.id}')}');
      if (st is Map) _async[c.id] = [for (final e in st['epochs'] as List) AsyncEpoch.fromJson(e as Map)];
    }
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final j in await _v.listJson('invite/')) {
      final inv = InviteSecret.fromJson((j as Map).cast());
      if (inv.exp < now) {
        _v.delete('invite/${inv.iid}');
      } else {
        _invites[inv.iid] = inv;
      }
    }
    for (final j in await _v.listJson('chan/')) {
      final ch = ChannelRecord.fromJson(j as Map);
      if (ch != null && ch.expires > now) _channels[ch.iid] = ch;
    }
    _startPool();
    _outboxTimer = Timer.periodic(const Duration(seconds: 30), (_) => _flushOutbox());
    for (final ch in _channels.values) {
      if (ch.role == 'joiner' && contact(ch.peerId) == null) unawaited(_knock(ch.peerId, ch.iid, ch.peerName));
    }
  }

  void _startPool() {
    _pool?.close();
    _pool = null;
    if (_relaysOn && _mailbox != null) {
      _pool = RelayPool(
        onEvent: (ev) => unawaited(_onWrapped(ev)),
        onStatus: () {
          relayStatus = _pool?.status() ?? [];
          notifyListeners();
        },
      );
      _pool!.setRelays(settings.relays);
      final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      _pool!.subscribe(_mailbox!.pk, [nowS - _mailTtl, _lastEventAt ~/ 1000 - 2 * 86400].reduce((a, b) => a > b ? a : b));
    }
    relayStatus = _pool?.status() ?? [];
    notifyListeners();
  }

  Future<void> setRelays(List<String> list) async {
    final relays = {for (final r in list.map((e) => e.trim()).where((e) => e.isNotEmpty)) normalizeRelay(r)}.take(maxRelays).toList();
    if (relays.isEmpty) throw const FormatException('Add at least one relay, or turn public relays off');
    await saveSettings(settings..relays = relays);
    _startPool();
    await _announceMailbox();
  }

  Future<void> setRelaysEnabled(bool on) async {
    if (!on) await _announceMailbox(remove: true);
    await saveSettings(settings..useRelays = on);
    _startPool();
    if (on) await _announceMailbox();
  }

  Future<void> _announceMailbox({bool remove = false}) async {
    final card = _myCard();
    final msg = remove || card == null ? <String, Object?>{'t': 'mailbox', 'remove': true} : <String, Object?>{'t': 'mailbox', ...card.toJson()};
    for (final c in contacts) {
      unawaited(_sendApp(c.id, msg).catchError((_) => ''));
    }
  }

  Future<void> _saveAsync(String chat) async => _v.putJson('async/${await _v.tag('async:$chat')}', {
        'epochs': [for (final e in _async[chat]!) e.toJson()],
      });

  Future<bool> _publish(MailboxCard card, List<int> content, int ttl, {String? chat, String? msgId}) async {
    final ev = await wrapEvent(card.pk, toB64u(content), ttl);
    final pool = _pool ?? RelayPool(onEvent: (_) {}, onStatus: () {});
    final ok = await pool.publish(ev, card.relays);
    if (_pool == null) pool.close();
    if (!ok && chat != null) await _v.putJson('outbox/${ev['id']}', {'id': ev['id'], 'chat': chat, 'msgId': msgId, 'relays': card.relays, 'event': ev, 'tries': 0});
    return ok;
  }

  Future<void> _flushOutbox() async {
    if (_vault == null || !_relaysOn) return;
    for (final j in await _v.listJson('outbox/')) {
      final item = (j as Map).cast<String, Object?>();
      final ev = (item['event'] as Map).cast<String, Object>();
      final ok = await (_pool ?? RelayPool(onEvent: (_) {}, onStatus: () {})).publish(ev, (item['relays'] as List).cast());
      final m = item['msgId'] is String ? _find(item['chat'] as String, item['msgId'] as String) : null;
      if (ok) {
        _v.delete('outbox/${item['id']}');
        if (m != null && m.status == 'sending') {
          m.status = 'queued';
          await _setMessage(m);
        }
      } else if ((item['tries'] as int) >= 200) {
        _v.delete('outbox/${item['id']}');
        if (m != null) {
          m.status = 'failed';
          await _setMessage(m);
        }
      } else {
        await _v.putJson('outbox/${item['id']}', {...item, 'tries': (item['tries'] as int) + 1});
      }
    }
  }

  /// Live session if connected; otherwise Double Ratchet into the contact's mailbox.
  final Map<String, Future<void>> _asyncQ = {};
  Future<String> _sendApp(String chat, Map<String, Object?> msg) async {
    final s = _sessions[chat];
    if (s?.isReady ?? false) {
      await s!.send(msg);
      return 'live';
    }
    if (!_mailboxTypes.contains(msg['t']) || !canMail(chat)) throw StateError('not connected');
    final done = Completer<String>();
    _asyncQ[chat] = (_asyncQ[chat] ?? Future.value()).then((_) async {
      try {
        final ep = _async[chat]!.first;
        final r = Ratchet.fromJson(ep.ratchet);
        if (!r.canSend) throw StateError('offline channel not ready');
        final sealed = await r.encrypt(utf8.encode(jsonEncode(msg)));
        _async[chat]![0] = AsyncEpoch(r.toJson(), ep.envKey, ep.created);
        await _saveAsync(chat); // persist before anything leaves the device
        final env = await sealEnvelope(fromB64u(ep.envKey), sealed);
        final ok = await _publish(contact(chat)!.mailbox!, env, msg['t'] == 'rtc' ? _rtcTtl : _mailTtl, chat: chat, msgId: msg['t'] == 'msg' ? msg['id'] as String : null);
        done.complete(ok ? 'mailbox' : 'outbox');
      } catch (e) {
        done.completeError(e);
      }
    });
    return done.future;
  }

  Future<void> _onWrapped(Map<String, Object?> ev) async {
    final id = ev['id'] as String;
    if (_processed.contains(id) || _vault == null) return;
    _processed.add(id);
    _lastEventAt = [(_lastEventAt), (ev['created_at'] as int) * 1000].reduce((a, b) => a > b ? a : b);
    unawaited(_v.putJson('relay-seen', {'ids': _processed.toList().reversed.take(3000).toList(), 'last': _lastEventAt}));
    final body = decodeContent(ev['content'] as String);
    if (body == null) return;
    try {
      await _receiveEnvelope(body);
    } catch (e) {
      debugPrint('[veil] relay message dropped: $e');
    }
  }

  Future<void> _receiveEnvelope(Uint8List body) async {
    for (final entry in _async.entries) {
      final chat = entry.key;
      for (var i = 0; i < entry.value.length; i++) {
        final ep = entry.value[i];
        final inner = await openEnvelope(fromB64u(ep.envKey), body);
        if (inner == null) continue;
        final r = Ratchet.fromJson(ep.ratchet);
        final plain = await r.decrypt(inner);
        entry.value[i] = AsyncEpoch(r.toJson(), ep.envKey, ep.created);
        await _saveAsync(chat);
        final msg = jsonDecode(utf8.decode(plain));
        if (msg is Map && msg['t'] is String) await _onAppMessage(chat, msg.cast(), viaMailbox: true);
        return;
      }
    }
    for (final ch in _channels.values.toList()) {
      final plain = await openEnvelope(fromB64u(ch.key), body);
      if (plain == null) continue;
      final m = (jsonDecode(utf8.decode(plain)) as Map).cast<String, Object?>();
      if (m['t'] == 'rtc') await _handleRtc(ch.peerId, ch.iid, m, ch.peerName);
      if (m['t'] == 'invite-used') await _onInviteUsed(ch);
      return;
    }
    for (final inv in _invites.values.toList()) {
      if (inv.exp < DateTime.now().millisecondsSinceEpoch) continue;
      final joined = await openJoin(inv, body);
      if (joined != null) return _onJoin(inv, joined.note, joined.chan);
    }
  }

  Future<void> _startAsync(Role role, String chat, Session s, Uint8List peer, Uint8List asyncRoot) async {
    final zero = Uint8List(32);
    final sk = await hkdf(asyncRoot, zero, utf8Bytes('veil/v1/ratchet/sk'), 32);
    final env = await hkdf(asyncRoot, zero, utf8Bytes('veil/v1/mailbox/env'), 32);
    wipe(asyncRoot);
    final me = identity!.pub;
    final (i, r) = role == Role.initiator ? (me, peer) : (peer, me);
    final seed = _Seed(role, sk, toB64u(env), concat([utf8Bytes('veil/v1/ratchet/ad'), i, r]));
    _seeds[chat] = seed;
    if (role == Role.responder) {
      seed.bob = await generateRatchetKey();
      await s.send({'t': 'ratchet-init', 'pub': toB64u(seed.bob!.pub)});
    }
    final card = _myCard();
    if (card != null) await s.send({'t': 'mailbox', ...card.toJson()});
  }

  Future<void> _addEpoch(String chat, Ratchet r, String env) async {
    _async[chat] = [AsyncEpoch(r.toJson(), env, DateTime.now().millisecondsSinceEpoch), ...?_async[chat]].take(2).toList();
    await _saveAsync(chat);
    notifyListeners();
  }

  Future<void> _onRatchetInit(String chat, Map<String, Object?> m) async {
    final seed = _seeds.remove(chat);
    if (seed == null || seed.role != Role.initiator || m['pub'] is! String) return;
    final pub = fromB64u(m['pub'] as String);
    if (pub.length != 32) return;
    final r = await Ratchet.initAlice(seed.sk, pub, seed.ad);
    final hello = await r.encrypt(utf8.encode('veil-ratchet-hello'));
    wipe(seed.sk);
    await _addEpoch(chat, r, seed.env);
    await _sessions[chat]?.send({'t': 'ratchet-hello', 'm': toB64u(hello)});
  }

  Future<void> _onRatchetHello(String chat, Map<String, Object?> m) async {
    final seed = _seeds.remove(chat);
    if (seed == null || seed.role != Role.responder || seed.bob == null || m['m'] is! String) return;
    final r = Ratchet.initBob(seed.sk, seed.bob!, seed.ad);
    final hello = utf8.decode(await r.decrypt(fromB64u(m['m'] as String)));
    wipe(seed.sk);
    if (hello == 'veil-ratchet-hello') await _addEpoch(chat, r, seed.env);
  }

  // ------------------------------------------------------------------ rendezvous (knock / offer / answer)

  Future<void> _sendRtc(String peer, String? iid, Map<String, Object?> msg) async {
    if (iid == null) {
      await _sendApp(peer, msg);
      return;
    }
    final ch = _channels[iid];
    if (ch == null) throw StateError('invite channel closed');
    final ok = await _publish(ch.sendTo, await sealEnvelope(fromB64u(ch.key), utf8.encode(jsonEncode(msg))), _rtcTtl);
    if (!ok) throw StateError('no relay accepted the message');
  }

  void _setConnecting(String peer, bool on) {
    if (on && presence[peer] != 'online') presence[peer] = 'connecting';
    if (!on && presence[peer] == 'connecting') presence.remove(peer);
    notifyListeners();
  }

  Future<void> _knock(String peer, String? iid, String hint, {bool quiet = true}) async {
    if (isOnline(peer)) return;
    final cur = _attempts[peer];
    if (cur != null && DateTime.now().difference(cur.started) < const Duration(seconds: 20)) return;
    final aid = randomId();
    _attempts[peer] = _Attempt(aid, 'knocker');
    _lastKnock[peer] = DateTime.now();
    _setConnecting(peer, true);
    try {
      await _sendRtc(peer, iid, {'t': 'rtc', 'k': 'knock', 'aid': aid, 'ts': DateTime.now().millisecondsSinceEpoch});
    } catch (e) {
      _attempts.remove(peer);
      _setConnecting(peer, false);
      if (!quiet) _toast('Could not reach ${hint.isEmpty ? 'them' : hint}');
      return;
    }
    Timer(_knockTtl, () {
      if (_attempts[peer]?.aid != aid) return;
      _attempts.remove(peer);
      _setConnecting(peer, false);
      if (!quiet && !isOnline(peer)) _toast('${hint.isEmpty ? 'They' : hint} did not answer. Messages will wait in their mailbox.');
    });
  }

  Future<void> connectContact(String chat, {bool quiet = false}) async {
    if (!canMail(chat)) return createInvite(liveCode: true);
    await _knock(chat, null, contact(chat)!.displayName, quiet: quiet);
  }

  Future<void> _offerTo(String peer, String? iid, String aid, String hint) async {
    _attempts[peer]?.link?.close();
    final link = await createPeer(settings);
    _attempts[peer] = _Attempt(aid, 'offerer', link);
    _setConnecting(peer, true);
    final sdp = await makeOffer(link);
    if (!identical(_attempts[peer]?.link, link)) return link.close();
    await _sendRtc(peer, iid, {'t': 'rtc', 'k': 'offer', 'aid': aid, 'ts': DateTime.now().millisecondsSinceEpoch, 'sdp': sdp});
    Timer(_offerTtl + const Duration(seconds: 30), () {
      if (identical(_attempts[peer]?.link, link) && !isOnline(peer)) {
        link.close();
        _attempts.remove(peer);
        _setConnecting(peer, false);
      }
    });
  }

  bool _wantsConnection(String peer) => _attempts[peer]?.role == 'knocker' || _channels.values.any((c) => c.peerId == peer && c.role == 'joiner');

  Future<void> _handleRtc(String peer, String? iid, Map<String, Object?> m, String hint) async {
    final ts = _num(m['ts']);
    final aid = m['aid'];
    if (ts == null || aid is! String || !_isId(aid) || peer == myId || isOnline(peer)) return;
    final age = DateTime.now().millisecondsSinceEpoch - ts;
    final mine = _attempts[peer];
    final iAmSmaller = myId.compareTo(peer) < 0;

    if (m['k'] == 'knock') {
      if (age > _knockTtl.inMilliseconds || mine?.role == 'offerer' || mine?.role == 'answerer') return;
      if (mine?.role == 'knocker' && !iAmSmaller) return;
      if (mine == null && iid == null && !settings.autoConnect && activeChat != peer) {
        return _systemNote(peer, '${hint.isEmpty ? 'Your contact' : hint} tried to connect. Tap Connect to reach them.');
      }
      return _offerTo(peer, iid, aid, hint);
    }
    final sdp = m['sdp'];
    if (m['k'] == 'offer' && sdp is String && sdp.length < 16000) {
      if (age > _offerTtl.inMilliseconds) {
        if (_wantsConnection(peer)) unawaited(_knock(peer, iid, hint));
        return;
      }
      if (mine?.role == 'offerer' && mine!.aid != aid && iAmSmaller) return;
      if (mine?.role == 'answerer' && mine!.aid == aid) return;
      await mine?.link?.close();
      final link = await createPeer(settings);
      _attempts[peer] = _Attempt(aid, 'answerer', link);
      _setConnecting(peer, true);
      final local = await acceptOffer(link, sdp);
      _startSession(_Pending(link, aid, Role.responder, hint), link, Role.responder, fromB64u(peer), local, sdp);
      await _sendRtc(peer, iid, {'t': 'rtc', 'k': 'answer', 'aid': aid, 'ts': DateTime.now().millisecondsSinceEpoch, 'sdp': local});
      return;
    }
    if (m['k'] == 'answer' && sdp is String && sdp.length < 16000) {
      if (mine?.role != 'offerer' || mine!.aid != aid || mine.link == null) return;
      await acceptAnswer(mine.link!, sdp);
      final local = (await mine.link!.pc.getLocalDescription())!.sdp!;
      _startSession(_Pending(mine.link!, aid, Role.initiator, hint), mine.link!, Role.initiator, fromB64u(peer), local, sdp);
    }
  }

  Future<void> _onConnected(String peer) async {
    _attempts.remove(peer);
    for (final ch in _channels.values.where((c) => c.peerId == peer).toList()) {
      if (ch.role == 'inviter') {
        final inv = _invites[ch.iid];
        if (inv != null) {
          inv.usedAt = DateTime.now().millisecondsSinceEpoch;
          await _v.putJson('invite/${inv.iid}', inv.toJson());
        }
      }
      _channels.remove(ch.iid);
      _v.delete('chan/${ch.iid}');
    }
  }

  // ---- invite links

  Future<void> createInviteLink() async {
    final card = _myCard();
    if (card == null) return _toast('Turn on public relays in Settings to create invite links');
    closeConnect();
    final days = settings.inviteDays.clamp(1, 30);
    final secret = await InviteSecret.create(Duration(days: days));
    await _v.putJson('invite/${secret.iid}', secret.toJson());
    _invites[secret.iid] = secret;
    final inv = InviteV3(id: myId, name: profileName, mb: card.pk, rl: card.relays, ik: secret.ikPub, tok: secret.tok, iid: secret.iid, exp: secret.exp);
    final code = encodeInvite(inv);
    connect = ConnectState('invite', 'link', code: code, link: '$appLink#$code', expires: secret.exp);
    notifyListeners();
  }

  Future<void> _onJoin(InviteSecret inv, JoinNote note, Uint8List chan) async {
    if (note.id == myId) return;
    if (inv.claimedBy != null && inv.claimedBy != note.id) return _onInviteReuse(inv, note, chan);
    if (inv.usedAt != null || isOnline(note.id)) return;
    final reply = MailboxCard.parse(note.reply.pk, note.reply.relays);
    if (reply == null) return;
    inv.claimedBy = note.id;
    inv.claimedName = note.name;
    await _v.putJson('invite/${inv.iid}', inv.toJson());
    final ch = ChannelRecord(iid: inv.iid, role: 'inviter', key: toB64u(chan), peerId: note.id, peerName: note.name, sendTo: reply, expires: inv.exp);
    _channels[ch.iid] = ch;
    await _v.putJson('chan/${ch.iid}', ch.toJson());
    _toast('${note.name.isEmpty ? 'Someone' : note.name} opened your invite - connecting...');
    await _offerTo(note.id, ch.iid, note.aid, note.name);
  }

  Future<void> _onInviteReuse(InviteSecret inv, JoinNote note, Uint8List chan) async {
    final reply = MailboxCard.parse(note.reply.pk, note.reply.relays);
    if (reply != null) {
      unawaited(_publish(reply, await sealEnvelope(chan, utf8.encode(jsonEncode({'t': 'invite-used', 'ts': DateTime.now().millisecondsSinceEpoch}))), _rtcTtl));
    }
    if (inv.conflictReported) return;
    inv.conflictReported = true;
    await _v.putJson('invite/${inv.iid}', inv.toJson());
    final claimed = inv.claimedBy == null ? null : contact(inv.claimedBy!);
    final who = claimed?.displayName ?? inv.claimedName ?? 'the person who used it';
    final warning = 'Someone else also tried to use the invite link that $who joined with. The link may have been intercepted. Compare safety numbers with $who in person or on a call before trusting this chat.';
    if (claimed != null) await _systemNote(claimed.id, warning);
    _toast(warning);
  }

  Future<void> _onInviteUsed(ChannelRecord ch) async {
    if (ch.role != 'joiner' || isOnline(ch.peerId)) return;
    _attempts.remove(ch.peerId);
    _setConnecting(ch.peerId, false);
    _channels.remove(ch.iid);
    _v.delete('chan/${ch.iid}');
    final name = ch.peerName.isEmpty ? 'the person who invited you' : ch.peerName;
    final error = 'This invite link was already used by someone else. If that was not you, the link may have been intercepted. Ask $name for a new link in person or over a channel you trust.';
    if (connect?.mode == 'join') {
      connect = ConnectState('join', 'error', error: error);
      notifyListeners();
    } else {
      _toast(error);
    }
  }

  Future<void> _previewInvite(String text) async {
    try {
      final inv = decodeInvite(text);
      if (inv.id == myId) throw const FormatException('This is your own invite - send it to someone else');
      if (inv.exp < DateTime.now().millisecondsSinceEpoch) throw const FormatException('This invite link has expired. Ask for a new one.');
      _previewed = inv;
      closeConnect();
      if (contact(inv.id) != null && canMail(inv.id)) {
        await connectContact(inv.id);
        return;
      }
      connect = ConnectState('join', 'confirm', peerName: inv.name);
    } catch (e) {
      connect = ConnectState('join', 'error', error: e is FormatException ? e.message : '$e');
    }
    notifyListeners();
  }

  Future<void> acceptInvite() async {
    final inv = _previewed;
    if (inv == null) return;
    connect = ConnectState('join', 'creating', peerName: inv.name);
    notifyListeners();
    try {
      final reply = _myCard();
      if (reply == null) throw const FormatException('Turn on public relays in Settings to accept invite links');
      final aid = randomId();
      final note = JoinNote(iid: inv.iid, tok: inv.tok, id: myId, name: profileName, reply: reply, aid: aid, ts: DateTime.now().millisecondsSinceEpoch);
      final sealed = await sealJoin(inv, note);
      final ch = ChannelRecord(iid: inv.iid, role: 'joiner', key: toB64u(sealed.chan), peerId: inv.id, peerName: inv.name, sendTo: MailboxCard(inv.mb, inv.rl), expires: inv.exp);
      _channels[ch.iid] = ch;
      await _v.putJson('chan/${ch.iid}', ch.toJson());
      _attempts[inv.id] = _Attempt(aid, 'knocker');
      _lastKnock[inv.id] = DateTime.now();
      if (!await _publish(ch.sendTo, sealed.envelope, _mailTtl)) throw const FormatException("Could not reach the inviter's relays. Check your connection and try again.");
      _previewed = null;
      connect = ConnectState('join', 'requested', peerName: inv.name);
    } catch (e) {
      connect = ConnectState('join', 'error', peerName: inv.name, error: e is FormatException ? e.message : '$e');
    }
    notifyListeners();
  }

  // ------------------------------------------------------------------ backup import (from the web or Flutter app)

  /// Imports a .veilbackup file into a fresh vault. Verified completely before writing.
  Future<void> restoreBackup(Uint8List file, String passphrase) async {
    await readBackup(file, passphrase).drain<void>(); // authenticate everything first
    if (await Vault.exists()) await Vault.wipe();
    _vault = await Vault.open(create: true);
    try {
      await for (final e in readBackup(file, passphrase)) {
        switch (e) {
          case ChunkEntry(:final fileId, :final index, :final data):
            await _v.putChunk('${await _v.tag('file:$fileId')}/$index', data);
          case JsonEntry(:final k, :final d):
            final m = (d is Map ? d : const {}).cast<String, Object?>();
            switch (k) {
              case 'identity':
                await Identity.fromPkcs8(fromB64u(m['pkcs8'] as String)); // validate
                await _v.putJson('identity', {'pub': m['pub'], 'pkcs8': m['pkcs8']});
              case 'profile':
                await _v.putJson('profile', {'name': m['name'] ?? ''});
              case 'settings':
                await _v.putJson('settings', Settings.fromJson(m).toJson());
              case 'contact':
                final c = Contact.fromJson(m)..unread = 0;
                await _v.putJson(await _contactSlot(c.id), c.toJson());
              case 'message':
                final msg = Message.fromJson(m)..seq = null;
                if (msg.status == 'sending') msg.status = 'failed';
                await _saveMessage(msg);
            }
        }
      }
      await _enter();
      _toast('Backup restored. Reconnect with contacts to keep chatting.');
    } catch (e) {
      _vault?.close();
      _vault = null;
      await Vault.wipe();
      phase = Phase.onboarding;
      notifyListeners();
      rethrow;
    }
  }

  /// Writes a .veilbackup file the web app can restore (files not included).
  Future<Uint8List> createBackup(String passphrase) async {
    final w = await BackupWriter.create(passphrase);
    final out = BytesBuilder(copy: false)..add(w.header);
    out.add(await w.json('identity', await _v.getJson('identity')));
    out.add(await w.json('profile', {'name': profileName}));
    out.add(await w.json('settings', settings.toJson()));
    for (final c in contacts) {
      out.add(await w.json('contact', (c.toJson()..['unread'] = 0)));
      final tag = await _chatTag(c.id);
      int? before;
      while (true) {
        final rows = await _v.pageMessages(tag, before, 500);
        if (rows.isEmpty) break;
        for (final r in rows) {
          out.add(await w.json('message', r));
        }
        before = rows.first['seq'] as int?;
        if (before == null || rows.length < 500) break;
      }
    }
    out.add(await w.end());
    return out.toBytes();
  }

  String safetyWith(String contactId) => safetyNumber(identity!.pub, fromB64u(contactId));
}

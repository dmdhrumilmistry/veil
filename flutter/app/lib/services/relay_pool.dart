import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:veil_core/veil_core.dart';

/// Public Nostr relays as untrusted pipes (mirrors app/src/net/nostr.ts NostrPool).
enum RelayState { connecting, open, closed }

class _Conn {
  final String url;
  final RelayPool pool;
  final bool subscribing;
  WebSocket? ws;
  RelayState state = RelayState.closed;
  int _backoff = 1000;
  Timer? _timer;
  bool _stopped = false;
  final _acks = <String, Completer<bool>>{};

  _Conn(this.url, this.pool, {this.subscribing = true}) {
    _connect();
  }

  Future<void> _connect() async {
    if (_stopped) return;
    state = RelayState.connecting;
    pool._changed();
    try {
      final ws = await WebSocket.connect(url).timeout(const Duration(seconds: 10));
      if (_stopped) {
        await ws.close();
        return;
      }
      this.ws = ws;
      state = RelayState.open;
      _backoff = 1000;
      pool._changed();
      if (subscribing) pool._resubscribe(this);
      ws.listen(_onMessage, onDone: _onClosed, onError: (_) => _onClosed(), cancelOnError: true);
    } catch (_) {
      _onClosed();
    }
  }

  void _onClosed() {
    state = RelayState.closed;
    for (final a in _acks.values) {
      if (!a.isCompleted) a.complete(false);
    }
    _acks.clear();
    pool._changed();
    if (_stopped) return;
    _timer?.cancel();
    _timer = Timer(Duration(milliseconds: _backoff), _connect);
    _backoff = (_backoff * 2).clamp(1000, 60000);
  }

  void _onMessage(dynamic data) {
    if (data is! String || data.length > 300000) return;
    final Object? msg;
    try {
      msg = jsonDecode(data);
    } catch (_) {
      return;
    }
    if (msg is! List || msg.isEmpty) return;
    if (msg[0] == 'EVENT' && msg.length > 2 && msg[2] is Map) pool._deliver((msg[2] as Map).cast());
    if (msg[0] == 'OK' && msg.length > 2 && msg[1] is String) _acks.remove(msg[1])?.complete(msg[2] == true);
  }

  void send(List<Object?> frame) {
    if (state == RelayState.open) ws?.add(jsonEncode(frame));
  }

  Future<bool> publish(Map<String, Object> ev) {
    if (state != RelayState.open) return Future.value(false);
    final c = Completer<bool>();
    _acks[ev['id'] as String] = c;
    send(['EVENT', ev]);
    return c.future.timeout(const Duration(seconds: 8), onTimeout: () => false);
  }

  void close() {
    _stopped = true;
    _timer?.cancel();
    ws?.close();
    state = RelayState.closed;
  }
}

class RelayPool {
  final void Function(Map<String, Object?> event) onEvent;
  final void Function() onStatus;
  final _conns = <String, _Conn>{};
  Map<String, Object>? _filter;
  final _seen = <String>{};

  RelayPool({required this.onEvent, required this.onStatus});

  void setRelays(List<String> urls) {
    for (final u in _conns.keys.toList()) {
      if (!urls.contains(u)) _conns.remove(u)!.close();
    }
    for (final u in urls) {
      _conns.putIfAbsent(u, () => _Conn(u, this));
    }
    _changed();
  }

  void subscribe(String myPk, int since) {
    _filter = {
      'kinds': [wrapKind],
      '#p': [myPk],
      'since': since,
    };
    for (final c in _conns.values) {
      _resubscribe(c);
    }
  }

  void _resubscribe(_Conn c) {
    if (_filter == null) return;
    c.send(['CLOSE', 'veil']);
    c.send(['REQ', 'veil', _filter]);
  }

  Future<void> _deliver(Map<String, Object?> ev) async {
    final id = ev['id'];
    if (id is! String || _seen.contains(id)) return;
    final p = (_filter?['#p'] as List?)?.first;
    final tags = ev['tags'];
    if (tags is! List || !tags.any((t) => t is List && t.length > 1 && t[0] == 'p' && t[1] == p)) return;
    if (!await verifyEvent(ev)) return;
    _seen.add(id);
    onEvent(ev);
  }

  void _changed() => onStatus();

  /// Publish to the given relays (publish-only connections for ones we do not read).
  Future<bool> publish(Map<String, Object> ev, List<String> relays) async {
    final temp = <_Conn>[];
    final targets = [
      for (final u in relays)
        _conns[u] ??
            (() {
              final c = _Conn(u, this, subscribing: false);
              temp.add(c);
              return c;
            })(),
    ];
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (targets.every((c) => c.state != RelayState.open) && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    final results = await Future.wait(targets.map((c) => c.publish(ev)));
    for (final c in temp) {
      c.close();
    }
    return results.any((r) => r);
  }

  List<(String, RelayState)> status() => [for (final c in _conns.values) (c.url, c.state)];

  void close() {
    for (final c in _conns.values) {
      c.close();
    }
    _conns.clear();
  }
}

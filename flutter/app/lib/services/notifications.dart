import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:veil_core/veil_core.dart' show wrapKind;
import 'package:workmanager/workmanager.dart';

/// Notifications without a push server.
///
/// * While Veil runs (foreground or background) the relay subscription is live, so new
///   messages raise a local notification immediately.
/// * When Veil is closed, a periodic background job (Android WorkManager, iOS background
///   fetch; every ~15 minutes at best, OS permitting) asks the relays whether anything
///   new is addressed to our pseudonymous mailbox key. It only counts events - it never
///   decrypts - so it needs no chat keys. If something is waiting it shows
///   "You have new messages"; opening Veil fetches and decrypts it.
///
/// Notifications never contain message text. Sender names are opt-in.
class Notifications {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static const _storage = FlutterSecureStorage();
  static const _stateKey = 'veil-notify-state-v1';
  static const _task = 'veil-relay-check';
  static bool _ready = false;

  static bool get supported => !kIsWeb && (Platform.isAndroid || Platform.isIOS || Platform.isMacOS || Platform.isLinux);

  static Future<void> init() async {
    if (_ready || !supported) return;
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
        macOS: DarwinInitializationSettings(requestAlertPermission: false),
        linux: LinuxInitializationSettings(defaultActionName: 'Open Veil'),
      ),
    );
    _ready = true;
    if (Platform.isAndroid || Platform.isIOS) {
      await Workmanager().initialize(callbackDispatcher);
      await Workmanager().registerPeriodicTask(
        _task,
        _task,
        frequency: const Duration(minutes: 15),
        constraints: Constraints(networkType: NetworkType.connected),
        existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
      );
    }
  }

  /// Asks the OS for permission (Android 13+, iOS, macOS). Returns whether granted.
  static Future<bool> requestPermission() async {
    await init();
    if (!supported) return false;
    if (Platform.isAndroid) {
      return await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission() ?? false;
    }
    if (Platform.isIOS) {
      return await _plugin.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()?.requestPermissions(alert: true, badge: true, sound: true) ?? false;
    }
    if (Platform.isMacOS) {
      return await _plugin.resolvePlatformSpecificImplementation<MacOSFlutterLocalNotificationsPlugin>()?.requestPermissions(alert: true, badge: true, sound: true) ?? false;
    }
    return true;
  }

  static const _details = NotificationDetails(
    android: AndroidNotificationDetails('veil-messages', 'Messages', channelDescription: 'New messages (never shows message text)', importance: Importance.high, priority: Priority.high, visibility: NotificationVisibility.private),
    iOS: DarwinNotificationDetails(),
    macOS: DarwinNotificationDetails(),
  );

  /// One notification per conversation; newer ones replace it.
  static Future<void> show({required int id, required String title, required String body}) async {
    if (!_ready) return;
    try {
      await _plugin.show(id: id, title: title, body: body, notificationDetails: _details);
    } catch (_) {}
  }

  static Future<void> clear(int id) async {
    if (_ready) await _plugin.cancel(id: id).catchError((_) {});
  }

  /// What the background check needs: our mailbox key, relays and what we already saw.
  /// Kept in the OS keystore (not the database) so the job can read it without unlocking.
  static Future<void> saveState({required String pk, required List<String> relays, required int sinceSeconds, required Iterable<String> seen, required bool enabled}) async {
    if (!supported) return;
    await _storage.write(key: _stateKey, value: jsonEncode({'pk': pk, 'relays': relays, 'since': sinceSeconds, 'seen': seen.toList().reversed.take(500).toList(), 'enabled': enabled}));
  }

  static Future<void> clearState() => _storage.delete(key: _stateKey);
}

/// Background entry point (separate isolate).
@pragma('vm:entry-point')
void callbackDispatcher() {
  Workmanager().executeTask((task, _) async {
    WidgetsFlutterBinding.ensureInitialized();
    try {
      await checkRelaysForMail();
    } catch (_) {}
    return true;
  });
}

/// Counts new events addressed to our mailbox on our relays (no decryption).
Future<int> checkRelaysForMail() async {
  const storage = FlutterSecureStorage();
  final raw = await storage.read(key: Notifications._stateKey);
  if (raw == null) return 0;
  final s = (jsonDecode(raw) as Map).cast<String, Object?>();
  if (s['enabled'] != true) return 0;
  final seen = {...(s['seen'] as List).cast<String>()};
  final fresh = <String>{};
  for (final url in (s['relays'] as List).cast<String>()) {
    try {
      final ws = await WebSocket.connect(url).timeout(const Duration(seconds: 8));
      final done = Completer<void>();
      ws.listen((data) {
        final m = jsonDecode(data as String);
        if (m is List && m.isNotEmpty) {
          if (m[0] == 'EVENT' && m.length > 2 && m[2] is Map && (m[2] as Map)['id'] is String) {
            final id = (m[2] as Map)['id'] as String;
            if (!seen.contains(id)) fresh.add(id);
          }
          if (m[0] == 'EOSE' && !done.isCompleted) done.complete();
        }
      }, onDone: () => done.isCompleted ? null : done.complete(), onError: (_) => done.isCompleted ? null : done.complete());
      ws.add(jsonEncode([
        'REQ',
        'veil-bg',
        {
          'kinds': [wrapKind],
          '#p': [s['pk']],
          'since': s['since'],
          'limit': 50,
        },
      ]));
      await done.future.timeout(const Duration(seconds: 10), onTimeout: () {});
      await ws.close();
    } catch (_) {}
  }
  if (fresh.isNotEmpty) {
    await Notifications.init();
    await Notifications.show(id: 1, title: 'Veil', body: 'You have new messages');
    // Remember them so we notify once per batch.
    s['seen'] = [...seen, ...fresh].reversed.take(500).toList();
    await storage.write(key: Notifications._stateKey, value: jsonEncode(s));
  }
  return fresh.length;
}

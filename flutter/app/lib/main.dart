import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'services/controller.dart';
import 'services/notifications.dart';
import 'ui/gate.dart';
import 'ui/home.dart';
import 'ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  unawaited(Notifications.init());
  runApp(ChangeNotifierProvider(create: (_) => AppController()..boot(), child: const VeilApp()));
}

class VeilApp extends StatefulWidget {
  const VeilApp({super.key});
  @override
  State<VeilApp> createState() => _VeilAppState();
}

class _VeilAppState extends State<VeilApp> with WidgetsBindingObserver {
  final _messenger = GlobalKey<ScaffoldMessengerState>();
  StreamSubscription<String>? _toasts;
  DateTime? _backgroundedAt;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _toasts = context.read<AppController>().toasts.stream.listen((m) => _messenger.currentState?.showSnackBar(SnackBar(content: Text(m), duration: const Duration(seconds: 5))));
  }

  @override
  void dispose() {
    _toasts?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Lock after 5 minutes in the background: closes connections, drops keys from memory.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final c = context.read<AppController>();
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      _backgroundedAt ??= DateTime.now();
      c.onPaused();
    }
    if (state == AppLifecycleState.resumed) {
      final away = _backgroundedAt == null ? Duration.zero : DateTime.now().difference(_backgroundedAt!);
      _backgroundedAt = null;
      if (away > const Duration(minutes: 5) && c.phase == Phase.ready) {
        c.lock();
      } else {
        c.onResumed();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final phase = context.select<AppController, Phase>((c) => c.phase);
    return MaterialApp(
      title: 'Veil',
      debugShowCheckedModeBanner: false,
      scaffoldMessengerKey: _messenger,
      theme: veilTheme(Brightness.light),
      darkTheme: veilTheme(Brightness.dark),
      home: switch (phase) {
        Phase.loading => const Scaffold(body: Center(child: VeilLogo(size: 64))),
        Phase.onboarding => const OnboardingScreen(),
        Phase.locked => const LockScreen(),
        Phase.ready => const HomeScreen(),
      },
    );
  }
}

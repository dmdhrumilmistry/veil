import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:veil_core/veil_core.dart' show BackupError;

import '../services/controller.dart';
import 'theme.dart';

class _GateScaffold extends StatelessWidget {
  final List<Widget> children;
  const _GateScaffold({required this.children});
  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
              ),
            ),
          ),
        ),
      );
}

class _Feature extends StatelessWidget {
  final IconData icon;
  final String text;
  const _Feature(this.icon, this.text);
  @override
  Widget build(BuildContext context) => Card(
        child: ListTile(leading: Icon(icon, color: VeilColors.cyan), title: Text(text, style: const TextStyle(fontSize: 14))),
      );
}

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});
  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  int _step = 0;
  final _name = TextEditingController();
  bool _relays = true;
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final c = context.read<AppController>();
    if (_step == 0) {
      return _GateScaffold(children: [
        const Center(child: VeilLogo(size: 76)),
        const SizedBox(height: 18),
        Text('Welcome to Veil', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineMedium!.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Text('Private conversations that go straight from your device to theirs. No accounts, no phone numbers.', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).hintColor)),
        const SizedBox(height: 20),
        const _Feature(Icons.verified_user_outlined, 'Post-quantum end-to-end encryption'),
        const _Feature(Icons.cable, 'Direct peer-to-peer over WebRTC'),
        const _Feature(Icons.lock_outline, 'Everything stays encrypted on this device'),
        const SizedBox(height: 20),
        GradientButton(label: 'Get started', onPressed: () => setState(() => _step = 1)),
        const SizedBox(height: 10),
        OutlinedButton.icon(icon: const Icon(Icons.restore), label: const Text('Restore from a backup'), onPressed: () => showRestoreSheet(context)),
      ]);
    }
    return _GateScaffold(children: [
      Align(alignment: Alignment.centerLeft, child: IconButton(icon: const Icon(Icons.arrow_back), tooltip: 'Back', onPressed: () => setState(() => _step = 0))),
      Text('Set up this device', style: Theme.of(context).textTheme.headlineSmall!.copyWith(fontWeight: FontWeight.w700)),
      const SizedBox(height: 6),
      Text('Your identity is created here and never uploaded. Veil is unlocked with this device\'s fingerprint, face or screen lock.', style: TextStyle(color: Theme.of(context).hintColor)),
      const SizedBox(height: 18),
      TextField(controller: _name, maxLength: 48, decoration: const InputDecoration(labelText: 'Display name', helperText: 'Shared only with people you connect to')),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        value: _relays,
        onChanged: (v) => setState(() => _relays = v),
        title: const Text('Invite links and offline messages via public relays'),
        subtitle: const Text('Relays only ever carry encrypted data. Turn off for peer-to-peer only.'),
      ),
      const SizedBox(height: 12),
      GradientButton(
        label: _busy ? 'Creating keys...' : 'Create my identity',
        icon: Icons.lock_outline,
        onPressed: _busy
            ? null
            : () async {
                setState(() => _busy = true);
                try {
                  await c.createAccount(_name.text, useRelays: _relays);
                } catch (e) {
                  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
                  setState(() => _busy = false);
                }
              },
      ),
    ]);
  }
}

class LockScreen extends StatefulWidget {
  const LockScreen({super.key});
  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _unlock() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final ok = await context.read<AppController>().unlock().catchError((Object e) {
      _error = '$e';
      return false;
    });
    if (mounted && !ok) {
      setState(() {
        _busy = false;
        _error ??= 'Not unlocked. Try again.';
      });
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
  }

  @override
  Widget build(BuildContext context) => _GateScaffold(children: [
        const Center(child: VeilLogo(size: 64)),
        const SizedBox(height: 16),
        Text('Veil is locked', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall!.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Text('Use your fingerprint, face or screen lock to decrypt your chats.', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).hintColor)),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: VeilColors.danger))),
        const SizedBox(height: 20),
        GradientButton(label: _busy ? 'Unlocking...' : 'Unlock', icon: Icons.fingerprint, onPressed: _busy ? null : _unlock),
        const SizedBox(height: 10),
        TextButton(onPressed: () => showRestoreSheet(context), child: const Text('Restore from a backup instead')),
      ]);
}

/// Restore a .veilbackup (from this app or the web app). Replaces local data.
Future<void> showRestoreSheet(BuildContext context) => showModalBottomSheet<void>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const _RestoreSheet());

class _RestoreSheet extends StatefulWidget {
  const _RestoreSheet();
  @override
  State<_RestoreSheet> createState() => _RestoreSheetState();
}

class _RestoreSheetState extends State<_RestoreSheet> {
  Uint8List? _file;
  String _fileName = '';
  final _pass = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(context).viewInsets.bottom + 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Restore from backup', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text('Works with backups from the Veil web app too. Everything on this device is replaced.', style: TextStyle(color: Theme.of(context).hintColor)),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            icon: const Icon(Icons.file_open_outlined),
            label: Text(_file == null ? 'Choose .veilbackup file' : _fileName),
            onPressed: () async {
              final picked = await FilePicker.pickFiles();
              if (picked.isEmpty) return;
              final bytes = await picked.first.readAsBytes();
              setState(() {
                _file = bytes;
                _fileName = picked.first.name;
              });
            },
          ),
          const SizedBox(height: 12),
          TextField(controller: _pass, obscureText: true, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Backup passphrase')),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(color: VeilColors.danger))),
          const SizedBox(height: 16),
          GradientButton(
            label: _busy ? 'Verifying and restoring...' : 'Restore',
            onPressed: _busy || _file == null || _pass.text.isEmpty
                ? null
                : () async {
                    setState(() {
                      _busy = true;
                      _error = null;
                    });
                    try {
                      await context.read<AppController>().restoreBackup(_file!, _pass.text);
                      if (context.mounted) Navigator.pop(context);
                    } catch (e) {
                      setState(() {
                        _busy = false;
                        _error = e is BackupError ? e.message : '$e';
                      });
                    }
                  },
          ),
        ]),
      );
}

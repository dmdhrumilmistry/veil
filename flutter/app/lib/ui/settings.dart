import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:veil_core/veil_core.dart' show defaultRelays;

import '../services/controller.dart';
import '../services/relay_pool.dart';
import 'theme.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _name = TextEditingController(text: context.read<AppController>().profileName);

  Future<void> _editRelays(AppController c) async {
    final t = TextEditingController(text: c.settings.relays.join('\n'));
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Public relays'),
        content: TextField(controller: t, maxLines: 6, decoration: const InputDecoration(helperText: 'wss:// addresses, one per line, up to 6')),
        actions: [
          TextButton(onPressed: () => t.text = defaultRelays.join('\n'), child: const Text('Defaults')),
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await c.setRelays(t.text.split(RegExp(r'\s+')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _backup(AppController c) async {
    final p1 = TextEditingController();
    final p2 = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Create encrypted backup'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Restorable in this app or the Veil web app. Without the passphrase nobody can open it.'),
          TextField(controller: p1, obscureText: true, decoration: const InputDecoration(labelText: 'Backup passphrase (10+ characters)')),
          TextField(controller: p2, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm')),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Create'))],
      ),
    );
    if (ok != true) return;
    if (p1.text.length < 10 || p1.text != p2.text) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Passphrases must match and be at least 10 characters')));
      return;
    }
    final bytes = await c.createBackup(p1.text);
    final f = File('${(await getTemporaryDirectory()).path}/veil-backup-${DateTime.now().toIso8601String().substring(0, 10)}.veilbackup');
    await f.writeAsBytes(bytes, flush: true);
    await SharePlus.instance.share(ShareParams(files: [XFile(f.path)], text: 'Veil encrypted backup'));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final open = c.relayStatus.where((r) => r.$2 == RelayState.open).length;
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(children: [
              Expanded(child: TextField(controller: _name, maxLength: 48, decoration: const InputDecoration(labelText: 'Display name', counterText: ''))),
              const SizedBox(width: 8),
              FilledButton(onPressed: () => c.saveProfileName(_name.text), child: const Text('Save')),
            ]),
          ),
        ),
        Card(
          child: Column(children: [
            SwitchListTile(
              secondary: const Icon(Icons.public),
              title: const Text('Public relays'),
              subtitle: Text(!c.settings.useRelays ? 'Off - peer-to-peer only' : 'Invite links, offline messages, one-tap reconnect - connected to $open of ${c.relayStatus.length}'),
              value: c.settings.useRelays,
              onChanged: c.setRelaysEnabled,
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text('Everything is end-to-end encrypted and padded before it reaches a relay, and each message is signed by a throwaway key, so relays cannot read anything or tell who sent it. They can see your IP address and timing.', style: TextStyle(fontSize: 12.5)),
            ),
            for (final (url, state) in c.relayStatus)
              ListTile(
                dense: true,
                leading: Icon(Icons.circle, size: 10, color: state == RelayState.open ? VeilColors.success : state == RelayState.connecting ? VeilColors.warn : Colors.grey),
                title: Text(url.replaceFirst(RegExp(r'^wss?://'), '')),
                trailing: Text(state.name),
              ),
            ListTile(leading: const Icon(Icons.edit_outlined), title: const Text('Edit relays'), onTap: () => _editRelays(c)),
          ]),
        ),
        Card(
          child: Column(children: [
            SwitchListTile(
              secondary: const Icon(Icons.notifications_outlined),
              title: const Text('Notifications'),
              subtitle: const Text('Instantly while Veil runs; every ~15 minutes when closed. Never shows message text.'),
              value: c.settings.notifications,
              onChanged: (v) => c.setNotifications(v),
            ),
            if (c.settings.notifications)
              SwitchListTile(
                secondary: const Icon(Icons.badge_outlined),
                title: const Text('Show who it is from'),
                subtitle: const Text('Visible on your lock screen'),
                value: c.settings.notifyNames,
                onChanged: (v) => c.saveSettings(c.settings..notifyNames = v),
              ),
            ListTile(
              leading: const Icon(Icons.download_outlined),
              title: const Text('Auto-accept files up to'),
              trailing: DropdownButton<int>(
                value: const [0, 5, 25, 100, 500].contains(c.settings.autoAcceptMB) ? c.settings.autoAcceptMB : 25,
                underline: const SizedBox(),
                items: [for (final v in const [0, 5, 25, 100, 500]) DropdownMenuItem(value: v, child: Text(v == 0 ? 'Always ask' : '$v MB'))],
                onChanged: (v) => c.saveSettings(c.settings..autoAcceptMB = v ?? 25),
              ),
            ),
          ]),
        ),
        if (c.settings.useRelays)
          Card(
            child: ExpansionTile(
              leading: const Icon(Icons.link),
              title: const Text('Invite links'),
              subtitle: Text('${c.invites.length} active - single use, valid ${c.settings.inviteDays} days'),
              children: [
                for (final i in c.invites)
                  ListTile(
                    dense: true,
                    leading: Icon(i.conflictReported ? Icons.warning_amber : Icons.link, color: i.conflictReported ? VeilColors.danger : null),
                    title: Text(i.conflictReported
                        ? 'Possibly intercepted - verify ${i.claimedName ?? 'this contact'}'
                        : i.usedAt != null
                            ? 'Used by ${i.claimedName ?? 'a contact'}'
                            : i.claimedBy != null
                                ? 'Opened by ${i.claimedName ?? 'someone'}'
                                : 'Waiting to be opened'),
                    subtitle: Text('Expires ${DateTime.fromMillisecondsSinceEpoch(i.exp).toLocal().toString().substring(0, 16)}'),
                    trailing: TextButton(onPressed: () => c.revokeInvite(i.iid), child: Text(i.usedAt != null ? 'Remove' : 'Revoke')),
                  ),
                if (c.invites.isEmpty) const ListTile(dense: true, title: Text('No active invite links')),
              ],
            ),
          ),
        Card(
          child: SwitchListTile(
            secondary: const Icon(Icons.bolt_outlined),
            title: const Text('Connect automatically'),
            subtitle: const Text('When you open a chat, and when contacts reach out - they can tell you are online'),
            value: c.settings.autoConnect,
            onChanged: (v) => c.saveSettings(c.settings..autoConnect = v),
          ),
        ),
        Card(
          child: Column(children: [
            ListTile(leading: const Icon(Icons.backup_outlined), title: const Text('Create encrypted backup'), subtitle: const Text('Move to another device or the web app'), onTap: () => _backup(c)),
            ListTile(leading: const Icon(Icons.lock_outline), title: const Text('Lock now'), onTap: () {
              Navigator.pop(context);
              c.lock();
            }),
            ListTile(
              leading: const Icon(Icons.delete_forever_outlined, color: VeilColors.danger),
              title: const Text('Erase this device', style: TextStyle(color: VeilColors.danger)),
              onTap: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (d) => AlertDialog(
                    title: const Text('Erase everything?'),
                    content: const Text('Deletes every chat and key on this device. Make a backup first.'),
                    actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Erase'))],
                  ),
                );
                if (ok == true) {
                  await c.wipeEverything();
                  if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
                }
              },
            ),
          ]),
        ),
        const SizedBox(height: 8),
        const Center(child: Text('Veil for Android, iOS and desktop - protocol v1, compatible with the web app', style: TextStyle(fontSize: 12))),
      ]),
    );
  }
}

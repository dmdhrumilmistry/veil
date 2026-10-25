import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/controller.dart';
import '../services/models.dart';
import 'chat.dart';
import 'connect.dart';
import 'settings.dart';
import 'theme.dart';

String relativeTime(int ts) {
  final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ts));
  if (d.inMinutes < 1) return 'now';
  if (d.inHours < 1) return '${d.inMinutes}m';
  final t = DateTime.fromMillisecondsSinceEpoch(ts);
  if (d.inHours < 24) return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  return '${t.day}/${t.month}';
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    return Scaffold(
      appBar: AppBar(
        title: const Row(children: [VeilLogo(size: 28), SizedBox(width: 10), Text('Veil', style: TextStyle(fontWeight: FontWeight.w800))]),
        actions: [
          IconButton(tooltip: 'Lock now', icon: const Icon(Icons.lock_outline), onPressed: c.lock),
          IconButton(tooltip: 'Settings', icon: const Icon(Icons.settings_outlined), onPressed: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const SettingsScreen()))),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.add),
        label: const Text('New chat'),
        onPressed: () {
          c.createInvite();
          showConnectSheet(context);
        },
      ),
      body: c.contacts.isEmpty ? const _EmptyState() : ListView.builder(itemCount: c.contacts.length, itemBuilder: (_, i) => _ContactTile(c.contacts[i])),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const VeilLogo(size: 56),
            const SizedBox(height: 16),
            Text('Start your first private chat', style: Theme.of(context).textTheme.titleMedium!.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            for (final (i, s) in ['Create an invite link', 'Send it to someone you trust', 'You connect when they open it'].indexed)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(mainAxisSize: MainAxisSize.min, children: [CircleAvatar(radius: 11, child: Text('${i + 1}', style: const TextStyle(fontSize: 12))), const SizedBox(width: 10), Text(s)]),
              ),
            const SizedBox(height: 16),
            TextButton.icon(icon: const Icon(Icons.link), label: const Text('I have an invite link'), onPressed: () {
              context.read<AppController>().startJoin();
              showConnectSheet(context);
            }),
          ]),
        ),
      );
}

class _ContactTile extends StatelessWidget {
  final Contact contact;
  const _ContactTile(this.contact);
  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final online = c.presence[contact.id] == 'online';
    final typing = DateTime.now().difference(c.typing[contact.id] ?? DateTime(2000)) < const Duration(seconds: 4);
    final p = contact.preview != null && (contact.preview!.expiresAt == null || contact.preview!.expiresAt! > DateTime.now().millisecondsSinceEpoch) ? contact.preview : null;
    final sub = typing
        ? 'typing...'
        : c.presence[contact.id] == 'connecting'
            ? 'Connecting...'
            : p != null
                ? '${p.dir == 'out' ? 'You: ' : ''}${p.kind == 'file' ? '📎 ' : ''}${p.text}'
                : online
                    ? 'Connected'
                    : 'No messages yet';
    final bold = contact.unread > 0;
    return ListTile(
      leading: Avatar(id: contact.id, name: contact.displayName, online: online),
      title: Row(children: [
        Flexible(child: Text(contact.displayName, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: bold ? FontWeight.w700 : FontWeight.w600))),
        if (contact.verified) const Padding(padding: EdgeInsets.only(left: 4), child: Icon(Icons.verified_user, size: 15, color: VeilColors.success)),
      ]),
      subtitle: Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: typing ? VeilColors.cyan : null, fontWeight: bold ? FontWeight.w600 : null)),
      trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text(relativeTime(p?.ts ?? contact.lastSeen), style: TextStyle(fontSize: 12, color: bold ? VeilColors.cyan : Theme.of(context).hintColor)),
        if (contact.unread > 0)
          Container(
            margin: const EdgeInsets.only(top: 4),
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
            decoration: BoxDecoration(gradient: VeilColors.gradient, borderRadius: BorderRadius.circular(99)),
            child: Text(contact.unread > 99 ? '99+' : '${contact.unread}', style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
          ),
      ]),
      onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ChatScreen(contactId: contact.id))),
    );
  }
}

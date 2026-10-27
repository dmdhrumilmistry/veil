import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:veil_core/veil_core.dart' show formatSafetyNumber;

import '../services/controller.dart';
import 'connect.dart';
import 'theme.dart';

class ContactInfoScreen extends StatelessWidget {
  final String contactId;
  const ContactInfoScreen({super.key, required this.contactId});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final contact = c.contact(contactId);
    if (contact == null) return const Scaffold(body: SizedBox());
    final number = c.safetyWith(contactId);
    return Scaffold(
      appBar: AppBar(title: const Text('Contact info')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Center(child: Avatar(id: contact.id, name: contact.displayName, size: 84, online: c.isOnline(contact.id))),
        const SizedBox(height: 10),
        Text(contact.displayName, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 8),
        Center(
          child: Chip(
            avatar: Icon(contact.verified ? Icons.verified_user : Icons.shield_outlined, size: 18, color: contact.verified ? VeilColors.success : null),
            label: Text(contact.verified ? 'Verified' : 'Not verified'),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Safety number', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 6),
              Text('Compare with ${contact.displayName} in person or on a call, or scan each other\'s code. If they match, only the two of you can read this chat.', style: TextStyle(color: Theme.of(context).hintColor, fontSize: 13)),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                alignment: WrapAlignment.center,
                children: [for (final g in formatSafetyNumber(number)) Container(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), color: Theme.of(context).colorScheme.surfaceContainerHighest), child: Text(g, style: const TextStyle(fontFamily: 'monospace', fontSize: 16, letterSpacing: 1.2)))],
              ),
              const SizedBox(height: 12),
              ExpansionTile(title: const Text('Show my QR for them to scan'), children: [Container(color: Colors.white, padding: const EdgeInsets.all(10), child: QrImageView(data: number, size: 200))]),
              if (!contact.verified)
                GradientButton(
                  label: 'Scan their code',
                  icon: Icons.qr_code_scanner,
                  onPressed: () async {
                    final raw = await scanQr(context, (s) => RegExp(r'^\d{60}$').hasMatch(s), hint: 'Scan their safety QR');
                    if (raw == null) return;
                    if (raw == number) {
                      await c.updateContact(contact.id, (x) => x.verified = true);
                      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Verified - only you and ${contact.displayName} can read this chat')));
                    } else if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(backgroundColor: VeilColors.danger, content: Text('Safety numbers do NOT match. Someone may be intercepting your chat with ${contact.displayName}.')));
                    }
                  },
                ),
              const SizedBox(height: 8),
              OutlinedButton(onPressed: () => c.updateContact(contact.id, (x) => x.verified = !x.verified), child: Text(contact.verified ? 'Clear verification' : 'The numbers match')),
            ]),
          ),
        ),
        Card(
          child: Column(children: [
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('Nickname'),
              subtitle: Text(contact.alias ?? (contact.name.isEmpty ? 'Not set' : 'Calls themselves "${contact.name}"')),
              onTap: () async {
                final t = TextEditingController(text: contact.alias ?? '');
                final v = await showDialog<String>(
                  context: context,
                  builder: (d) => AlertDialog(
                    title: const Text('Nickname'),
                    content: TextField(controller: t, maxLength: 48, autofocus: true, decoration: InputDecoration(hintText: contact.name)),
                    actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(d, t.text), child: const Text('Save'))],
                  ),
                );
                if (v != null) await c.setAlias(contact.id, v);
              },
            ),
            ListTile(
              leading: const Icon(Icons.timer_outlined),
              title: const Text('Disappearing messages'),
              subtitle: const Text('Applies to new messages on both devices'),
              trailing: DropdownButton<int>(
                value: const [0, 300, 3600, 86400, 604800].contains(contact.disappearSecs) ? contact.disappearSecs : 0,
                underline: const SizedBox(),
                items: const [
                  DropdownMenuItem(value: 0, child: Text('Off')),
                  DropdownMenuItem(value: 300, child: Text('5 minutes')),
                  DropdownMenuItem(value: 3600, child: Text('1 hour')),
                  DropdownMenuItem(value: 86400, child: Text('1 day')),
                  DropdownMenuItem(value: 604800, child: Text('1 week')),
                ],
                onChanged: (v) => c.setDisappearing(contact.id, v ?? 0),
              ),
            ),
          ]),
        ),
        Card(
          child: Column(children: [
            ListTile(
              leading: const Icon(Icons.mail_outline),
              title: Text(c.canMail(contact.id) ? 'Offline messages on' : contact.mailbox != null ? 'Connect once to enable offline messages' : 'Live only'),
            ),
            ListTile(
              leading: const Icon(Icons.cleaning_services_outlined),
              title: const Text('Clear chat'),
              onTap: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (d) => AlertDialog(
                    title: const Text('Clear chat?'),
                    content: const Text('Deletes all messages and files in this chat from this device.'),
                    actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Clear'))],
                  ),
                );
                if (ok == true) await c.clearChat(contact.id);
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: VeilColors.danger),
              title: const Text('Delete contact', style: TextStyle(color: VeilColors.danger)),
              onTap: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (d) => AlertDialog(
                    title: Text('Delete ${contact.displayName}?'),
                    content: const Text('Deletes the contact and all history from this device.'),
                    actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Delete'))],
                  ),
                );
                if (ok == true) {
                  await c.deleteContact(contact.id);
                  if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
                }
              },
            ),
          ]),
        ),
      ]),
    );
  }
}

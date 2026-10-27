import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/controller.dart';
import '../services/models.dart';
import 'connect.dart';
import 'contact_info.dart';
import 'file_card.dart';
import 'theme.dart';

class ChatScreen extends StatefulWidget {
  final String contactId;
  const ChatScreen({super.key, required this.contactId});
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _scroll = ScrollController();
  final _input = TextEditingController();
  late final AppController _c;

  @override
  void initState() {
    super.initState();
    _c = context.read<AppController>();
    _c.activeChat = widget.contactId;
    _c.openChat(widget.contactId);
    // The list is reversed (newest at the bottom = offset 0): load older near the top.
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 300) _c.loadOlder(widget.contactId);
    });
  }

  @override
  void dispose() {
    if (_c.activeChat == widget.contactId) _c.activeChat = null;
    _scroll.dispose();
    _input.dispose();
    super.dispose();
  }

  void _send() {
    final t = _input.text;
    if (t.trim().isEmpty) return;
    _c.sendText(widget.contactId, t);
    _input.clear();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final contact = c.contact(widget.contactId);
    if (contact == null) return const Scaffold(body: Center(child: Text('Contact deleted')));
    final online = c.isOnline(contact.id);
    final reaching = c.presence[contact.id] == 'connecting';
    final mailable = c.canMail(contact.id);
    final typing = DateTime.now().difference(c.typing[contact.id] ?? DateTime(2000)) < const Duration(seconds: 4);
    final list = c.messages[contact.id];
    final enabled = online || mailable;
    final status = typing
        ? 'typing...'
        : online
            ? 'End-to-end encrypted'
            : reaching
                ? 'Connecting...'
                : mailable
                    ? 'Offline - messages wait in their mailbox'
                    : 'Offline';

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: InkWell(
          onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ContactInfoScreen(contactId: contact.id))),
          child: Row(children: [
            Avatar(id: contact.id, name: contact.displayName, online: online, size: 38),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text(contact.displayName, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
                  if (contact.verified) const Padding(padding: EdgeInsets.only(left: 4), child: Icon(Icons.verified_user, size: 15, color: VeilColors.success)),
                ]),
                Text(status, style: TextStyle(fontSize: 12, color: online || typing ? VeilColors.success : Theme.of(context).hintColor)),
              ]),
            ),
          ]),
        ),
        actions: [
          if (online) IconButton(tooltip: 'Disconnect', icon: const Icon(Icons.link_off), onPressed: () => c.disconnect(contact.id)),
          IconButton(tooltip: 'Contact info', icon: const Icon(Icons.info_outline), onPressed: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ContactInfoScreen(contactId: contact.id)))),
        ],
      ),
      body: Column(children: [
        if (!online)
          _Banner(
            icon: mailable ? Icons.mail_outline : Icons.cable,
            color: mailable ? VeilColors.cyan : Theme.of(context).hintColor,
            title: reaching ? 'Reaching ${contact.displayName}...' : mailable ? '${contact.displayName} is offline' : 'Not connected',
            body: reaching
                ? 'If they have Veil open, you will be connected in a few seconds.'
                : mailable
                    ? 'Messages wait in their mailbox.'
                    : 'Send them a fresh invite to keep chatting.',
            action: reaching
                ? null
                : TextButton(
                    onPressed: () {
                      if (mailable) {
                        c.connectContact(contact.id);
                      } else {
                        c.createInvite(liveCode: true);
                        showConnectSheet(context);
                      }
                    },
                    child: Text(mailable ? 'Connect' : 'Reconnect'),
                  ),
          ),
        if (!contact.verified)
          _Banner(
            icon: Icons.shield_outlined,
            color: VeilColors.warn,
            title: 'Not verified yet',
            body: 'Compare safety numbers so you know only ${contact.displayName} can read this.',
            action: TextButton(onPressed: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ContactInfoScreen(contactId: contact.id))), child: const Text('Verify')),
          ),
        Expanded(
          child: list == null
              ? const Center(child: CircularProgressIndicator())
              : list.isEmpty
                  ? Center(child: Padding(padding: const EdgeInsets.all(32), child: Text('Say hi to ${contact.displayName}. Messages travel directly between your devices, end-to-end encrypted.', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).hintColor))))
                  : ListView.builder(
                      controller: _scroll,
                      reverse: true,
                      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                      itemCount: list.length,
                      itemBuilder: (_, i) {
                        final m = list[list.length - 1 - i];
                        final newer = i > 0 ? list[list.length - i] : null;
                        final last = newer == null || newer.dir != m.dir || newer.isSystem || newer.ts - m.ts > 180000;
                        return _Bubble(m, last: last, onDelete: () => c.deleteMessage(m));
                      },
                    ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              IconButton(
                tooltip: online ? 'Send a file' : 'Files need a live connection',
                icon: const Icon(Icons.add_circle_outline),
                onPressed: online
                    ? () async {
                        final picked = await FilePicker.pickFiles();
                        for (final f in picked) {
                          final size = await f.length() ?? 0;
                          await c.sendFile(contact.id, name: f.name, size: size, mime: mimeFor(f.name), open: () => f.xFile.openRead());
                        }
                      }
                    : null,
              ),
              Expanded(
                child: TextField(
                  controller: _input,
                  enabled: enabled,
                  minLines: 1,
                  maxLines: 6,
                  maxLength: 16000,
                  textCapitalization: TextCapitalization.sentences,
                  onChanged: (_) {
                    setState(() {});
                    c.sendTyping(contact.id);
                  },
                  decoration: InputDecoration(
                    counterText: '',
                    hintText: !enabled ? 'Reconnect to send messages' : online ? 'Message ${contact.displayName}' : 'Leave ${contact.displayName} a message',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              DecoratedBox(
                decoration: BoxDecoration(shape: BoxShape.circle, gradient: _input.text.trim().isEmpty || !enabled ? null : VeilColors.gradient, color: Theme.of(context).colorScheme.surfaceContainerHighest),
                child: IconButton(tooltip: 'Send', icon: const Icon(Icons.send_rounded, color: Colors.white), onPressed: enabled && _input.text.trim().isNotEmpty ? _send : null),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}

class _Banner extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title, body;
  final Widget? action;
  const _Banner({required this.icon, required this.color, required this.title, required this.body, this.action});
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
        padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), color: color.withValues(alpha: 0.08), border: Border.all(color: color.withValues(alpha: 0.3))),
        child: Row(children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
              Text(body, style: TextStyle(fontSize: 12.5, color: Theme.of(context).hintColor)),
            ]),
          ),
          ?action,
        ]),
      );
}

class _Bubble extends StatelessWidget {
  final Message m;
  final bool last;
  final VoidCallback onDelete;
  const _Bubble(this.m, {required this.last, required this.onDelete});

  @override
  Widget build(BuildContext context) {
    if (m.isSystem) {
      return Center(
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(color: VeilColors.violet.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10)),
          child: Text(m.text ?? '', textAlign: TextAlign.center, style: TextStyle(fontSize: 12.5, color: Theme.of(context).hintColor)),
        ),
      );
    }
    final out = m.dir == 'out';
    final t = DateTime.fromMillisecondsSinceEpoch(m.ts);
    final time = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
    final (icon, label) = switch (m.status) {
      'sending' => (Icons.schedule, 'Sending'),
      'queued' => (Icons.mail_outline, 'Waiting in their mailbox'),
      'sent' => (Icons.check, 'Sent'),
      'delivered' => (Icons.done_all, 'Delivered'),
      'read' => (Icons.done_all, 'Read'),
      _ => (Icons.error_outline, 'Failed to send'),
    };
    final r = const Radius.circular(18);
    final small = const Radius.circular(6);
    return Align(
      alignment: out ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: () => showModalBottomSheet<void>(
          context: context,
          builder: (_) => SafeArea(
            child: Wrap(children: [
              if (m.text != null)
                ListTile(leading: const Icon(Icons.copy), title: const Text('Copy text'), onTap: () {
                  Clipboard.setData(ClipboardData(text: m.text!));
                  Navigator.pop(context);
                }),
              ListTile(leading: const Icon(Icons.delete_outline, color: VeilColors.danger), title: const Text('Delete for me'), onTap: () {
                onDelete();
                Navigator.pop(context);
              }),
            ]),
          ),
        ),
        child: Container(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
          margin: EdgeInsets.only(top: 2, bottom: last ? 8 : 2),
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
          decoration: BoxDecoration(
            gradient: out ? VeilColors.gradient : null,
            color: out ? null : Theme.of(context).colorScheme.surface,
            borderRadius: BorderRadius.only(topLeft: r, topRight: r, bottomLeft: out || !last ? r : small, bottomRight: out && last ? small : r),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.end, mainAxisSize: MainAxisSize.min, children: [
            if (m.kind == 'text') SelectableText(m.text ?? '', style: TextStyle(color: out ? Colors.white : null, fontSize: 15)) else FileCard(m),
            if (last)
              Row(mainAxisSize: MainAxisSize.min, children: [
                if (m.expiresAt != null) Icon(Icons.timer_outlined, size: 11, color: out ? Colors.white70 : Theme.of(context).hintColor),
                Text(' $time', style: TextStyle(fontSize: 11, color: out ? Colors.white70 : Theme.of(context).hintColor)),
                if (out) Padding(padding: const EdgeInsets.only(left: 4), child: Icon(icon, size: 14, semanticLabel: label, color: m.status == 'read' ? const Color(0xFFA5F3FC) : Colors.white70)),
              ]),
          ]),
        ),
      ),
    );
  }
}

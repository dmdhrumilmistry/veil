import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../services/controller.dart';
import 'theme.dart';

Future<void> showConnectSheet(BuildContext context) => showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const _ConnectSheet(),
    ).whenComplete(() {
      if (!context.mounted) return;
      final c = context.read<AppController>();
      // Closing the sheet keeps link invites and pending joins alive; only live codes stop.
      if (c.connect?.step == 'waiting' || c.connect?.step == 'error' || c.connect?.step == 'input') c.closeConnect();
    });

/// A QR scanner that returns the first Veil code it sees (invite link, code or safety number).
Future<String?> scanQr(BuildContext context, bool Function(String) accept, {String hint = ''}) => Navigator.push<String>(
      context,
      MaterialPageRoute(
        builder: (_) => Scaffold(
          appBar: AppBar(title: Text(hint.isEmpty ? 'Scan QR code' : hint)),
          body: MobileScanner(onDetect: (capture) {
            for (final b in capture.barcodes) {
              final v = b.rawValue;
              if (v != null && accept(v)) {
                Navigator.pop(context, v);
                return;
              }
            }
          }),
        ),
      ),
    );

class _ConnectSheet extends StatefulWidget {
  const _ConnectSheet();
  @override
  State<_ConnectSheet> createState() => _ConnectSheetState();
}

class _ConnectSheetState extends State<_ConnectSheet> {
  final _paste = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final s = c.connect;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(context).viewInsets.bottom + 24),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (s == null || s.step != 'confirm' && s.step != 'requested')
            SegmentedButton<String>(
              segments: [
                ButtonSegment(value: 'invite', icon: const Icon(Icons.qr_code), label: Text(c.settings.useRelays ? 'Invite link' : 'Create invite')),
                const ButtonSegment(value: 'join', icon: Icon(Icons.link), label: Text('I have a link')),
              ],
              selected: {s?.mode ?? 'invite'},
              onSelectionChanged: (v) => v.first == 'invite' ? c.createInvite() : c.startJoin(),
            ),
          const SizedBox(height: 16),
          ..._body(context, c, s),
          const SizedBox(height: 12),
          Text('Invites carry your public key and how to reach you - never messages.', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: Theme.of(context).hintColor)),
        ]),
      ),
    );
  }

  Widget _qr(String data) => Center(
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18)),
          child: QrImageView(data: data, size: 220, errorCorrectionLevel: QrErrorCorrectLevel.L),
        ),
      );

  List<Widget> _pasteBox(AppController c, String label, String cta, void Function(String) submit) => [
        TextField(controller: _paste, minLines: 2, maxLines: 4, decoration: InputDecoration(labelText: label)),
        const SizedBox(height: 8),
        Row(children: [
          IconButton.outlined(tooltip: 'Paste', icon: const Icon(Icons.content_paste), onPressed: () async {
            final t = (await Clipboard.getData('text/plain'))?.text;
            if (t != null) _paste.text = t;
          }),
          const SizedBox(width: 8),
          IconButton.outlined(tooltip: 'Scan QR', icon: const Icon(Icons.qr_code_scanner), onPressed: () async {
            final v = await scanQr(context, (s) => RegExp(r'VEIL(1[OA]|3I)\.').hasMatch(s));
            if (v != null) submit(v);
          }),
          const SizedBox(width: 8),
          Expanded(child: GradientButton(label: cta, onPressed: () => submit(_paste.text))),
        ]),
      ];

  List<Widget> _body(BuildContext context, AppController c, ConnectState? s) {
    if (s == null || s.step == 'creating' || s.step == 'connecting') {
      return [const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()))];
    }
    if (s.step == 'error') {
      return [
        const Icon(Icons.error_outline, size: 40, color: VeilColors.danger),
        const SizedBox(height: 8),
        Text(s.error ?? 'Something went wrong', textAlign: TextAlign.center),
        const SizedBox(height: 12),
        GradientButton(label: s.mode == 'join' ? 'Use a different link' : 'Try again', onPressed: s.mode == 'join' ? c.startJoin : () => c.createInvite()),
      ];
    }
    if (s.mode == 'invite' && s.step == 'link') {
      final days = s.expires == null ? 7 : ((s.expires! - DateTime.now().millisecondsSinceEpoch) / 86400000).round();
      return [
        Text('Your invite link is ready', style: Theme.of(context).textTheme.titleMedium!.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text('Send it any way you like. When they open it, you connect automatically - even if you are offline right now.', style: TextStyle(color: Theme.of(context).hintColor)),
        const SizedBox(height: 14),
        _qr(s.link!),
        const SizedBox(height: 14),
        GradientButton(label: 'Share link', icon: Icons.ios_share, onPressed: () => SharePlus.instance.share(ShareParams(text: 'Chat with me privately on Veil: ${s.link}'))),
        const SizedBox(height: 8),
        OutlinedButton.icon(icon: const Icon(Icons.copy), label: const Text('Copy link'), onPressed: () => Clipboard.setData(ClipboardData(text: s.link!))),
        const SizedBox(height: 8),
        Text('Works for $days days, for one person.', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).hintColor)),
        TextButton(onPressed: () => c.createInvite(liveCode: true), child: const Text('Both online right now? Use a one-time code instead')),
      ];
    }
    if (s.mode == 'invite' && s.step == 'waiting') {
      return [
        Text('Keep this screen open until they reply - the code stops working if Veil closes.', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).hintColor)),
        const SizedBox(height: 12),
        _qr(s.link!),
        const SizedBox(height: 12),
        GradientButton(label: 'Share code', icon: Icons.ios_share, onPressed: () => SharePlus.instance.share(ShareParams(text: s.link!))),
        const Divider(height: 32),
        ..._pasteBox(c, 'Their reply code', 'Connect', c.submitAnswer),
      ];
    }
    if (s.step == 'input') return _pasteBox(c, 'Invite link or code', 'Continue', c.openCode);
    if (s.step == 'confirm') {
      return [
        Center(child: Avatar(id: s.peerName ?? '?', name: s.peerName ?? '?', size: 72)),
        const SizedBox(height: 12),
        Text('${s.peerName?.isNotEmpty == true ? s.peerName : 'Someone'} invited you to chat', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium!.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Text('End-to-end encrypted, peer-to-peer. Compare safety numbers after connecting to be sure it is really them.', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).hintColor)),
        const SizedBox(height: 16),
        GradientButton(label: 'Connect', icon: Icons.cable, onPressed: c.acceptInvite),
      ];
    }
    if (s.step == 'requested') {
      return [
        const Icon(Icons.mark_email_unread_outlined, size: 48, color: VeilColors.cyan),
        const SizedBox(height: 12),
        Text('Asking ${s.peerName ?? 'them'} to connect...', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium!.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Text('If they have Veil open, you will be connected in a few seconds. Otherwise it happens automatically the next time you are both online. You can close this.', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).hintColor)),
      ];
    }
    // join waiting: show our reply code
    return [
      Text('Send this reply back to ${s.peerName ?? 'the person who invited you'}.', textAlign: TextAlign.center),
      const SizedBox(height: 12),
      _qr(s.link!),
      const SizedBox(height: 12),
      GradientButton(label: 'Share reply', icon: Icons.ios_share, onPressed: () => SharePlus.instance.share(ShareParams(text: s.link!))),
    ];
  }
}

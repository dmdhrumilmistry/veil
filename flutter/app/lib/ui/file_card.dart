import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../services/controller.dart';
import '../services/models.dart';
import 'theme.dart';

String formatBytes(int n) {
  if (n < 1024) return '$n B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  var v = n.toDouble();
  var i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return '${v.toStringAsFixed(v < 10 ? 1 : 0)} ${u[i]}';
}

const _mimes = {
  'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp', 'heic': 'image/heic',
  'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime', 'mp3': 'audio/mpeg', 'ogg': 'audio/ogg', 'wav': 'audio/wav', 'm4a': 'audio/mp4',
  'pdf': 'application/pdf', 'txt': 'text/plain', 'zip': 'application/zip',
};
String mimeFor(String name) => _mimes[name.split('.').last.toLowerCase()] ?? 'application/octet-stream';

/// Only render formats Flutter can decode safely inline; everything else is opaque bytes.
bool _inlineImage(FileMeta f) => RegExp(r'^image/(png|jpeg|gif|webp)$').hasMatch(f.mime) && f.size < 20 * 1024 * 1024;

class FileCard extends StatefulWidget {
  final Message m;
  const FileCard(this.m, {super.key});
  @override
  State<FileCard> createState() => _FileCardState();
}

class _FileCardState extends State<FileCard> {
  Future<Uint8List>? _image;

  Future<void> _share(AppController c) async {
    final f = widget.m.file!;
    try {
      final bytes = await c.loadFile(f);
      final dir = await getTemporaryDirectory();
      final safe = f.name.replaceAll(RegExp(r'[/\\:*?"<>|]'), '_');
      final file = File('${dir.path}/$safe');
      await file.writeAsBytes(bytes, flush: true);
      await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: f.mime)]));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not open file: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final m = widget.m;
    final f = m.file!;
    final out = m.dir == 'out';
    final fg = out ? Colors.white : null;
    final done = c.progress[f.fileId] ?? (f.state == 'done' ? f.size : 0);
    final pct = f.size == 0 ? 1.0 : (done / f.size).clamp(0.0, 1.0);
    final label = switch (f.state) {
      'offered' => out ? 'Waiting for them to accept' : '${formatBytes(f.size)} - accept to download',
      'transferring' => '${(pct * 100).round()}% - ${formatBytes(done)} of ${formatBytes(f.size)}',
      'done' => formatBytes(f.size),
      'declined' => 'Declined',
      'canceled' => 'Canceled',
      'removed' => 'Not included in backup',
      _ => 'Transfer failed',
    };
    if (f.state == 'done' && f.chunks > 0 && _inlineImage(f)) {
      _image ??= c.loadFile(f);
      return GestureDetector(
        onTap: () => _share(c),
        child: FutureBuilder<Uint8List>(
          future: _image,
          builder: (_, snap) => snap.hasData
              ? ClipRRect(borderRadius: BorderRadius.circular(12), child: ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: Image.memory(snap.data!, fit: BoxFit.cover, semanticLabel: f.name)))
              : const SizedBox(width: 160, height: 120, child: Center(child: CircularProgressIndicator())),
        ),
      );
    }
    return ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 220),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), color: out ? Colors.white24 : VeilColors.violet.withValues(alpha: 0.12)),
            child: Icon(Icons.insert_drive_file_outlined, color: out ? Colors.white : VeilColors.violet),
          ),
          const SizedBox(width: 10),
          Flexible(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(f.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: fg, fontWeight: FontWeight.w600)),
              Text(label, style: TextStyle(fontSize: 12, color: f.state == 'failed' || f.state == 'canceled' || f.state == 'declined' ? VeilColors.danger : (out ? Colors.white70 : Theme.of(context).hintColor))),
            ]),
          ),
        ]),
        if (f.state == 'transferring')
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(children: [
              Expanded(child: LinearProgressIndicator(value: pct, color: VeilColors.success, backgroundColor: Colors.white24, borderRadius: BorderRadius.circular(99))),
              IconButton(tooltip: 'Cancel transfer', iconSize: 18, color: fg, icon: const Icon(Icons.close), onPressed: () => c.cancelTransfer(m)),
            ]),
          ),
        if (f.state == 'offered' && !out)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(children: [
              TextButton(onPressed: () => c.declineFile(m), child: const Text('Decline')),
              const Spacer(),
              FilledButton.icon(icon: const Icon(Icons.download, size: 18), label: const Text('Accept'), onPressed: () => c.acceptFile(m)),
            ]),
          ),
        if (f.state == 'offered' && out) Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () => c.cancelTransfer(m), child: Text('Cancel', style: TextStyle(color: fg)))),
        if (f.state == 'done' && f.chunks > 0)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: OutlinedButton.icon(
              style: OutlinedButton.styleFrom(foregroundColor: fg, side: BorderSide(color: out ? Colors.white54 : Theme.of(context).dividerColor)),
              icon: const Icon(Icons.ios_share, size: 18),
              label: const Text('Open / save'),
              onPressed: () => _share(c),
            ),
          ),
      ]),
    );
  }
}

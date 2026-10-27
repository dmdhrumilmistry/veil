import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:veil/services/controller.dart';
import 'package:veil/services/models.dart';
import 'package:veil/ui/file_card.dart';
import 'package:veil/ui/home.dart' show relativeTime;
import 'package:veil/ui/theme.dart';

void main() {
  testWidgets('brand widgets render in light and dark themes', (tester) async {
    for (final b in Brightness.values) {
      await tester.pumpWidget(MaterialApp(
        theme: veilTheme(b),
        home: const Scaffold(
          body: Column(children: [
            VeilLogo(size: 48),
            Avatar(id: 'abc', name: 'Ada Lovelace', online: true),
            GradientButton(label: 'Connect', icon: Icons.cable),
          ]),
        ),
      ));
      expect(find.text('AL'), findsOneWidget);
      expect(find.text('Connect'), findsOneWidget);
    }
  });

  testWidgets('incoming file offer shows accept and decline', (tester) async {
    await tester.pumpWidget(_card(_file('in', 'offered')));
    expect(find.text('holiday.pdf'), findsOneWidget);
    expect(find.text('Accept'), findsOneWidget);
    expect(find.text('Decline'), findsOneWidget);
    expect(find.textContaining('3.0 MB'), findsOneWidget);
  });

  testWidgets('transfers show progress and can be canceled; failures are explained', (tester) async {
    await tester.pumpWidget(_card(_file('out', 'transferring')));
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
    expect(find.byTooltip('Cancel transfer'), findsOneWidget);
    await tester.pumpWidget(_card(_file('in', 'failed')));
    expect(find.text('Transfer failed'), findsOneWidget);
  });

  test('file sizes and mime types', () {
    expect(formatBytes(512), '512 B');
    expect(formatBytes(3 * 1024 * 1024), '3.0 MB');
    expect(mimeFor('photo.JPG'), 'image/jpeg');
    expect(mimeFor('unknown.xyz'), 'application/octet-stream');
  });

  test('relative times', () {
    final now = DateTime.now().millisecondsSinceEpoch;
    expect(relativeTime(now), 'now');
    expect(relativeTime(now - 5 * 60000), '5m');
  });
}

// File cards (no plugins involved: the controller is only read, never booted).
Widget _card(Message m) => ChangeNotifierProvider(
      create: (_) => AppController(),
      child: MaterialApp(theme: veilTheme(Brightness.dark), home: Scaffold(body: Center(child: FileCard(m)))),
    );

Message _file(String dir, String state) => Message(
      id: 'm' * 22,
      chat: 'c' * 43,
      dir: dir,
      ts: DateTime.now().millisecondsSinceEpoch,
      kind: 'file',
      status: 'delivered',
      file: FileMeta(fileId: 'f' * 22, name: 'holiday.pdf', mime: 'application/pdf', size: 3 * 1024 * 1024, state: state),
    );


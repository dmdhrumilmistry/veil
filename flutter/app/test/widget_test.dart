import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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

  test('relative times', () {
    final now = DateTime.now().millisecondsSinceEpoch;
    expect(relativeTime(now), 'now');
    expect(relativeTime(now - 5 * 60000), '5m');
  });
}

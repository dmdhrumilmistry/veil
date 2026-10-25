import 'package:flutter/material.dart';

/// Brand palette shared with the web app and website.
class VeilColors {
  static const violet = Color(0xFF7C5CFF);
  static const cyan = Color(0xFF22D3EE);
  static const success = Color(0xFF34D399);
  static const warn = Color(0xFFFBBF24);
  static const danger = Color(0xFFF87171);
  static const bgDark = Color(0xFF0B0B14);
  static const surfaceDark = Color(0xFF12121F);
  static const gradient = LinearGradient(colors: [violet, cyan], begin: Alignment.topLeft, end: Alignment.bottomRight);
}

ThemeData veilTheme(Brightness b) {
  final dark = b == Brightness.dark;
  final scheme = ColorScheme.fromSeed(seedColor: VeilColors.violet, brightness: b).copyWith(
    primary: VeilColors.violet,
    secondary: VeilColors.cyan,
    surface: dark ? VeilColors.surfaceDark : Colors.white,
    error: VeilColors.danger,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: dark ? VeilColors.bgDark : const Color(0xFFF6F6FB),
    appBarTheme: AppBarTheme(backgroundColor: dark ? VeilColors.surfaceDark : Colors.white, elevation: 0, scrolledUnderElevation: 1),
    cardTheme: CardThemeData(elevation: 0, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)), color: dark ? VeilColors.surfaceDark : Colors.white),
    inputDecorationTheme: InputDecorationTheme(filled: true, border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none)),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(minimumSize: const Size(48, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)))),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}

/// The Veil mark: gradient shield with a V fold.
class VeilLogo extends StatelessWidget {
  final double size;
  const VeilLogo({super.key, this.size = 40});
  @override
  Widget build(BuildContext context) => SizedBox(width: size, height: size, child: CustomPaint(painter: _LogoPainter()));
}

class _LogoPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size s) {
    final k = s.width / 64;
    final shield = Path()
      ..moveTo(32 * k, 4 * k)
      ..lineTo(9 * k, 12 * k)
      ..lineTo(9 * k, 29 * k)
      ..cubicTo(9 * k, 43.5 * k, 18.7 * k, 55.6 * k, 32 * k, 60 * k)
      ..cubicTo(45.3 * k, 55.6 * k, 55 * k, 43.5 * k, 55 * k, 29 * k)
      ..lineTo(55 * k, 12 * k)
      ..close();
    canvas.drawPath(shield, Paint()..shader = VeilColors.gradient.createShader(Offset.zero & s));
    final v = Path()
      ..moveTo(19 * k, 22 * k)
      ..cubicTo(23 * k, 31 * k, 27 * k, 36 * k, 32 * k, 47 * k)
      ..cubicTo(37 * k, 36 * k, 41 * k, 31 * k, 45 * k, 22 * k);
    canvas.drawPath(v, Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4.5 * k
      ..strokeCap = StrokeCap.round);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class GradientButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback? onPressed;
  const GradientButton({super.key, required this.label, this.icon, this.onPressed});
  @override
  Widget build(BuildContext context) => Opacity(
        opacity: onPressed == null ? 0.45 : 1,
        child: DecoratedBox(
          decoration: BoxDecoration(gradient: VeilColors.gradient, borderRadius: BorderRadius.circular(14), boxShadow: [BoxShadow(color: VeilColors.violet.withValues(alpha: 0.3), blurRadius: 18, offset: const Offset(0, 6))]),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: onPressed,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
                  if (icon != null) ...[Icon(icon, color: Colors.white, size: 20), const SizedBox(width: 8)],
                  Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15)),
                ]),
              ),
            ),
          ),
        ),
      );
}

class Avatar extends StatelessWidget {
  final String id, name;
  final bool online;
  final double size;
  const Avatar({super.key, required this.id, required this.name, this.online = false, this.size = 44});
  static const _palette = [
    [Color(0xFF7C5CFF), Color(0xFFA78BFA)],
    [Color(0xFF0EA5E9), Color(0xFF22D3EE)],
    [Color(0xFF10B981), Color(0xFF34D399)],
    [Color(0xFFF59E0B), Color(0xFFFBBF24)],
    [Color(0xFFEF4444), Color(0xFFF87171)],
    [Color(0xFFEC4899), Color(0xFFF472B6)],
    [Color(0xFF6366F1), Color(0xFF818CF8)],
    [Color(0xFF14B8A6), Color(0xFF2DD4BF)],
  ];
  @override
  Widget build(BuildContext context) {
    var h = 0;
    for (final c in id.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    final colors = _palette[h % 8];
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    final initials = parts.isEmpty ? '?' : (parts.first[0] + (parts.length > 1 ? parts.last[0] : '')).toUpperCase();
    return Stack(clipBehavior: Clip.none, children: [
      Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(shape: BoxShape.circle, gradient: LinearGradient(colors: colors)),
        child: Text(initials, style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: size * 0.36)),
      ),
      if (online)
        Positioned(
          right: 0,
          bottom: 0,
          child: Container(width: size * 0.28, height: size * 0.28, decoration: BoxDecoration(color: VeilColors.success, shape: BoxShape.circle, border: Border.all(color: Theme.of(context).colorScheme.surface, width: 2))),
        ),
    ]);
  }
}

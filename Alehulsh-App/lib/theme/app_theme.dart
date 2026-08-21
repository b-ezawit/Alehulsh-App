import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppTheme {
  // Pinkish Brand Color Palette
  static const Color primaryPink = Color(0xFFEC4899); // Vibrant Rose Pink
  static const Color primaryPinkDark = Color(0xFFDB2777); // Deep Pink
  static const Color primaryPinkLight = Color(0xFFF472B6); // Soft Pink
  static const Color pinkAccentBg = Color(0xFFFFF1F2); // Soft Pastel Pink Light Card
  
  // Emergency Red
  static const Color emergencyRed = Color(0xFFEF4444);
  static const Color emergencyRedDark = Color(0xFFDC2626);

  // Dark Theme Palette (Pinkish Obsidian)
  static const Color darkBg = Color(0xFF140D18); // Deep Dark Rose Obsidian
  static const Color darkCard = Color(0xFF221528); // Dark Pinkish Card Container
  static const Color darkCardBorder = Color(0xFF382340); // Border
  static const Color darkTextMain = Color(0xFFFDF2F8);
  static const Color darkTextMuted = Color(0xFFA78BFA);

  // Light Theme Palette (Soft Elegant Pink)
  static const Color lightBg = Color(0xFFFDF4F6); // Soft Creamy Pink Background
  static const Color lightCard = Color(0xFFFFFFFF); // Clean White Card
  static const Color lightCardBorder = Color(0xFFFCE7F3); // Soft Pink Border
  static const Color lightTextMain = Color(0xFF371B28);
  static const Color lightTextMuted = Color(0xFF83536B);

  // DARK THEME
  static ThemeData get darkTheme {
    return ThemeData(
      brightness: Brightness.dark,
      scaffoldBackgroundColor: darkBg,
      primaryColor: primaryPink,
      colorScheme: const ColorScheme.dark(
        primary: primaryPink,
        secondary: emergencyRed,
        surface: darkCard,
        onSurface: darkTextMain,
      ),
      textTheme: TextTheme(
        displayLarge: GoogleFonts.plusJakartaSans(fontSize: 32, fontWeight: FontWeight.bold, color: darkTextMain),
        displayMedium: GoogleFonts.plusJakartaSans(fontSize: 24, fontWeight: FontWeight.bold, color: darkTextMain),
        titleLarge: GoogleFonts.plusJakartaSans(fontSize: 20, fontWeight: FontWeight.w600, color: darkTextMain),
        titleMedium: GoogleFonts.plusJakartaSans(fontSize: 16, fontWeight: FontWeight.w600, color: darkTextMain),
        bodyLarge: GoogleFonts.inter(fontSize: 16, color: darkTextMain),
        bodyMedium: GoogleFonts.inter(fontSize: 14, color: const Color(0xFFD8B4FE)),
        bodySmall: GoogleFonts.inter(fontSize: 12, color: const Color(0xFF9CA3AF)),
      ),
      cardTheme: CardThemeData(
        color: darkCard,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: const BorderSide(color: darkCardBorder, width: 1),
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: Color(0xFF1A1021),
        selectedItemColor: primaryPink,
        unselectedItemColor: Color(0xFF715978),
        type: BottomNavigationBarType.fixed,
        elevation: 10,
      ),
      useMaterial3: true,
    );
  }

  // LIGHT THEME
  static ThemeData get lightTheme {
    return ThemeData(
      brightness: Brightness.light,
      scaffoldBackgroundColor: lightBg,
      primaryColor: primaryPink,
      colorScheme: const ColorScheme.light(
        primary: primaryPink,
        secondary: emergencyRed,
        surface: lightCard,
        onSurface: lightTextMain,
      ),
      textTheme: TextTheme(
        displayLarge: GoogleFonts.plusJakartaSans(fontSize: 32, fontWeight: FontWeight.bold, color: lightTextMain),
        displayMedium: GoogleFonts.plusJakartaSans(fontSize: 24, fontWeight: FontWeight.bold, color: lightTextMain),
        titleLarge: GoogleFonts.plusJakartaSans(fontSize: 20, fontWeight: FontWeight.w600, color: lightTextMain),
        titleMedium: GoogleFonts.plusJakartaSans(fontSize: 16, fontWeight: FontWeight.w600, color: lightTextMain),
        bodyLarge: GoogleFonts.inter(fontSize: 16, color: lightTextMain),
        bodyMedium: GoogleFonts.inter(fontSize: 14, color: lightTextMuted),
        bodySmall: GoogleFonts.inter(fontSize: 12, color: const Color(0xFF9E778D)),
      ),
      cardTheme: CardThemeData(
        color: lightCard,
        elevation: 2,
        shadowColor: primaryPink.withValues(alpha: 0.08),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: const BorderSide(color: lightCardBorder, width: 1),
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: Color(0xFFFFFFFF),
        selectedItemColor: primaryPink,
        unselectedItemColor: Color(0xFFB48FA3),
        type: BottomNavigationBarType.fixed,
        elevation: 10,
      ),
      useMaterial3: true,
    );
  }
}

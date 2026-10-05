import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/user_profile_model.dart';
import '../services/auth_service.dart';
import '../services/localization_service.dart';
import '../services/emergency_ping_service.dart';
import 'main_navigation_screen.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({Key? key}) : super(key: key);

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  bool _isSignUp = true;
  bool _isLoading = false;
  String _errorMessage = '';

  // Form Controllers
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _fullNameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _catNameCtrl = TextEditingController();

  final LocalizationService _loc = LocalizationService();

  // Emergency Contacts during signup (1 to 6 contacts)
  final List<Map<String, TextEditingController>> _contactControllers = [];

  @override
  void initState() {
    super.initState();
    // Add default initial emergency contact
    _addContactField();
  }

  void _addContactField() {
    if (_contactControllers.length < 6) {
      setState(() {
        _contactControllers.add({
          'name': TextEditingController(),
          'email': TextEditingController(),
          'phone': TextEditingController(),
          'relation': TextEditingController(text: _contactControllers.isEmpty ? 'Primary Contact' : 'Trusted Contact'),
        });
      });
    }
  }

  void _removeContactField(int index) {
    if (_contactControllers.length > 1) {
      setState(() {
        _contactControllers.removeAt(index);
      });
    }
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    _fullNameCtrl.dispose();
    _phoneCtrl.dispose();
    _catNameCtrl.dispose();
    for (var m in _contactControllers) {
      m['name']?.dispose();
      m['email']?.dispose();
      m['phone']?.dispose();
      m['relation']?.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _isLoading = true;
      _errorMessage = '';
    });

    try {
      if (_isSignUp) {
        // Validation
        if (_fullNameCtrl.text.isEmpty ||
            _emailCtrl.text.isEmpty ||
            _passwordCtrl.text.isEmpty ||
            _phoneCtrl.text.isEmpty ||
            _catNameCtrl.text.isEmpty) {
          throw Exception(_loc.isAmharic
              ? "እባክዎ ሙሉ ስም፣ ስልክ፣ የይለፍ ቃል እና የድመትዎን ስም ጨምሮ ሁሉንም መስኮች ይሙሉ"
              : "Please fill in all required fields including your cat's name.");
        }

        // Build emergency contacts list
        List<EmergencyContact> contacts = [];
        for (int i = 0; i < _contactControllers.length; i++) {
          var m = _contactControllers[i];
          String name = m['name']!.text.trim();
          String email = m['email']!.text.trim();
          String phone = m['phone']!.text.trim();
          String relation = m['relation']!.text.trim();

          if (name.isNotEmpty && phone.isNotEmpty) {
            contacts.add(EmergencyContact(
              id: "contact_${DateTime.now().millisecondsSinceEpoch}_$i",
              name: name,
              email: email,
              phone: phone,
              relationship: relation.isEmpty ? "Trusted Contact" : relation,
              isPrimary: i == 0,
            ));
          }
        }

        if (contacts.isEmpty) {
          throw Exception(_loc.isAmharic
              ? "እባክዎ ቢያንስ 1 የአደጋ ጊዜ እውቂያ ያስገቡ"
              : "Please provide at least 1 Emergency Contact.");
        }

        await AuthService().signUp(
          email: _emailCtrl.text,
          password: _passwordCtrl.text,
          fullName: _fullNameCtrl.text,
          phoneNumber: _phoneCtrl.text,
          homeAddress: "Live GPS Tracked",
          catName: _catNameCtrl.text,
          emergencyContacts: contacts,
        );
      } else {
        if (_emailCtrl.text.isEmpty || _passwordCtrl.text.isEmpty) {
          throw Exception(_loc.isAmharic
              ? "እባክዎ ኢሜይል እና የይለፍ ቃል ያስገቡ"
              : "Please enter your email and password.");
        }
        await AuthService().signIn(
          email: _emailCtrl.text,
          password: _passwordCtrl.text,
        );
      }

      if (mounted) {
        EmergencyPingService.targetNavigationTab.value = 0;
        Navigator.of(context).pushAndRemoveUntil(
          MaterialPageRoute(builder: (_) => const MainNavigationScreen()),
          (route) => false,
        );
      }
    } catch (e) {
      setState(() {
        _errorMessage = e.toString().replaceAll("Exception: ", "");
      });
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;

    return ValueListenableBuilder<String>(
      valueListenable: _loc.currentLocale,
      builder: (context, currentLang, child) {
        return Scaffold(
          body: Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: isDarkMode
                    ? [AppTheme.darkBg, const Color(0xFF221128)]
                    : [AppTheme.lightBg, const Color(0xFFFCE7F3)],
              ),
            ),
            child: SafeArea(
              child: Center(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      // Language Toggle on Top Right
                      Align(
                        alignment: Alignment.topRight,
                        child: ActionChip(
                          backgroundColor: AppTheme.primaryPink.withValues(alpha: 0.15),
                          side: BorderSide(color: AppTheme.primaryPink.withValues(alpha: 0.5)),
                          label: Text(
                            _loc.tr('lang_btn'),
                            style: const TextStyle(
                              color: AppTheme.primaryPink,
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          avatar: const Icon(Icons.language_rounded, size: 16, color: AppTheme.primaryPink),
                          onPressed: () {
                            _loc.toggleLanguage();
                          },
                        ),
                      ),
                      const SizedBox(height: 8),

                      // App Brand Logo with the Official Stylized Logo
                      Container(
                        width: 90,
                        height: 90,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: AppTheme.primaryPink.withValues(alpha: 0.35),
                              blurRadius: 25,
                              spreadRadius: 4,
                            ),
                          ],
                        ),
                        child: ClipOval(
                          child: Image.asset(
                            'assets/images/app_logo.png',
                            fit: BoxFit.cover,
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        _loc.tr('app_title'),
                        style: TextStyle(
                          fontSize: 32,
                          fontWeight: FontWeight.bold,
                          color: isDarkMode ? AppTheme.darkTextMain : AppTheme.lightTextMain,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _loc.tr('app_subtitle'),
                        style: TextStyle(
                          fontSize: 13,
                          color: isDarkMode ? const Color(0xFFD8B4FE) : AppTheme.lightTextMuted,
                        ),
                        textAlign: TextAlign.center,
                      ),

                      const SizedBox(height: 24),

                      // Form Container Card
                      Container(
                        padding: const EdgeInsets.all(20),
                        decoration: BoxDecoration(
                          color: isDarkMode ? AppTheme.darkCard : Colors.white,
                          borderRadius: BorderRadius.circular(24),
                          border: Border.all(color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withValues(alpha: 0.1),
                              blurRadius: 15,
                              offset: const Offset(0, 5),
                            ),
                          ],
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            // Initial Language Picker Segment (English / አማርኛ)
                            Container(
                              margin: const EdgeInsets.only(bottom: 16),
                              padding: const EdgeInsets.all(4),
                              decoration: BoxDecoration(
                                color: isDarkMode ? const Color(0xFF13091B) : const Color(0xFFF3E8FF),
                                borderRadius: BorderRadius.circular(14),
                                border: Border.all(
                                  color: AppTheme.primaryPink.withValues(alpha: 0.35),
                                ),
                              ),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: GestureDetector(
                                      onTap: () => _loc.setLocale('en'),
                                      child: Container(
                                        padding: const EdgeInsets.symmetric(vertical: 8),
                                        decoration: BoxDecoration(
                                          color: !_loc.isAmharic ? AppTheme.primaryPink : Colors.transparent,
                                          borderRadius: BorderRadius.circular(10),
                                        ),
                                        child: Row(
                                          mainAxisAlignment: MainAxisAlignment.center,
                                          children: [
                                            const Text("🇺🇸", style: TextStyle(fontSize: 14)),
                                            const SizedBox(width: 6),
                                            Text(
                                              "English",
                                              style: TextStyle(
                                                fontWeight: FontWeight.bold,
                                                fontSize: 13,
                                                color: !_loc.isAmharic ? Colors.white : (isDarkMode ? Colors.white70 : Colors.black87),
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  ),
                                  Expanded(
                                    child: GestureDetector(
                                      onTap: () => _loc.setLocale('am'),
                                      child: Container(
                                        padding: const EdgeInsets.symmetric(vertical: 8),
                                        decoration: BoxDecoration(
                                          color: _loc.isAmharic ? AppTheme.primaryPink : Colors.transparent,
                                          borderRadius: BorderRadius.circular(10),
                                        ),
                                        child: Row(
                                          mainAxisAlignment: MainAxisAlignment.center,
                                          children: [
                                            const Text("🇪🇹", style: TextStyle(fontSize: 14)),
                                            const SizedBox(width: 6),
                                            Text(
                                              "አማርኛ",
                                              style: TextStyle(
                                                fontWeight: FontWeight.bold,
                                                fontSize: 13,
                                                color: _loc.isAmharic ? Colors.white : (isDarkMode ? Colors.white70 : Colors.black87),
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),

                            // Toggle Auth Mode (Signup vs Login)
                            Row(
                              children: [
                                Expanded(
                                  child: GestureDetector(
                                    onTap: () => setState(() => _isSignUp = true),
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(vertical: 10),
                                      decoration: BoxDecoration(
                                        color: _isSignUp ? AppTheme.primaryPink : Colors.transparent,
                                        borderRadius: BorderRadius.circular(12),
                                      ),
                                      child: Text(
                                        _loc.tr('auth_signup'),
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                          fontWeight: FontWeight.bold,
                                          color: _isSignUp ? Colors.white : (isDarkMode ? Colors.white60 : Colors.black54),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                                Expanded(
                                  child: GestureDetector(
                                    onTap: () => setState(() => _isSignUp = false),
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(vertical: 10),
                                      decoration: BoxDecoration(
                                        color: !_isSignUp ? AppTheme.primaryPink : Colors.transparent,
                                        borderRadius: BorderRadius.circular(12),
                                      ),
                                      child: Text(
                                        _loc.tr('auth_login'),
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                          fontWeight: FontWeight.bold,
                                          color: !_isSignUp ? Colors.white : (isDarkMode ? Colors.white60 : Colors.black54),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                            ),

                            const SizedBox(height: 20),

                            if (_errorMessage.isNotEmpty) ...[
                              Container(
                                padding: const EdgeInsets.all(10),
                                decoration: BoxDecoration(
                                  color: AppTheme.emergencyRed.withValues(alpha: 0.15),
                                  borderRadius: BorderRadius.circular(10),
                                  border: Border.all(color: AppTheme.emergencyRed.withValues(alpha: 0.5)),
                                ),
                                child: Text(
                                  _errorMessage,
                                  style: const TextStyle(color: AppTheme.emergencyRed, fontSize: 12),
                                  textAlign: TextAlign.center,
                                ),
                              ),
                              const SizedBox(height: 14),
                            ],

                            // Inputs
                            TextField(
                              controller: _emailCtrl,
                              keyboardType: TextInputType.emailAddress,
                              decoration: InputDecoration(
                                labelText: _loc.tr('auth_email'),
                                prefixIcon: const Icon(Icons.email_outlined, size: 20),
                              ),
                            ),
                            const SizedBox(height: 12),
                            TextField(
                              controller: _passwordCtrl,
                              obscureText: true,
                              decoration: InputDecoration(
                                labelText: _loc.tr('auth_password'),
                                prefixIcon: const Icon(Icons.lock_outline_rounded, size: 20),
                              ),
                            ),

                            if (_isSignUp) ...[
                              const SizedBox(height: 12),
                              TextField(
                                controller: _fullNameCtrl,
                                decoration: InputDecoration(
                                  labelText: _loc.tr('auth_fullname'),
                                  prefixIcon: const Icon(Icons.person_outline_rounded, size: 20),
                                ),
                              ),
                              const SizedBox(height: 12),
                              TextField(
                                controller: _phoneCtrl,
                                keyboardType: TextInputType.phone,
                                decoration: InputDecoration(
                                  labelText: _loc.tr('auth_phone'),
                                  prefixIcon: const Icon(Icons.phone_iphone_rounded, size: 20),
                                ),
                              ),

                              const SizedBox(height: 16),
                              const Divider(),
                              const SizedBox(height: 8),

                              // Security Question Box
                              Container(
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                  color: AppTheme.primaryPink.withValues(alpha: 0.08),
                                  borderRadius: BorderRadius.circular(14),
                                  border: Border.all(color: AppTheme.primaryPink.withValues(alpha: 0.3)),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        const Icon(Icons.pets_rounded, color: AppTheme.primaryPink, size: 18),
                                        const SizedBox(width: 6),
                                        Expanded(
                                          child: Text(
                                            _loc.tr('profile_cat_title'),
                                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppTheme.primaryPink),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 4),
                                    Text(
                                      _loc.tr('sos_cat_question'),
                                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: isDarkMode ? Colors.white70 : Colors.black87),
                                    ),
                                    const SizedBox(height: 8),
                                    TextField(
                                      controller: _catNameCtrl,
                                      decoration: InputDecoration(
                                        hintText: _loc.isAmharic ? "የቤት እንስሳዎን ስም ያስገቡ" : "Enter your pet's name",
                                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                      ),
                                    ),
                                    const SizedBox(height: 6),
                                    Row(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        const Icon(Icons.info_outline_rounded, size: 13, color: AppTheme.primaryPink),
                                        const SizedBox(width: 4),
                                        Expanded(
                                          child: Text(
                                            _loc.tr('sos_cat_desc'),
                                            style: TextStyle(
                                              fontSize: 11,
                                              height: 1.3,
                                              color: isDarkMode ? Colors.white60 : Colors.black54,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                              ),

                              const SizedBox(height: 16),
                              const Divider(),
                              const SizedBox(height: 8),

                              // Emergency Contacts Setup Header
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        _loc.tr('profile_tab_contacts'),
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                      ),
                                      Text(
                                        _loc.isAmharic ? "ቢያንስ 1 ያስፈልጋል (እስከ 6)" : "At least 1 required (up to 6)",
                                        style: TextStyle(fontSize: 11, color: isDarkMode ? Colors.white54 : Colors.black54),
                                      ),
                                    ],
                                  ),
                                  if (_contactControllers.length < 6)
                                    TextButton.icon(
                                      onPressed: _addContactField,
                                      icon: const Icon(Icons.add, size: 16, color: AppTheme.primaryPink),
                                      label: Text(_loc.isAmharic ? "ሌላ ጨምር" : "Add Another", style: const TextStyle(color: AppTheme.primaryPink, fontSize: 12)),
                                    ),
                                ],
                              ),
                              const SizedBox(height: 10),

                              ...List.generate(_contactControllers.length, (index) {
                                var m = _contactControllers[index];
                                return Container(
                                  margin: const EdgeInsets.only(bottom: 12),
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: isDarkMode ? Colors.white.withValues(alpha: 0.04) : Colors.grey.shade100,
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(color: isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder),
                                  ),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                        children: [
                                          Text(
                                            _loc.isAmharic ? "እውቂያ #${index + 1}${index == 0 ? ' (ዋና)' : ''}" : "Contact #${index + 1}${index == 0 ? ' (Primary)' : ''}",
                                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: AppTheme.primaryPink),
                                          ),
                                          if (_contactControllers.length > 1)
                                            IconButton(
                                              icon: const Icon(Icons.close, size: 16, color: Colors.redAccent),
                                              onPressed: () => _removeContactField(index),
                                              padding: EdgeInsets.zero,
                                              constraints: const BoxConstraints(),
                                            ),
                                        ],
                                      ),
                                      const SizedBox(height: 6),
                                      TextField(
                                        controller: m['name'],
                                        decoration: InputDecoration(labelText: _loc.isAmharic ? "የእውቂያው ሙሉ ስም" : "Contact Full Name"),
                                      ),
                                      const SizedBox(height: 6),
                                      TextField(
                                        controller: m['email'],
                                        keyboardType: TextInputType.emailAddress,
                                        decoration: InputDecoration(labelText: _loc.isAmharic ? "ኢሜይል (ለአደጋ ጥሪ ማስተላለፊያ)" : "Email (for direct app alert routing)"),
                                      ),
                                      const SizedBox(height: 6),
                                      TextField(
                                        controller: m['phone'],
                                        keyboardType: TextInputType.phone,
                                        decoration: InputDecoration(labelText: _loc.tr('auth_phone')),
                                      ),
                                      const SizedBox(height: 6),
                                      TextField(
                                        controller: m['relation'],
                                        decoration: InputDecoration(labelText: _loc.isAmharic ? "ዝምድና (ለምሳሌ፡ እህት፣ እናት)" : "Relationship (e.g. Sister, Mother)"),
                                      ),
                                    ],
                                  ),
                                );
                              }),
                            ],

                            const SizedBox(height: 20),

                            ElevatedButton(
                              onPressed: _isLoading ? null : _submit,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: AppTheme.primaryPink,
                                padding: const EdgeInsets.symmetric(vertical: 14),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                              ),
                              child: _isLoading
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                                    )
                                  : Text(
                                      _isSignUp ? _loc.tr('auth_create_btn') : _loc.tr('auth_signin_btn'),
                                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Colors.white),
                                    ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

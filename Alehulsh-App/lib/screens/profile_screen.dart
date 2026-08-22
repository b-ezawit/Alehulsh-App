import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/user_profile_model.dart';
import '../services/user_data_service.dart';
import '../services/auth_service.dart';
import '../services/localization_service.dart';
import 'auth_screen.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final UserDataService _userDataService = UserDataService();
  final LocalizationService _loc = LocalizationService();

  @override
  Widget build(BuildContext context) {
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;
    final cardBg = isDarkMode ? AppTheme.darkCard : Colors.white;
    final borderColor = isDarkMode ? AppTheme.darkCardBorder : AppTheme.lightCardBorder;
    final textMain = isDarkMode ? AppTheme.darkTextMain : AppTheme.lightTextMain;
    final textSub = isDarkMode ? const Color(0xFFD8B4FE) : AppTheme.lightTextMuted;

    return ValueListenableBuilder<UserProfile>(
      valueListenable: _userDataService.profileNotifier,
      builder: (context, profile, child) {
        if (!_userDataService.isLoggedIn) {
          return Scaffold(
            appBar: AppBar(
              backgroundColor: Theme.of(context).scaffoldBackgroundColor,
              elevation: 0,
              title: Text(
                _loc.tr('profile_title'),
                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 20),
              ),
            ),
            body: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(24),
                      decoration: BoxDecoration(
                        color: AppTheme.primaryPink.withValues(alpha: 0.12),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.account_circle_outlined,
                        size: 72,
                        color: AppTheme.primaryPink,
                      ),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      _loc.isAmharic ? "መለያዎ አልገባም" : "You are not logged in",
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                        color: textMain,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _loc.isAmharic
                          ? "የአደጋ ጊዜ እውቂያዎችን፣ የደህንነት የድመት ስም ኮድዎን እና የጤና መረጃዎን ለማስተካከል እባክዎ ይግቡ ወይም አዲስ መለያ ይክፈቱ።"
                          : "Please log in or sign up to manage your emergency contacts, security verification code, and personal safety profile.",
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 14,
                        color: textSub,
                        height: 1.4,
                      ),
                    ),
                    const SizedBox(height: 28),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed: () {
                          Navigator.push(
                            context,
                            MaterialPageRoute(builder: (_) => const AuthScreen()),
                          );
                        },
                        icon: const Icon(Icons.login_rounded, color: Colors.white),
                        label: Text(
                          _loc.isAmharic ? "ግባ / አዲስ መለያ ክፈት" : "Login / Create Account",
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppTheme.primaryPink,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        }
        return Scaffold(
          appBar: AppBar(
            backgroundColor: Theme.of(context).scaffoldBackgroundColor,
            elevation: 0,
            title: Text(
              _loc.tr('profile_title'),
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 20),
            ),
            actions: [
              IconButton(
                tooltip: "Edit Profile Details",
                icon: const Icon(Icons.edit_outlined, color: AppTheme.primaryPink),
                onPressed: () => _showEditPersonalInfoDialog(profile),
              ),
              const SizedBox(width: 8),
            ],
          ),
          body: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // 1. Sleek Minimal Profile Header
                Container(
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    color: cardBg,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: borderColor),
                  ),
                  child: Row(
                    children: [
                      CircleAvatar(
                        radius: 30,
                        backgroundColor: AppTheme.primaryPink.withValues(alpha: 0.15),
                        child: Text(
                          profile.fullName.isNotEmpty
                              ? profile.fullName.trim().split(' ').map((e) => e[0]).take(2).join().toUpperCase()
                              : "U",
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                            color: AppTheme.primaryPink,
                          ),
                        ),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              profile.fullName.isNotEmpty ? profile.fullName : "User Profile",
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                                color: textMain,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            if (profile.phoneNumber.isNotEmpty) ...[
                              const SizedBox(height: 4),
                              Row(
                                children: [
                                  const Icon(Icons.phone_iphone_rounded, size: 14, color: AppTheme.primaryPink),
                                  const SizedBox(width: 4),
                                  Expanded(
                                    child: Text(
                                      profile.phoneNumber,
                                      style: TextStyle(fontSize: 13, color: textSub),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                            if (profile.email.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Row(
                                children: [
                                  const Icon(Icons.email_outlined, size: 14, color: AppTheme.primaryPink),
                                  const SizedBox(width: 4),
                                  Expanded(
                                    child: Text(
                                      profile.email,
                                      style: TextStyle(fontSize: 13, color: textSub),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 24),

                // 2. YOUR CAT'S NAME SECTION (SOS Cancel Verification Code)
                Text(
                  _loc.tr('profile_cat_title'),
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: textMain,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  _loc.tr('profile_cat_desc'),
                  style: TextStyle(fontSize: 12, color: textSub),
                ),
                const SizedBox(height: 10),

                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: cardBg,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: borderColor),
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AppTheme.primaryPink.withValues(alpha: 0.15),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.pets_rounded, color: AppTheme.primaryPink, size: 22),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              _loc.isAmharic ? "የደህንነት ማረጋገጫ መልስ" : "Security Verification Answer",
                              style: TextStyle(fontSize: 11, color: textSub),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              profile.catName.isNotEmpty ? "••••••••" : "Not set",
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                                letterSpacing: profile.catName.isNotEmpty ? 4.0 : 0.0,
                                color: textMain,
                              ),
                            ),
                          ],
                        ),
                      ),
                      TextButton.icon(
                        onPressed: () => _showEditCatNameDialog(profile),
                        icon: const Icon(Icons.edit_rounded, size: 16, color: AppTheme.primaryPink),
                        label: Text(
                          _loc.isAmharic ? "ቀይር" : "Change",
                          style: const TextStyle(
                            color: AppTheme.primaryPink,
                            fontWeight: FontWeight.bold,
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 28),

                // 3. EMERGENCY CONTACTS SECTION
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      _loc.tr('profile_contacts_title'),
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: textMain,
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                      decoration: BoxDecoration(
                        color: AppTheme.primaryPink.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        "${profile.emergencyContacts.length}",
                        style: const TextStyle(
                          color: AppTheme.primaryPink,
                          fontWeight: FontWeight.bold,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  _loc.tr('profile_contacts_desc'),
                  style: TextStyle(fontSize: 12, color: textSub),
                ),
                const SizedBox(height: 12),

                if (profile.emergencyContacts.isEmpty)
                  Container(
                    padding: const EdgeInsets.all(24),
                    decoration: BoxDecoration(
                      color: cardBg,
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: borderColor),
                    ),
                    child: Column(
                      children: [
                        Icon(
                          Icons.contact_phone_outlined,
                          size: 44,
                          color: AppTheme.primaryPink.withValues(alpha: 0.4),
                        ),
                        const SizedBox(height: 10),
                        Text(
                          _loc.isAmharic ? "ምንም የአደጋ ጊዜ እውቂያ አልተጨመረም" : "No Emergency Contacts Added",
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.bold,
                            color: textMain,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _loc.isAmharic
                              ? "SOS ሲልኩ ማሳወቂያ እንዲደርሳቸው እውቂያዎችን ያክሉ።"
                              : "Add trusted contacts to automatically alert them during SOS.",
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 12, color: textSub),
                        ),
                      ],
                    ),
                  )
                else
                  ...profile.emergencyContacts.map((contact) => _buildContactCard(contact, isDarkMode, cardBg, borderColor, textMain, textSub)),

                const SizedBox(height: 16),

                // Add Emergency Contact Button
                ElevatedButton.icon(
                  onPressed: () => _showAddContactDialog(),
                  icon: const Icon(Icons.person_add_alt_1_rounded, size: 18, color: Colors.white),
                  label: Text(
                    _loc.tr('profile_add_contact'),
                    style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.bold),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryPink,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                ),

                const SizedBox(height: 36),

                // Log Out Button
                Center(
                  child: TextButton.icon(
                    onPressed: () async {
                      await AuthService().signOut();
                    },
                    icon: const Icon(Icons.logout_rounded, color: Colors.redAccent, size: 18),
                    label: Text(
                      _loc.tr('profile_logout_btn'),
                      style: const TextStyle(
                        color: Colors.redAccent,
                        fontWeight: FontWeight.bold,
                        fontSize: 14,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 20),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildContactCard(
    EmergencyContact contact,
    bool isDarkMode,
    Color cardBg,
    Color borderColor,
    Color textMain,
    Color textSub,
  ) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cardBg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: contact.isPrimary ? AppTheme.primaryPink : borderColor,
          width: contact.isPrimary ? 1.5 : 1,
        ),
      ),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: AppTheme.primaryPink.withValues(alpha: 0.15),
            child: Text(
              contact.name.isNotEmpty ? contact.name[0].toUpperCase() : 'C',
              style: const TextStyle(color: AppTheme.primaryPink, fontWeight: FontWeight.bold),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        contact.name,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.bold,
                          color: textMain,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (contact.isPrimary) ...[
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: AppTheme.primaryPink.withValues(alpha: 0.2),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Text(
                          "PRIMARY",
                          style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppTheme.primaryPink),
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  "${contact.relationship} • ${contact.phone}",
                  style: TextStyle(fontSize: 12, color: textSub),
                  overflow: TextOverflow.ellipsis,
                ),
                if (contact.email.isNotEmpty) ...[
                  const SizedBox(height: 1),
                  Text(
                    contact.email,
                    style: TextStyle(fontSize: 11, color: textSub),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                icon: const Icon(Icons.edit_outlined, color: AppTheme.primaryPink, size: 20),
                tooltip: _loc.isAmharic ? "አስተካክል" : "Edit Contact",
                onPressed: () => _showEditContactDialog(contact),
              ),
              IconButton(
                icon: const Icon(Icons.delete_outline_rounded, color: Colors.redAccent, size: 20),
                tooltip: _loc.isAmharic ? "ሰርዝ" : "Delete",
                onPressed: () => _userDataService.removeEmergencyContact(contact.id),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // DIALOG: Edit Personal Info
  void _showEditPersonalInfoDialog(UserProfile profile) {
    final nameCtrl = TextEditingController(text: profile.fullName);
    final phoneCtrl = TextEditingController(text: profile.phoneNumber);
    final emailCtrl = TextEditingController(text: profile.email);

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(_loc.isAmharic ? "መገለጫ አሻሽል" : "Edit Profile Info"),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameCtrl,
                decoration: InputDecoration(labelText: _loc.isAmharic ? "ሙሉ ስም" : "Full Name"),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: phoneCtrl,
                decoration: InputDecoration(labelText: _loc.isAmharic ? "ስልክ ቁጥር" : "Phone Number"),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: emailCtrl,
                decoration: InputDecoration(labelText: _loc.isAmharic ? "ኢሜይል አድራሻ" : "Email Address"),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(_loc.isAmharic ? "ሰርዝ" : "Cancel"),
          ),
          ElevatedButton(
            onPressed: () {
              final updated = profile.copyWith(
                fullName: nameCtrl.text.trim(),
                phoneNumber: phoneCtrl.text.trim(),
                email: emailCtrl.text.trim(),
              );
              _userDataService.profileNotifier.value = updated;
              _userDataService.syncToFirestore();
              Navigator.pop(ctx);
            },
            style: ElevatedButton.styleFrom(backgroundColor: AppTheme.primaryPink),
            child: Text(_loc.isAmharic ? "አስቀምጥ" : "Save", style: const TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
  }

  // DIALOG: Edit Cat's Name with Previous Name Verification
  void _showEditCatNameDialog(UserProfile profile) {
    final prevCatNameCtrl = TextEditingController();
    final newCatNameCtrl = TextEditingController();
    String? errorMessage;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setModalState) {
          return AlertDialog(
            title: Text(_loc.isAmharic ? "የደህንነት ኮድ (የድመት ስም) ያሻሽሉ" : "Update Security Code"),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _loc.isAmharic
                      ? "የደህንነት ኮድዎን ለመቀየር በመጀመሪያ የቀደመውን ስም ያስገቡ።"
                      : "To change your security verification code, enter your previous cat's name first.",
                  style: const TextStyle(fontSize: 12, color: Colors.grey),
                ),
                const SizedBox(height: 14),

                if (profile.catName.isNotEmpty) ...[
                  TextField(
                    controller: prevCatNameCtrl,
                    obscureText: true,
                    autofocus: true,
                    decoration: InputDecoration(
                      labelText: _loc.isAmharic ? "የቀደመው የድመት ስም" : "Previous Cat's Name",
                      prefixIcon: const Icon(Icons.lock_outline_rounded, color: AppTheme.primaryPink, size: 20),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],

                TextField(
                  controller: newCatNameCtrl,
                  autofocus: profile.catName.isEmpty,
                  decoration: InputDecoration(
                    labelText: _loc.isAmharic ? "አዲስ የድመት ስም" : "New Cat's Name",
                    prefixIcon: const Icon(Icons.pets, color: AppTheme.primaryPink, size: 20),
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),

                if (errorMessage != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    errorMessage!,
                    style: const TextStyle(color: Colors.red, fontSize: 12, fontWeight: FontWeight.bold),
                  ),
                ],
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: Text(_loc.isAmharic ? "ሰርዝ" : "Cancel"),
              ),
              ElevatedButton(
                onPressed: () {
                  final prevInput = prevCatNameCtrl.text.trim().toLowerCase();
                  final currentCat = profile.catName.trim().toLowerCase();
                  final newInput = newCatNameCtrl.text.trim();

                  if (newInput.isEmpty) {
                    setModalState(() {
                      errorMessage = _loc.isAmharic
                          ? "እባክዎ አዲሱን የድመት ስም ያስገቡ!"
                          : "Please enter your new cat's name!";
                    });
                    return;
                  }

                  if (profile.catName.isNotEmpty && prevInput != currentCat) {
                    setModalState(() {
                      errorMessage = _loc.isAmharic
                          ? "የቀደመው የድመት ስም የተሳሳተ ነው!"
                          : "Incorrect previous cat's name verification!";
                    });
                    return;
                  }

                  final updated = profile.copyWith(catName: newInput);
                  _userDataService.profileNotifier.value = updated;
                  _userDataService.syncToFirestore();
                  Navigator.pop(ctx);

                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(_loc.isAmharic ? "የደህንነት ኮድ በተሳካ ሁኔታ ተቀይሯል!" : "Security code successfully updated!"),
                      backgroundColor: Colors.green,
                    ),
                  );
                },
                style: ElevatedButton.styleFrom(backgroundColor: AppTheme.primaryPink),
                child: Text(_loc.isAmharic ? "አረጋግጥና አስቀምጥ" : "Verify & Save", style: const TextStyle(color: Colors.white)),
              ),
            ],
          );
        },
      ),
    );
  }

  // DIALOG: Add Emergency Contact
  void _showAddContactDialog() {
    final nameCtrl = TextEditingController();
    final phoneCtrl = TextEditingController();
    final relationCtrl = TextEditingController();
    final emailCtrl = TextEditingController();
    bool isPrimary = false;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setStateDialog) => AlertDialog(
          title: Text(_loc.isAmharic ? "አዲስ የአደጋ ጊዜ እውቂያ ጨምር" : "Add Emergency Contact"),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameCtrl,
                  decoration: InputDecoration(labelText: _loc.isAmharic ? "የእውቂያ ስም *" : "Contact Name *"),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: phoneCtrl,
                  decoration: InputDecoration(labelText: _loc.isAmharic ? "ስልክ ቁጥር *" : "Phone Number *"),
                  keyboardType: TextInputType.phone,
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: emailCtrl,
                  decoration: InputDecoration(labelText: _loc.isAmharic ? "ኢሜይል (ለአደጋ ጥሪ ማሳወቂያ)" : "Email Address"),
                  keyboardType: TextInputType.emailAddress,
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: relationCtrl,
                  decoration: InputDecoration(labelText: _loc.isAmharic ? "ዝምድና (ለምሳሌ፡ እህት፣ ጓደኛ)" : "Relationship (e.g. Sister, Friend)"),
                ),
                const SizedBox(height: 10),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    _loc.isAmharic ? "ዋነኛ የአደጋ ጊዜ እውቂያ ይሁን" : "Set as Primary Contact",
                    style: const TextStyle(fontSize: 13),
                  ),
                  value: isPrimary,
                  activeColor: AppTheme.primaryPink,
                  onChanged: (val) => setStateDialog(() => isPrimary = val ?? false),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(_loc.isAmharic ? "ሰርዝ" : "Cancel"),
            ),
            ElevatedButton(
              onPressed: () {
                if (nameCtrl.text.trim().isNotEmpty && phoneCtrl.text.trim().isNotEmpty) {
                  _userDataService.addEmergencyContact(
                    EmergencyContact(
                      id: "contact_${DateTime.now().millisecondsSinceEpoch}",
                      name: nameCtrl.text.trim(),
                      phone: phoneCtrl.text.trim(),
                      email: emailCtrl.text.trim(),
                      relationship: relationCtrl.text.trim().isEmpty ? "Emergency Contact" : relationCtrl.text.trim(),
                      isPrimary: isPrimary,
                    ),
                  );
                  Navigator.pop(ctx);
                }
              },
              style: ElevatedButton.styleFrom(backgroundColor: AppTheme.primaryPink),
              child: Text(_loc.isAmharic ? "ጨምር" : "Add Contact", style: const TextStyle(color: Colors.white)),
            ),
          ],
        ),
      ),
    );
  }

  // DIALOG: Edit Emergency Contact
  void _showEditContactDialog(EmergencyContact contact) {
    final nameCtrl = TextEditingController(text: contact.name);
    final phoneCtrl = TextEditingController(text: contact.phone);
    final relationCtrl = TextEditingController(text: contact.relationship);
    final emailCtrl = TextEditingController(text: contact.email);
    bool isPrimary = contact.isPrimary;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setStateDialog) => AlertDialog(
          title: Text(_loc.isAmharic ? "የአደጋ ጊዜ እውቂያ አሻሽል" : "Edit Emergency Contact"),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameCtrl,
                  decoration: InputDecoration(labelText: _loc.isAmharic ? "የእውቂያ ስም *" : "Contact Name *"),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: phoneCtrl,
                  decoration: InputDecoration(labelText: _loc.isAmharic ? "ስልክ ቁጥር *" : "Phone Number *"),
                  keyboardType: TextInputType.phone,
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: emailCtrl,
                  decoration: InputDecoration(labelText: _loc.isAmharic ? "ኢሜይል (ለአደጋ ጥሪ ማሳወቂያ)" : "Email Address"),
                  keyboardType: TextInputType.emailAddress,
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: relationCtrl,
                  decoration: InputDecoration(labelText: _loc.isAmharic ? "ዝምድና (ለምሳሌ፡ እህት፣ ጓደኛ)" : "Relationship (e.g. Sister, Friend)"),
                ),
                const SizedBox(height: 10),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    _loc.isAmharic ? "ዋነኛ የአደጋ ጊዜ እውቂያ ይሁን" : "Set as Primary Contact",
                    style: const TextStyle(fontSize: 13),
                  ),
                  value: isPrimary,
                  activeColor: AppTheme.primaryPink,
                  onChanged: (val) => setStateDialog(() => isPrimary = val ?? false),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(_loc.isAmharic ? "ሰርዝ" : "Cancel"),
            ),
            ElevatedButton(
              onPressed: () {
                if (nameCtrl.text.trim().isNotEmpty && phoneCtrl.text.trim().isNotEmpty) {
                  _userDataService.updateEmergencyContact(
                    contact.copyWith(
                      name: nameCtrl.text.trim(),
                      phone: phoneCtrl.text.trim(),
                      email: emailCtrl.text.trim(),
                      relationship: relationCtrl.text.trim().isEmpty ? "Emergency Contact" : relationCtrl.text.trim(),
                      isPrimary: isPrimary,
                    ),
                  );
                  Navigator.pop(ctx);
                }
              },
              style: ElevatedButton.styleFrom(backgroundColor: AppTheme.primaryPink),
              child: Text(_loc.isAmharic ? "አስቀምጥ" : "Save Changes", style: const TextStyle(color: Colors.white)),
            ),
          ],
        ),
      ),
    );
  }
}

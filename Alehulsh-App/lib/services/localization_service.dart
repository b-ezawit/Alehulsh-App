import 'package:flutter/material.dart';

class LocalizationService {
  static final LocalizationService _instance = LocalizationService._internal();
  factory LocalizationService() => _instance;
  LocalizationService._internal();

  // 'en' for English, 'am' for Amharic (አማርኛ)
  final ValueNotifier<String> currentLocale = ValueNotifier<String>('en');

  bool get isAmharic => currentLocale.value == 'am';

  void toggleLanguage() {
    currentLocale.value = currentLocale.value == 'en' ? 'am' : 'en';
  }

  void setLanguage(String lang) {
    if (lang == 'en' || lang == 'am') {
      currentLocale.value = lang;
    }
  }

  void setLocale(String lang) => setLanguage(lang);

  static const Map<String, Map<String, String>> _localizedValues = {
    'en': {
      // App Branding & Navigation
      'app_title': 'Alehulsh',
      'app_subtitle': 'Live Emergency Protection & Women Safety Radar',
      'nav_emergency': 'Emergency',
      'nav_home': 'Home',
      'nav_network': 'Alerts',
      'nav_profile': 'Profile',
      
      // Language Toggle
      'lang_btn': 'አማርኛ',
      
      // Home Screen
      'home_welcome': 'Welcome to Alehulsh',
      'home_standby': 'Your 24/7 Guardian & Women Safety Shield',
      'home_quick_sos': 'Quick Emergency Dispatch',
      'home_quick_sos_sub': 'Tap below or hold to broadcast emergency radar',
      'home_emergency_btn': 'Emergency Alert',
      'home_network_btn': 'Alerts Hub',
      'home_profile_btn': 'Safety Profile',
      
      // Emergency Screen
      'sos_title': 'Emergency SOS Dispatch',
      'sos_shield_standby': 'EMERGENCY SHIELD STANDBY',
      'sos_broadcast_active': 'SOS BROADCAST ACTIVE',
      'sos_ready_desc': 'Live GPS ready for emergency broadcast.',
      'sos_tap_btn': 'TAP SOS',
      'sos_sent_btn': 'SOS HAS BEEN\nSENT',
      'sos_cancel_btn': 'Cancel SOS',
      'sos_urgent_label': 'Mark as Urgent Distress',
      'sos_urgent_sub': 'Highlights your card as urgent across the network',
      'sos_message_label': 'Emergency Message Note:',
      'sos_message_hint': 'Type emergency details (e.g. Need assistance near bus stop)...',
      'sos_message_send_btn': 'Send Emergency Note',
      'sos_message_sent': 'Message Sent! ✓',
      'sos_message_sent_sub': 'Your emergency note has been attached to your active SOS alert.',
      'sos_voice_title': 'Voice Note Dispatcher',
      'sos_voice_sub_idle': 'Tap microphone to record emergency voice note for responders.',
      'sos_voice_sub_rec': 'Recording in progress... Tap Send button on the right to attach.',
      'sos_voice_record_btn': 'Record Voice Note',
      'sos_voice_send_btn': 'Send',
      'sos_security_dialog_title': 'Security SOS Cancel',
      'sos_security_dialog_desc': 'To cancel emergency broadcast, answer your security verification question:',
      'sos_cat_question': "What is your pet's name?",
      'sos_cat_desc': "Secret security answer required to safely cancel an active emergency SOS alert.",
      'sos_confirm_cancel': 'Confirm & Cancel SOS',
      'sos_keep_active': 'Keep SOS Active',
      
      // Alerts Screen
      'w4w_title': 'Alerts',
      'cat_all': 'All',
      'cat_contacts': 'Emergency Contacts',
      'w4w_no_alerts': 'No active alerts detected',
      'w4w_no_contact_alerts': 'No active alerts from your emergency contacts',
      'w4w_listen_voice': 'Listen Voice Notes',
      'w4w_no_voice': 'No voice notes',
      'w4w_view_location': 'View Location',
      'w4w_accept_respond': 'Accept Alert & Respond',
      'w4w_you_responding': 'You are Responding',
      'w4w_tag_you': 'YOU',
      'w4w_tag_urgent': 'URGENT',
      'w4w_tag_safe': 'SAFE',
      
      // Profile Screen
      'profile_title': 'Profile',
      'profile_cat_title': "Your Pet's Name",
      'profile_cat_desc': "Secret security answer required to safely cancel an active emergency SOS alert.",
      'profile_contacts_title': 'Emergency Contacts',
      'profile_contacts_desc': 'Contacts notified immediately when you trigger SOS.',
      'profile_add_contact': '+ Add Emergency Contact',
      'profile_edit_btn': 'Edit Details',
      'profile_logout_btn': 'Log Out',
      
      // Auth Screen
      'auth_login': 'Log In',
      'auth_signup': 'Sign Up',
      'auth_fullname': 'Full Name',
      'auth_email': 'Email Address',
      'auth_password': 'Password',
      'auth_phone': 'Phone Number',
      'auth_create_btn': 'Create Account & Enable Radar',
      'auth_signin_btn': 'Sign In to Protection Shield',
    },
    'am': {
      // App Branding & Navigation
      'app_title': 'አለሁልሽ',
      'app_subtitle': 'የቀጥታ የአደጋ ጊዜ ጥበቃ እና የሴቶች ደህንነት ራዳር',
      'nav_emergency': 'አደጋ SOS',
      'nav_home': 'መነሻ',
      'nav_network': 'ማንቂያዎች',
      'nav_profile': 'መገለጫ',
      
      // Language Toggle
      'lang_btn': 'English',
      
      // Home Screen
      'home_welcome': 'እንኳን ወደ አለሁልሽ በደህና መጡ',
      'home_standby': 'የ 24/7 የሴቶች ደህንነት ጠባቂና ጋሻ',
      'home_quick_sos': 'ፈጣን የአደጋ ጊዜ ጥሪ',
      'home_quick_sos_sub': 'የአደጋ ጊዜ ራዳር ለማስተላለፍ ከታች ይጫኑ',
      'home_emergency_btn': 'የአደጋ ጊዜ ጥሪ',
      'home_network_btn': 'የማንቂያዎች ማዕከል',
      'home_profile_btn': 'የደህንነት መገለጫ',
      
      // Emergency Screen
      'sos_title': 'የአደጋ ጊዜ SOS ማስተላለፊያ',
      'sos_shield_standby': 'የአደጋ ጊዜ ጋሻ ዝግጁ ነው',
      'sos_broadcast_active': 'የአደጋ ጊዜ ጥሪ ተሰራጭቷል',
      'sos_ready_desc': 'የቀጥታ GPS ለአደጋ ጥሪ ዝግጁ ነው።',
      'sos_tap_btn': 'SOS ላኪ',
      'sos_sent_btn': 'SOS\nተልኳል',
      'sos_cancel_btn': 'SOS ሰርዝ',
      'sos_urgent_label': 'አስቸኳይ አደጋ ምልክት አድርግ',
      'sos_urgent_sub': 'በማንቂያዎች ገጽ ላይ አስቸኳይ ምልክት ይሰጣል',
      'sos_message_label': 'የአደጋ ጊዜ ማስታወሻ መልእክት:',
      'sos_message_hint': 'የአደጋውን ዝርዝር ይጻፉ (ለምሳሌ፡ አውቶቡስ ማቆሚያ አጠገብ እገዛ እፈልጋለሁ)...',
      'sos_message_send_btn': 'ማስታወሻ ላክ',
      'sos_message_sent': 'መልእክት ተልኳል! ✓',
      'sos_message_sent_sub': 'የአደጋ ጊዜ ማስታወሻዎ ከአደጋ ጥሪዎ ጋር ተያይዟል።',
      'sos_voice_title': 'የድምፅ መልእክት መላኪያ',
      'sos_voice_sub_idle': 'ለአዳኞች የድምፅ መልእክት ለመቅረጽ ማይክሮፎኑን ይጫኑ።',
      'sos_voice_sub_rec': 'ድምፅ በመቅረጽ ላይ... ለማያያዝ በቀኝ በኩል ያለውን ላክ ይጫኑ።',
      'sos_voice_record_btn': 'የድምፅ መልእክት ቅረጽ',
      'sos_voice_send_btn': 'ላክ',
      'sos_security_dialog_title': 'የደህንነት SOS መሰረዣ',
      'sos_security_dialog_desc': 'የአደጋ ጥሪውን ለመሰረዝ የደህንነት ማረጋገጫ ጥያቄዎን ይመልሱ:',
      'sos_cat_question': "የቤት እንስሳዎ ስም ማን ነው?",
      'sos_cat_desc': "የአደጋ ጊዜ ጥሪን (SOS) ለማቆም የሚያገለግል ሚስጥራዊ የደህንነት ማረጋገጫ ቃል",
      'sos_confirm_cancel': 'አረጋግጥና SOS ሰርዝ',
      'sos_keep_active': 'SOS እንደበራ ይቆይ',
      
      // Alerts Screen
      'w4w_title': 'ማንቂያዎች',
      'cat_all': 'ሁሉም',
      'cat_contacts': 'የአደጋ ጊዜ እውቂያዎች',
      'w4w_no_alerts': 'ምንም ንቁ የአደጋ ጥሪ የለም',
      'w4w_no_contact_alerts': 'ከእውቂያዎችዎ ምንም ንቁ የአደጋ ጥሪ የለም',
      'w4w_listen_voice': 'የድምፅ መልእክት አዳምጥ',
      'w4w_no_voice': 'ምንም ድምፅ የለም',
      'w4w_view_location': 'ቦታውን በካርታ እይ',
      'w4w_accept_respond': 'አደጋውን ተቀበልና እርዳ',
      'w4w_you_responding': 'እየረዱ ነው',
      'w4w_tag_you': 'እርስዎ',
      'w4w_tag_urgent': 'አስቸኳይ',
      'w4w_tag_safe': 'ደህና',
      
      // Profile Screen
      'profile_title': 'መገለጫ',
      'profile_cat_title': 'የቤት እንስሳዎ ስም',
      'profile_cat_desc': 'የአደጋ ጊዜ ጥሪን (SOS) ለማቆም የሚያገለግል ሚስጥራዊ የደህንነት ማረጋገጫ ቃል።',
      'profile_contacts_title': 'የአደጋ ጊዜ እውቂያዎች',
      'profile_contacts_desc': 'SOS ሲልኩ ወዲያውኑ መልእክት የሚደርሳቸው እውቂያዎች።',
      'profile_add_contact': '+ የአደጋ ጊዜ እውቂያ ጨምር',
      'profile_edit_btn': 'መረጃ አሻሽል',
      'profile_logout_btn': 'ውጣ',
      
      // Auth Screen
      'auth_login': 'ግባ',
      'auth_signup': 'ተመዝገብ',
      'auth_fullname': 'ሙሉ ስም',
      'auth_email': 'ኢሜይል አድራሻ',
      'auth_password': 'የይለፍ ቃል',
      'auth_phone': 'ስልክ ቁጥር',
      'auth_create_btn': 'አካውንት ክፈትና ራዳሩን አንቃ',
      'auth_signin_btn': 'ወደ ጥበቃ ጋሻው ግባ',
    }
  };

  String tr(String key) {
    final lang = currentLocale.value;
    return _localizedValues[lang]?[key] ?? _localizedValues['en']?[key] ?? key;
  }
}

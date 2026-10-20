import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/models/user_profile_model.dart';
import 'package:alehulsh_app/services/profile_initialization.dart';

/// Regression cover for the fabricated home address.
///
/// Signup passed the literal "Live GPS Tracked" into homeAddress, so every new
/// user's stored home address was really a GPS status string. The field means
/// "the address she gave us"; nothing may invent one, least of all from where
/// she happens to be standing.

const authUid = 'MH63ohiSu6RvQ92asHlQjUqWqjmd';
final fixedNow = DateTime(2026, 10, 16, 12);
const placeholder = 'Live GPS Tracked';

UserProfile newSignupProfile({String homeAddress = ''}) => UserProfile(
      uid: authUid,
      fullName: 'Test User',
      email: 'tester@alehulsh.test',
      phoneNumber: '0911234567',
      homeAddress: homeAddress,
      emergencyContacts: const [],
      activities: const [],
      createdAt: fixedNow,
      lastActiveAt: fixedNow,
    );

void main() {
  group('1. a new signup never receives a fabricated address', () {
    test('the model default is unset, not a placeholder', () {
      // auth_screen now passes '' explicitly; this guards the default too.
      final p = UserProfile(
        uid: authUid, fullName: 'T', email: 'e', phoneNumber: 'p',
        emergencyContacts: const [], activities: const [],
        createdAt: fixedNow, lastActiveAt: fixedNow,
      );
      expect(p.homeAddress, isEmpty);
      expect(p.homeAddress, isNot(placeholder));
    });

    test('a profile initialised from auth has no address', () {
      // The authenticated-but-no-document branch must not invent one either.
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null,
        currentProfile: UserProfile.guestProfile(),
        authEmail: 'tester@alehulsh.test', now: fixedNow,
      );
      expect(r.profile.homeAddress, isEmpty);
    });

    test('the guest profile has no address', () {
      expect(UserProfile.guestProfile().homeAddress, isEmpty);
    });

    test('no constructed profile yields the placeholder', () {
      for (final p in [
        newSignupProfile(),
        UserProfile.guestProfile(),
        UserProfile.fromMap(const {'uid': authUid}),
      ]) {
        expect(p.homeAddress, isNot(placeholder));
      }
    });
  });

  group('2. an unset address stays unset through serialization', () {
    test('round trip preserves empty', () {
      final restored = UserProfile.fromMap(newSignupProfile().toMap());
      expect(restored.homeAddress, isEmpty);
    });

    test('an absent field reads as empty, not as a placeholder', () {
      // Legacy documents written before homeAddress existed.
      final p = UserProfile.fromMap(const {'uid': authUid, 'fullName': 'T'});
      expect(p.homeAddress, isEmpty);
      expect(p.homeAddress, isNot(placeholder));
    });

    test('an explicit null reads as empty', () {
      final p = UserProfile.fromMap(const {'uid': authUid, 'homeAddress': null});
      expect(p.homeAddress, isEmpty);
    });
  });

  group('3. an address she supplied survives sign-in', () {
    test('profile initialisation loads it unchanged', () {
      final stored = newSignupProfile(homeAddress: 'Kazanchis, Addis Ababa').toMap();
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: stored,
        currentProfile: UserProfile.guestProfile(), now: fixedNow,
      );
      expect(r.profile.homeAddress, 'Kazanchis, Addis Ababa');
    });

    test('a damaged-uid document is repaired without touching the address', () {
      final stored = newSignupProfile(homeAddress: 'Kazanchis').toMap()
        ..['uid'] = '';
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: stored,
        currentProfile: UserProfile.guestProfile(), now: fixedNow,
      );
      expect(r.profile.uid, authUid);
      expect(r.profile.homeAddress, 'Kazanchis');
    });

    test('a legacy placeholder already stored is NOT silently rewritten', () {
      // Existing users carry "Live GPS Tracked" in Firestore. Reading is not
      // the place to migrate them - that would rewrite documents on sign-in.
      // The value is preserved; see the report for the cleanup decision.
      final stored = newSignupProfile(homeAddress: placeholder).toMap();
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: stored,
        currentProfile: UserProfile.guestProfile(), now: fixedNow,
      );
      expect(r.profile.homeAddress, placeholder);
      expect(r.needsWrite, isFalse, reason: 'sign-in must not rewrite her document');
    });
  });

  group('4. editing the address still works', () {
    test('copyWith updates it', () {
      // The mechanism UserDataService.updatePersonalInfo uses.
      final edited = newSignupProfile().copyWith(homeAddress: 'Bole Atlas');
      expect(edited.homeAddress, 'Bole Atlas');
    });

    test('an edit survives a serialization round trip', () {
      final edited = newSignupProfile().copyWith(homeAddress: 'Bole Atlas');
      expect(UserProfile.fromMap(edited.toMap()).homeAddress, 'Bole Atlas');
    });

    test('clearing it back to unset is possible', () {
      final cleared = newSignupProfile(homeAddress: 'Bole').copyWith(homeAddress: '');
      expect(cleared.homeAddress, isEmpty);
    });

    test('an unrelated edit leaves the address alone', () {
      final p = newSignupProfile(homeAddress: 'Bole').copyWith(fullName: 'New Name');
      expect(p.homeAddress, 'Bole');
      expect(p.fullName, 'New Name');
    });
  });

  group('5. profile initialisation never overwrites the address', () {
    test('repeated sign-ins leave it untouched', () {
      var profile = newSignupProfile(homeAddress: 'Kazanchis');
      for (var i = 0; i < 5; i++) {
        final r = resolveProfileOnAuth(
          authUid: authUid, existingDoc: profile.toMap(),
          currentProfile: profile, now: fixedNow,
        );
        profile = r.profile;
        expect(r.needsWrite, isFalse);
      }
      expect(profile.homeAddress, 'Kazanchis');
    });

    test('a guest profile in memory cannot blank a stored address', () {
      // The old bug wrote the in-memory guest over her document.
      final stored = newSignupProfile(homeAddress: 'Kazanchis').toMap();
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: stored,
        currentProfile: UserProfile.guestProfile(), now: fixedNow,
      );
      expect(r.profile.homeAddress, 'Kazanchis');
    });
  });

  group('home address is never derived from location', () {
    test('a profile carries no coordinate-derived address', () {
      // Guards the rule rather than an implementation: nothing may populate
      // homeAddress from a fix, a label or a geohash.
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null,
        currentProfile: UserProfile.guestProfile(), now: fixedNow,
      );
      final a = r.profile.homeAddress.toLowerCase();
      for (final forbidden in ['gps', 'live', 'lat', 'lng', 'geohash', '9.0125', '38.7636']) {
        expect(a.contains(forbidden), isFalse, reason: 'address leaked "$forbidden"');
      }
    });
  });
}

import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/models/user_profile_model.dart';
import 'package:alehulsh_app/services/profile_initialization.dart';

/// Regression cover for the login-gate bug found in emulator E2E testing:
/// a signed-in user whose Firestore document did not exist yet was written a
/// GUEST profile (uid: '') and then refused the SOS with "Login Required".

const authUid = 'MH63ohiSu6RvQ92asHlQjUqWqjmd';
final fixedNow = DateTime(2026, 10, 16, 12);

/// A stored document as the app writes it, including the pre-existing data
/// that must survive a sign-in.
Map<String, dynamic> storedDoc({String uid = authUid, String catName = 'tigist'}) => {
      'uid': uid,
      'fullName': 'Test User',
      'email': 'tester@alehulsh.test',
      'phoneNumber': '0911234567',
      'homeAddress': 'Test Address',
      'catName': catName,
      'emergencyContacts': [
        {
          'id': 'contact_1735000000000_0',
          'name': 'Sister Test',
          'email': 'sister@alehulsh.test',
          'phone': '0922334455',
          'relationship': 'Sister',
          'isPrimary': true,
        }
      ],
      'safetyScore': 77,
      'bloodType': 'A+',
      'medicalNotes': 'Asthma',
    };

/// The in-memory profile at first launch, before anything has loaded.
UserProfile guestInMemory() => UserProfile.guestProfile();

/// Mirrors UserDataService.isLoggedIn.
bool isLoggedIn({required bool hasAuthUser, required UserProfile profile}) =>
    hasAuthUser && profile.uid.isNotEmpty;

void main() {
  test('cold trusted identity may queue offline without fabricated profile data or collection consent',(){
    final p=trustedOfflineProfile('synthetic-owner');
    expect(p.uid,'synthetic-owner');expect(p.fullName,isEmpty);expect(p.emergencyContacts,isEmpty);expect(p.catName,isEmpty);
    expect(p.hasSafetyKeyword,isFalse);expect(p.isAutoAudioRecording,isFalse);expect(p.isLocationSharingEnabled,isFalse);expect(p.safetyScore,0);
  });
  test('restart cannot reactivate cached location consent after a failed network opt-out',(){
    final prior=trustedOfflineProfile('synthetic-owner').copyWith(isLocationSharingEnabled:true);
    final restored=honorPendingLocationOptOut(prior,pending:true);
    expect(restored.uid,prior.uid);expect(restored.isLocationSharingEnabled,isFalse);
    expect(honorPendingLocationOptOut(prior,pending:false).isLocationSharingEnabled,isTrue);
  });
  test('trusted cache hydration scrubs legacy plaintext keyword/health data before it can be used or rewritten',(){
    final legacy=trustedOfflineProfile('synthetic-owner').copyWith(catName:'synthetic-old-secret',bloodType:'synthetic-retired',medicalNotes:'synthetic-retired-note');
    final raw=legacy.toMap()..['bloodType']='synthetic-retired'..['medicalNotes']='synthetic-retired-note';
    final cached=trustedCachedProfile(jsonEncode(raw),pendingLocationOptOut:false);
    expect(cached.catName,isEmpty);expect(cached.bloodType,isEmpty);expect(cached.medicalNotes,isEmpty);expect(cached.hasSafetyKeyword,isFalse);
    expect(cached.toJson(),isNot(contains('synthetic-old-secret')));
  });
  group('1. authenticated user whose Firestore profile is missing', () {
    test('initialises the profile with the Firebase Auth uid', () {
      final r = resolveProfileOnAuth(
        authUid: authUid,
        existingDoc: null,
        currentProfile: guestInMemory(),
        authEmail: 'tester@alehulsh.test',
        now: fixedNow,
      );

      // The exact defect: this used to be '' because the guest profile was
      // written through unchanged.
      expect(r.profile.uid, authUid);
      expect(r.needsWrite, isTrue, reason: 'the new profile must be persisted');
    });

    test('never adopts the in-memory guest profile', () {
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null,
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.profile.uid, isNot(''));
      expect(r.profile.uid, authUid);
    });

    test('identity comes only from the uid, not from a display name', () {
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null, currentProfile: guestInMemory(),
        authDisplayName: 'Someone Else', authEmail: 'a@b.test', now: fixedNow,
      );
      expect(r.profile.uid, authUid);
      // A name may seed a label, but must never become the identity.
      expect(r.profile.uid, isNot('Someone Else'));
    });

    test('invents nothing she did not supply', () {
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null,
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.profile.phoneNumber, isEmpty);
      expect(r.profile.emergencyContacts, isEmpty);
      // A shared default keyword is a keyword every attacker knows.
      expect(r.profile.catName, isEmpty);
    });
  });

  group('2. login state after successful initialisation', () {
    test('a signed-in user with an initialised profile is NOT asked to log in', () {
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null,
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(isLoggedIn(hasAuthUser: true, profile: r.profile), isTrue,
          reason: 'this returning false is what blocked the SOS button');
      expect(r.isReady, isTrue);
    });

    test('the old behaviour would have failed this test', () {
      // Written out so the regression is unmistakable: the guest profile
      // reaching the document is exactly what produced "Login Required".
      expect(isLoggedIn(hasAuthUser: true, profile: guestInMemory()), isFalse);
    });
  });

  group('3. an existing profile is preserved', () {
    test('supported profile fields survive; retired medical fields are not loaded', () {
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: storedDoc(),
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.profile.catName, 'tigist');
      expect(r.profile.emergencyContacts.length, 1);
      expect(r.profile.emergencyContacts.first.phone, '0922334455');
      expect(r.profile.fullName, 'Test User');
      expect(r.profile.homeAddress, 'Test Address');
      expect(r.profile.safetyScore, 77);
      expect(r.profile.bloodType, '');
      expect(r.profile.medicalNotes, '');
    });

    test('an intact profile triggers no write at all', () {
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: storedDoc(),
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.needsWrite, isFalse, reason: 'signing in must not rewrite her data');
      expect(r.isReady, isTrue);
    });

    test('a document already damaged by the old bug is repaired, not reset', () {
      // Accounts written by the previous code carry uid: ''. Because fromMap
      // reads map['uid'] ?? '', they would stay locked out forever.
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: storedDoc(uid: ''),
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.profile.uid, authUid, reason: 'uid repaired from the token');
      expect(r.needsWrite, isTrue, reason: 'the repair must be persisted');
      // The repair must not cost her anything.
      expect(r.profile.catName, 'tigist');
      expect(r.profile.emergencyContacts.length, 1);
      expect(r.profile.safetyScore, 77);
      expect(isLoggedIn(hasAuthUser: true, profile: r.profile), isTrue);
    });
  });

  group('4. genuine guest behaviour is unchanged', () {
    test('no authenticated user yields a guest profile and no write', () {
      final r = resolveProfileOnAuth(
        authUid: null, existingDoc: null,
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.profile.uid, isEmpty);
      expect(r.needsWrite, isFalse, reason: 'a guest must not be persisted');
      expect(r.isReady, isFalse);
      expect(isLoggedIn(hasAuthUser: false, profile: r.profile), isFalse);
    });

    test('an empty uid string is treated as a guest, not as an account', () {
      final r = resolveProfileOnAuth(
        authUid: '', existingDoc: null,
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.isReady, isFalse);
      expect(r.needsWrite, isFalse);
    });
  });

  group('5. an authenticated user is never downgraded to a guest', () {
    test('a missing document never produces an empty-uid profile', () {
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null,
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.profile.uid, isNotEmpty);
    });

    test('no resolution for an authenticated user is ever a guest', () {
      for (final doc in <Map<String, dynamic>?>[
        null, storedDoc(), storedDoc(uid: ''), <String, dynamic>{},
      ]) {
        final r = resolveProfileOnAuth(
          authUid: authUid, existingDoc: doc,
          currentProfile: guestInMemory(), now: fixedNow,
        );
        expect(r.profile.uid, authUid, reason: 'doc=$doc must still resolve to the auth uid');
        expect(isLoggedIn(hasAuthUser: true, profile: r.profile), isTrue);
      }
    });

    test('a write is always demanded before an initialised profile is trusted', () {
      // The caller must not publish the profile until this write lands;
      // UserDataService persists first and only then assigns profileNotifier.
      final r = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null,
        currentProfile: guestInMemory(), now: fixedNow,
      );
      expect(r.needsWrite, isTrue);
    });
  });

  group('6. repeated initialisation is idempotent', () {
    test('resolving twice converges and the second pass writes nothing', () {
      final first = resolveProfileOnAuth(
        authUid: authUid, existingDoc: null,
        currentProfile: guestInMemory(), authEmail: 'tester@alehulsh.test',
        now: fixedNow,
      );
      // Second auth event, now reading back what the first one persisted.
      final second = resolveProfileOnAuth(
        authUid: authUid, existingDoc: first.profile.toMap(),
        currentProfile: first.profile, now: fixedNow,
      );
      expect(second.profile.uid, authUid);
      expect(second.needsWrite, isFalse, reason: 'nothing left to persist');
      expect(second.isReady, isTrue);
    });

    test('repeated sign-ins never erase or duplicate saved data', () {
      var profile = UserProfile.fromMap(storedDoc());
      for (var i = 0; i < 5; i++) {
        final r = resolveProfileOnAuth(
          authUid: authUid, existingDoc: profile.toMap(),
          currentProfile: profile, now: fixedNow,
        );
        profile = r.profile;
        expect(r.needsWrite, isFalse);
      }
      expect(profile.catName, 'tigist');
      expect(profile.emergencyContacts.length, 1, reason: 'contacts must not duplicate');
      expect(profile.safetyScore, 77);
      expect(profile.uid, authUid);
    });
  });
}

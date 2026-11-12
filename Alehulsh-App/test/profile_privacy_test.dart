import 'package:flutter_test/flutter_test.dart';
import 'package:alehulsh_app/models/user_profile_model.dart';
import 'package:alehulsh_app/services/profile_initialization.dart';

void main() {
  test('retired medical values are neither fabricated, read nor written', () {
    final data = UserProfile.fromMap({'bloodType': 'A+', 'medicalNotes': 'sensitive-history'});
    expect(data.bloodType, ''); expect(data.medicalNotes, '');
    expect(data.toMap().containsKey('bloodType'), isFalse);
    expect(data.toMap().containsKey('medicalNotes'), isFalse);
    expect(UserProfile.fromMap({}).bloodType, '');
  });

  test('collection requires explicit consent rather than a legacy default', () {
    expect(UserProfile.fromMap({'uid': 'alice', 'isLocationSharingEnabled': true}).isLocationSharingEnabled, isFalse);
    final explicit = UserProfile.fromMap({'uid': 'alice', 'isLocationSharingEnabled': true, 'locationSharingConsentVersion': 1});
    expect(explicit.isLocationSharingEnabled, isTrue);
    expect(UserProfile.fromJson(explicit.toJson()).isLocationSharingEnabled, isTrue);
    expect(UserProfile.fromMap({'uid': 'alice'}).isLocationSharingEnabled, isFalse);
  });
  test('cache never persists the legacy plaintext keyword or health fields', () {
    final profile = UserProfile.fromMap({'uid': 'alice', 'catName': 'synthetic-private-word', 'bloodType': 'A+', 'medicalNotes': 'synthetic private note'});
    final raw = profile.toJson();
    expect(raw, isNot(contains('synthetic-private-word')));
    expect(raw, isNot(contains('catName')));
    expect(raw, isNot(contains('bloodType')));
    expect(raw, isNot(contains('medicalNotes')));
    expect(UserProfile.fromJson(raw).uid, 'alice');
    // Legacy server hydration remains transient until trusted-operation adoption.
    expect(profile.catName, 'synthetic-private-word');
  });
  test('a document fetched for A cannot be relabeled as B', () {
    expect(() => resolveProfileOnAuth(authUid: 'bob', documentUid: 'alice',
      existingDoc: {'uid': 'alice', 'catName': 'private'}, currentProfile: UserProfile.guestProfile()), throwsStateError);
  });
}

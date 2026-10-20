/// Decides what an authenticated user's profile should be, before any of it
/// touches Firestore.
///
/// Standalone and free of Firebase so the one decision that determines whether
/// a signed-in woman is allowed to raise an SOS is directly unit testable.
/// See test/profile_initialization_test.dart.
///
/// The bug this exists to prevent: when Firebase Auth had a valid user but her
/// Firestore document did not exist yet, the old path wrote the in-memory
/// GUEST profile - carrying `uid: ''` - to her document. Login state is
/// `currentUser != null && currentProfile.uid.isNotEmpty`, so she was then
/// treated as a guest and the SOS button refused her with "Login Required".
/// It was self-perpetuating: UserProfile.fromMap reads `map['uid'] ?? ''`, so
/// the empty uid survived every later reload.
library;

import '../models/user_profile_model.dart';

/// What should happen to the profile after an auth event.
class ProfileResolution {
  /// The profile that should be held in memory.
  final UserProfile profile;

  /// Whether [profile] still has to be persisted before it can be trusted.
  final bool needsWrite;

  /// Whether the app may treat this user as fully signed in.
  ///
  /// False for genuine guests. When [needsWrite] is true the caller must only
  /// honour this AFTER the write succeeds - an initialisation that failed must
  /// not present itself as a ready account.
  final bool isReady;

  /// Why this resolution was chosen. Logged; never contains profile data.
  final String reason;

  const ProfileResolution({
    required this.profile,
    required this.needsWrite,
    required this.isReady,
    required this.reason,
  });
}

/// Resolve the profile for the current auth state.
///
/// [authUid] is the ONLY identity source. Display names, contact ids, phone
/// numbers and locally generated guest ids are never used to establish who
/// someone is.
///
/// [existingDoc] is the raw Firestore document, or null when she has none yet.
ProfileResolution resolveProfileOnAuth({
  required String? authUid,
  required Map<String, dynamic>? existingDoc,
  required UserProfile currentProfile,
  String? authEmail,
  String? authDisplayName,
  /// Injected so the result is deterministic in tests.
  DateTime? now,
}) {
  final createdAt = now ?? DateTime.now();
  // ---- Genuine guest -----------------------------------------------------
  // No authenticated user at all. Unchanged behaviour: guest profile, nothing
  // written, not signed in.
  if (authUid == null || authUid.isEmpty) {
    return ProfileResolution(
      profile: UserProfile.guestProfile(),
      needsWrite: false,
      isReady: false,
      reason: 'no authenticated user - guest mode',
    );
  }

  // ---- She already has a profile ----------------------------------------
  if (existingDoc != null) {
    final stored = UserProfile.fromMap(existingDoc);

    // Repair a document whose uid field is empty or disagrees with the
    // authenticated user. Such documents exist in the wild because the old
    // code wrote them, and without this they would never recover: the empty
    // uid reloads as empty and she stays locked out forever.
    //
    // Only the uid is corrected. Every other stored field is passed through
    // untouched, so catName, emergency contacts and the rest survive.
    final needsUidRepair = stored.uid != authUid;
    return ProfileResolution(
      profile: needsUidRepair ? stored.copyWith(uid: authUid) : stored,
      needsWrite: needsUidRepair,
      isReady: true,
      reason: needsUidRepair
          ? 'existing profile loaded, uid field repaired'
          : 'existing profile loaded',
    );
  }

  // ---- Authenticated, but no profile document yet ------------------------
  // Initialise one against the REAL uid. Never the guest profile, and never
  // whatever happens to be in memory - that may be a leftover guest.
  //
  // Seeded only from values Firebase Auth itself vouches for. Anything she has
  // not supplied is left empty rather than invented.
  return ProfileResolution(
    profile: UserProfile(
      uid: authUid,
      fullName: (authDisplayName ?? '').trim(),
      email: (authEmail ?? '').trim(),
      phoneNumber: '',
      emergencyContacts: const [],
      activities: const [],
      createdAt: createdAt,
      lastActiveAt: createdAt,
    ),
    needsWrite: true,
    // Only once the write lands - the caller enforces this.
    isReady: true,
    reason: 'no profile document - initialised from auth uid',
  );
}

import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/user_profile_model.dart';
import 'user_data_service.dart';

class AuthService {
  static final AuthService _instance = AuthService._internal();
  factory AuthService() => _instance;
  AuthService._internal();

  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;

  User? get currentUser => _auth.currentUser;
  Stream<User?> get authStateChanges => _auth.authStateChanges();

  /// Sign Up with Email and Password & Create Profile Document in Firestore
  Future<UserCredential> signUp({
    required String email,
    required String password,
    required String fullName,
    required String phoneNumber,
    required String homeAddress,
    required String catName,
    required List<EmergencyContact> emergencyContacts,
  }) async {
    try {
      UserCredential userCredential = await _auth.createUserWithEmailAndPassword(
        email: email.trim(),
        password: password.trim(),
      );

      User? user = userCredential.user;
      if (user != null) {
        // Create User Profile
        UserProfile newProfile = UserProfile(
          uid: user.uid,
          fullName: fullName.trim(),
          email: email.trim(),
          phoneNumber: phoneNumber.trim(),
          homeAddress: homeAddress.trim(),
          catName: catName.trim().toLowerCase(), // Normalized for security check
          emergencyContacts: emergencyContacts,
          activities: [
            UserActivityLog(
              id: "act_init",
              title: "Account Created",
              description: "Registered on Alehulsh Safety Network.",
              timestamp: DateTime.now(),
              type: "profile_updated",
            ),
          ],
          createdAt: DateTime.now(),
          lastActiveAt: DateTime.now(),
        );

        // Write user profile document to Firestore `/users/{uid}`
        await _firestore.collection('users').doc(user.uid).set(newProfile.toMap());
        debugPrint("[AuthService] User profile created in Firestore: ${user.uid}");
      }
      return userCredential;
    } catch (e) {
      debugPrint("[AuthService] Signup error: $e");
      rethrow;
    }
  }

  /// Sign In with Email and Password
  Future<UserCredential> signIn({
    required String email,
    required String password,
  }) async {
    try {
      return await _auth.signInWithEmailAndPassword(
        email: email.trim(),
        password: password.trim(),
      );
    } catch (e) {
      debugPrint("[AuthService] Signin error: $e");
      rethrow;
    }
  }

  /// Sign Out with instantaneous state reset
  Future<void> signOut() async {
    try {
      await UserDataService().clearOnSignOut();
      await _auth.signOut();
    } catch (e) {
      debugPrint("[AuthService] Sign out error: $e");
      await UserDataService().clearOnSignOut();
    }
  }
}

import '../auth/supabase_identity_provider.dart';
import '../auth/identity_runtime.dart';
import '../api/account_api.dart';
import 'password_input.dart';
import '../api/api_runtime.dart';
import '../api/api_configuration.dart';
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/user_profile_model.dart';
import 'user_data_service.dart';

enum AuthFlowResult { ready, confirmationRequired, accountSetupRequired }

class AuthService {
  static final AuthService _instance = AuthService._internal();
  factory AuthService() => _instance;
  AuthService._internal();

  FirebaseAuth get _auth => FirebaseAuth.instance;
  FirebaseFirestore get _firestore => FirebaseFirestore.instance;

  AppIdentity? get currentUser => IdentityRuntime.current;
  Stream<AppIdentity?> get authStateChanges => IdentityRuntime.changes;

  /// Sign Up with Email and Password & Create Profile Document in Firestore
  Future<AuthFlowResult> signUp({
    required String email,
    required String password,
    required String fullName,
    required String phoneNumber,
    required String homeAddress,
    required String catName,
    required List<EmergencyContact> emergencyContacts,
  }) async {
    try {
      if(ApiRuntime.enabled) {
        if(ApiRuntime.identity!=ApiIdentity.supabase)throw const AuthFlowException('New API accounts require Supabase Auth.');
        final active=await ApiRuntime.supabase!.signUp(email,passwordInput(password));
        if(!active)return AuthFlowResult.confirmationRequired;
        await completeAccountSetup(fullName:fullName,homeAddress:homeAddress,keyword:catName,contacts:emergencyContacts);
        return AuthFlowResult.ready;
      }
      UserCredential userCredential = await _auth.createUserWithEmailAndPassword(
        email: email.trim(),
        password: passwordInput(password),
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
          catName: ApiRuntime.enabled ? '' : catName.trim().toLowerCase(),
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
        final data = newProfile.toMap();
        if (ApiRuntime.enabled) data.remove('catName');
        await _firestore.collection('users').doc(user.uid).set(data);
        if (ApiRuntime.enabled) await ApiRuntime.client.setKeyword(catName);
        debugPrint("[AuthService] User profile created in Firestore: ${user.uid}");
      }
      return AuthFlowResult.ready;
    } catch (e) {
      debugPrint('[AuthService] Registration could not be confirmed');
      throw const AuthFlowException();
    }
  }

  /// Sign In with Email and Password
  Future<AuthFlowResult> signIn({
    required String email,
    required String password,
    bool legacyPasswordSpacing = false,
  }) async {
    try {
      if(ApiRuntime.enabled && ApiRuntime.identity==ApiIdentity.supabase) {
        await ApiRuntime.supabase!.signIn(email,passwordInput(password,legacySignIn:legacyPasswordSpacing));
        if(!await ApiRuntime.account.provisioned())return AuthFlowResult.accountSetupRequired;
        final owner=ApiRuntime.client.knownSubject();
        if(owner!=null)await UserDataService().loadProfileFromFirestore(owner);
        return AuthFlowResult.ready;
      }
      await _auth.signInWithEmailAndPassword(
        email: email.trim(),
        password: passwordInput(password, legacySignIn: legacyPasswordSpacing),
      );
      return AuthFlowResult.ready;
    } catch (_) {
      debugPrint('[AuthService] Sign-in could not be confirmed');
      throw const AuthFlowException();
    }
  }

  /// Explicit enrollment only. No automatic linking by email, phone or name.
  Future<void> completeAccountSetup({required String fullName,required String homeAddress,
      required String keyword,required List<EmergencyContact> contacts}) async {
    final owner=ApiRuntime.client.knownSubject();final epoch=ApiRuntime.client.accountEpoch();
    if(owner==null)throw const AuthFlowException();
    await ApiRuntime.account.provision(name:fullName,homeAddress:homeAddress,keyword:keyword);
    for(final contact in contacts) {
      if(ApiRuntime.client.knownSubject()!=owner||ApiRuntime.client.accountEpoch()!=epoch)throw const AuthFlowException();
      await ApiRuntime.account.putContact(contact.copyWith(id:AccountApi.newContactId()));
    }
    await UserDataService().loadProfileFromFirestore(owner);
  }

  /// Local clearing and confirmed server revocation are separate outcomes.
  Future<bool> signOut() async {
    if(ApiRuntime.enabled && ApiRuntime.identity==ApiIdentity.supabase) {
      final logout=ApiRuntime.supabase!.signOut(revoke:ApiRuntime.client.endSession); // Invalidate identity synchronously.
      await UserDataService().clearOnSignOut();
      return await logout;
    }
    await UserDataService().clearOnSignOut();
    await _auth.signOut();
    return false;
  }
}

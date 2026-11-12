import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../api/api_runtime.dart';
import '../api/account_api.dart';
import '../api/private_notification_api.dart';
import '../auth/identity_runtime.dart';
import 'private_notification_settings.dart';
import '../auth/secure_session_store.dart';

/// Explicit, reviewed consent precedes registration. OS permission alone is
/// insufficient. This service never sends a notification or subscribes topics.
class PrivatePushService with WidgetsBindingObserver {
  static final instance = PrivatePushService._();
  PrivatePushService._();
  PrivateNotificationApi get api => PrivateNotificationApi(ApiRuntime.client);
  String? _owner;
  int? _epoch;
  int _consentGeneration = 0;
  Timer? _recoveryTimer;
  bool _observing = false;
  Future<void> _ownerWrites = Future.value();
  Future<void> _intentWrites = Future.value();
  Future<T> _writeIntent<T>(Future<T> Function() action) {
    final result = _intentWrites.catchError((_) {}).then((_) => action());
    _intentWrites =
        result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }

  Future<int> _revision(String owner, String id) =>
      NativePushRevision(ApiRuntime.client.baseUri.origin).next(owner, id);
  Future<void> Function(String, bool)? _hint;
  StreamSubscription<AppIdentity?>? _identity;
  StreamSubscription<String>? _tokens;
  bool _same(String owner, int epoch) =>
      ApiRuntime.client.knownSubject() == owner &&
      ApiRuntime.client.accountEpoch() == epoch;
  Future<void> initialize(Future<void> Function(String, bool) hint) async {
    _hint = hint;
    if (!_observing) {
      _observing = true;
      WidgetsBinding.instance.addObserver(this);
      _startRecovery();
    }
    _identity ??= IdentityRuntime.changes.listen((_) {
      _bind();
    });
    _tokens ??= FirebaseMessaging.instance.onTokenRefresh.listen((token) {
      _restore(token: token);
    });
    FirebaseMessaging.onMessageOpenedApp.listen((message) {
      handle(message, opened: true);
    });
    _bind();
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) await handle(initial, opened: true);
  }

  void _bind() {
    if (_owner == ApiRuntime.client.knownSubject() &&
        _epoch == ApiRuntime.client.accountEpoch()) {
      return;
    }
    _owner = ApiRuntime.client.knownSubject();
    _epoch = ApiRuntime.client.accountEpoch();
    final owner = _owner, epoch = _epoch;
    _ownerWrites = _ownerWrites.catchError((_) {}).then((_) async {
      final prefs = await SharedPreferences.getInstance();
      if (ApiRuntime.client.knownSubject() != owner ||
          ApiRuntime.client.accountEpoch() != epoch) {
        return;
      }
      if (owner == null) {
        await prefs.remove('private_push_owner');
      } else {
        await prefs.setString('private_push_owner', owner);
      }
    }).catchError((_) {});
    if (_owner != null) _restore();
  }

  Future<void> _restore({String? token}) async {
    final owner = _owner, epoch = _epoch;
    final consentGeneration = _consentGeneration;
    if (owner == null || epoch == null) return;
    try {
      if (await _recoverDisabled()) return;
      final prefs = await SharedPreferences.getInstance(),
          policy = await api.policy();
      if (!_same(owner, epoch) ||
          prefs.getString('push_consent:$owner') != policy.version) {
        return;
      }
      await enable(policy,
          token: token, expectedConsentGeneration: consentGeneration);
    } catch (_) {
      /* Registration remains unconfirmed; foreground inbox still works. */
    }
  }

  void _startRecovery() {
    _recoveryTimer?.cancel();
    _recoveryTimer = Timer.periodic(const Duration(seconds: 30), (_) async {
      try {
        final disabled = await _recoverDisabled(),
            owner = ApiRuntime.client.knownSubject();
        if (!disabled &&
            owner != null &&
            (await SharedPreferences.getInstance())
                    .getBool('push_registration_pending:$owner') ==
                true) {
          await _restore();
        }
      } catch (_) {/* Durable intent remains for foreground recovery. */}
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _startRecovery();
      _restore();
    } else {
      _recoveryTimer?.cancel();
    }
  }

  Future<bool> _recoverDisabled({bool reportFailure = false}) async {
    final owner = ApiRuntime.client.knownSubject(),
        epoch = ApiRuntime.client.accountEpoch();
    if (owner == null) return false;
    try {
      final prefs = await SharedPreferences.getInstance();
      final intent = await _writeIntent(() async {
        if (!_same(owner, epoch)) return null;
        final id = prefs.getString('push_device:$owner');
        var revision = prefs.getInt('push_disable_revision:$owner');
        if (id == null ||
            (revision == null &&
                prefs.getBool('push_disable_pending:$owner') != true)) {
          return null;
        }
        if (revision == null) {
          revision = await _revision(owner, id);
          if (!await prefs.setInt('push_disable_revision:$owner', revision)) {
            throw StateError('Opt-out could not be persisted');
          }
        }
        return (id: id, revision: revision);
      });
      if (intent == null) return false;
      final id = intent.id, revision = intent.revision;
      if (!_same(owner, epoch)) return true;
      await api.disable(
          id, prefs.getString('push_generation:$owner'), revision);
      await _writeIntent(() async {
        if (_same(owner, epoch) &&
            prefs.getInt('push_disable_revision:$owner') == revision) {
          await prefs.remove('push_disable_revision:$owner');
          await prefs.remove('push_disable_pending:$owner');
        }
      });
      return true;
    } catch (_) {
      if (reportFailure) rethrow;
      return true;
    }
  }

  Future<void> enable(NotificationConsent consent,
      {String? token, int? expectedConsentGeneration}) async {
    final consentGeneration = expectedConsentGeneration ?? ++_consentGeneration;
    if (consentGeneration != _consentGeneration ||
        !await privateNotificationsAllowed()) {
      throw StateError('Device notifications are disabled');
    }
    final owner = ApiRuntime.client.knownSubject(),
        epoch = ApiRuntime.client.accountEpoch();
    if (owner == null) throw StateError('Sign in required');
    final prefs = await SharedPreferences.getInstance();
    final id = await _writeIntent(() async {
      if (!_same(owner, epoch) || consentGeneration != _consentGeneration) {
        return null;
      }
      final id =
          prefs.getString('push_device:$owner') ?? AccountApi.newContactId();
      if (!await prefs.setString('push_device:$owner', id)) {
        throw StateError('Device registration could not be persisted');
      }
      return id;
    });
    if (id == null) return;
    token ??= await FirebaseMessaging.instance.getToken();
    if (!_same(owner, epoch) || token == null) {
      throw StateError('Notification registration unavailable');
    }
    if (consentGeneration != _consentGeneration ||
        !await privateNotificationsAllowed() ||
        !_same(owner, epoch)) {
      return;
    }
    final revision = await _writeIntent(() async {
      if (!_same(owner, epoch) || consentGeneration != _consentGeneration) {
        return null;
      }
      final revision = await _revision(owner, id);
      if (!_same(owner, epoch) || consentGeneration != _consentGeneration) {
        return null;
      }
      if (!await prefs.setString('push_consent:$owner', consent.version) ||
          !await prefs.setBool('push_registration_pending:$owner', true)) {
        throw StateError('Consent intent could not be persisted');
      }
      await prefs.remove('push_disable_revision:$owner');
      await prefs.remove('push_disable_pending:$owner');
      return revision;
    });
    if (revision == null) return;
    if (!_same(owner, epoch) || consentGeneration != _consentGeneration) return;
    final generation = await api.register(id, token, consent.version, revision);
    if (consentGeneration != _consentGeneration ||
        !await privateNotificationsAllowed()) {
      if (_same(owner, epoch)) await api.disable(id, generation, revision);
      return;
    }
    await _writeIntent(() async {
      if (!_same(owner, epoch) || consentGeneration != _consentGeneration) {
        return;
      }
      await prefs.setString('push_generation:$owner', generation);
      await prefs.remove('push_registration_pending:$owner');
    });
  }

  Future<void> disable() async {
    final consentGeneration = ++_consentGeneration;
    final owner = ApiRuntime.client.knownSubject(),
        epoch = ApiRuntime.client.accountEpoch();
    if (owner == null) return;
    final prefs = await SharedPreferences.getInstance();
    await _writeIntent(() async {
      if (!_same(owner, epoch) || consentGeneration != _consentGeneration) {
        return;
      }
      await persistPrivateOptOut(prefs, owner);
    });
    await _recoverDisabled(reportFailure: true);
  }

  Future<void> handle(RemoteMessage message, {bool opened = false}) async {
    final id = message.data['deliveryId'];
    if (id is! String || ApiRuntime.client.knownSubject() == null) return;
    try {
      await _hint?.call(id, opened);
    } catch (_) {/* No provider payload authorizes a user action. */}
  }
}

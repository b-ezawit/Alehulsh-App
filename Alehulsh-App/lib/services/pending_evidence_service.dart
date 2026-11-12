import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';
import 'package:http/http.dart' as http;
import '../api/api_runtime.dart';
import '../api/account_api.dart';
import '../api/evidence_api.dart';
import '../auth/identity_runtime.dart';
import '../auth/secure_session_store.dart';

/// Private app files survive process death. The manifest is encrypted by the
/// Android Keystore adapter and excluded from backup. No retention/erasure
/// policy is inferred; failed files are retained and never called uploaded.
class PendingEvidenceService with WidgetsBindingObserver {
  static final instance = PendingEvidenceService._();
  PendingEvidenceService._();
  Future<void> _writes = Future.value();
  Future<void>? _flush;
  Timer? _timer;
  bool _initialized = false;
  NativeSessionStore get _store =>
      NativeSessionStore(ApiRuntime.client.baseUri.origin, slot: 'evidence');
  Future<T> _locked<T>(Future<T> Function() work) {
    final result = _writes.catchError((_) {}).then((_) => work());
    _writes = result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }

  Future<List<Map<String, dynamic>>> _read() async {
    final raw = await _store.read();
    if (raw == null) return [];
    return (jsonDecode(raw) as List)
        .map((r) => Map<String, dynamic>.from(r as Map))
        .toList();
  }

  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;
    WidgetsBinding.instance.addObserver(this);
    IdentityRuntime.changes.listen((_) {
      flush();
    });
    _start();
    flush();
  }

  void _start() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      flush();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _start();
      flush();
    } else {
      _timer?.cancel();
    }
  }

  Future<bool> attach(
      {required String owner,
      required String alertId,
      required String incidentKey,
      required String sourcePath,
      required int durationMs}) async {
    final client = ApiRuntime.client, epoch = ApiRuntime.client.accountEpoch();
    if (client.knownSubject() != owner) return false;
    final source = File(sourcePath), length = await File(sourcePath).length();
    if (length < 1 || length > EvidenceApi.maxBytes) return false;
    final id = AccountApi.newContactId(),
        directory = await getApplicationSupportDirectory();
    final target = File('${directory.path}/pending-evidence/$id.m4a');
    await target.parent.create(recursive: true);
    await source.copy(
        target.path); // Persist before a temporary recording can be reclaimed.
    await _locked(() async {
      final rows = await _read();
      if (rows.length >= 100)
        throw StateError('Pending evidence capacity reached');
      rows.add({
        'owner': owner,
        'id': id,
        'alertId': alertId,
        'incidentKey': incidentKey,
        'path': target.path,
        'length': length,
        'durationMs': durationMs
      });
      await _store.write(jsonEncode(rows));
    });
    if (client.knownSubject() != owner || client.accountEpoch() != epoch)
      return false;
    await flush();
    return _locked(() async => !(await _read()).any((r) => r['id'] == id));
  }

  Future<void> flush() {
    if (_flush != null) return _flush!;
    final next = _run();
    _flush = next;
    next.whenComplete(() {
      if (identical(next, _flush)) _flush = null;
    });
    return next;
  }

  Future<void> _run() async {
    try {
      final client = ApiRuntime.client,
          owner = ApiRuntime.client.knownSubject(),
          epoch = ApiRuntime.client.accountEpoch();
      if (owner == null) return;
      const environment = String.fromEnvironment('FIREBASE_ENV');
      const dev = String.fromEnvironment('ALEHULSH_EVIDENCE_ORIGIN_DEV'),
          prod = String.fromEnvironment('ALEHULSH_EVIDENCE_ORIGIN_PROD');
      final raw = environment == 'dev' ? dev : prod;
      if (raw.isEmpty) return;
      final api = EvidenceApi(client,
          storageOrigin: Uri.parse(raw), uploadClient: () => http.Client());
      final rows = await _locked(_read);
      for (final row in rows.where((r) => r['owner'] == owner)) {
        try {
          if (client.knownSubject() != owner || client.accountEpoch() != epoch)
            return;
          final file = File(row['path'] as String);
          if (!await file.exists() || await file.length() != row['length'])
            continue;
          await api.save(
              owner: owner,
              alertId: row['alertId'],
              incidentKey: row['incidentKey'],
              evidenceId: row['id'],
              length: row['length'],
              bytes: () => file.openRead(),
              durationMs: row['durationMs']);
          if (client.knownSubject() != owner || client.accountEpoch() != epoch)
            return;
          await _locked(() async {
            final remaining = await _read();
            remaining.removeWhere(
                (r) => r['owner'] == owner && r['id'] == row['id']);
            await _store.write(jsonEncode(remaining));
          });
        } catch (_) {
          /* One failed or terminal incident must not block another. */
        }
      }
    } catch (_) {
      /* Pending evidence remains local and must never be reported stored. */
    }
  }
}

import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;
import 'package:flutter/services.dart';

/// Account-bound session supplied by the selected authentication provider.
class ApiSession {
  const ApiSession(this.subject, this.accessToken);
  final String subject;
  final String accessToken;
}

class PendingSos {
  PendingSos(this.ownerSubject, this.requestId, Map<String, dynamic> payload)
      : payload = Map.unmodifiable(payload);
  final String ownerSubject;
  final String requestId;
  final Map<String, dynamic> payload;
  Map<String, dynamic> toMap() => {
        'ownerSubject': ownerSubject,
        'requestId': requestId,
        'payload': payload,
      };
  factory PendingSos.fromMap(Map<String, dynamic> map) => PendingSos(
        map['ownerSubject'] as String,
        map['requestId'] as String,
        Map<String, dynamic>.from(map['payload'] as Map),
      );
}

abstract class SosOutbox {
  /// Must commit atomically before returning; preserves an existing pending SOS.
  Future<PendingSos> enqueue(PendingSos item);
  Future<List<PendingSos>> pending(String ownerSubject);
  Future<void> acknowledge(String ownerSubject, String requestId);
}

/// Android uses Keystore AES-GCM and AtomicFile in noBackupFilesDir. Unsupported
/// platforms fail closed until an equivalent secure adapter is supplied.
class NativeSosOutbox implements SosOutbox {
  const NativeSosOutbox();
  static const _channel =
      MethodChannel('com.example.alehulsh_app/migration_sos_outbox');
  @override
  Future<PendingSos> enqueue(PendingSos item) async =>
      PendingSos.fromMap(Map<String, dynamic>.from(
          await _channel.invokeMethod('enqueue', item.toMap()) as Map));
  @override
  Future<List<PendingSos>> pending(String ownerSubject) async =>
      (await _channel.invokeMethod<List<dynamic>>(
                  'pending', {'ownerSubject': ownerSubject}) ??
              (throw StateError('Secure SOS storage returned no response')))
          .map((value) =>
              PendingSos.fromMap(Map<String, dynamic>.from(value as Map)))
          .toList();
  @override
  Future<void> acknowledge(String ownerSubject, String requestId) =>
      _channel.invokeMethod<void>('acknowledge',
          {'ownerSubject': ownerSubject, 'requestId': requestId});
}

enum SosDelivery { queued, sent, authenticationRequired, reviewRequired }

class SosReceipt {
  const SosReceipt(this.id, this.status, {this.incidentKey});
  final String id;
  final String status;
  final String? incidentKey;
}

class SosAttempt {
  const SosAttempt(this.delivery, {this.receipt});
  final SosDelivery delivery;
  final SosReceipt? receipt;
}

/// Token refresh failed transiently; adapters map provider/network outages here.
class ApiSessionUnavailable implements Exception {}

class ApiOperationException implements Exception {
  const ApiOperationException(this.status);
  final int status;
  @override
  String toString() => 'The operation could not be confirmed ($status).';
}
class PendingSosNeedsAction extends ApiOperationException {
  const PendingSosNeedsAction({required bool authentication}):super(authentication?401:409);
}

class MigrationApiClient {
  MigrationApiClient(
      {required this.baseUri,
      required this.session,
      required this.knownSubject,
      required this.outbox,
      required this.httpClient,
      this.requireIncidentKey = false,
      int Function()? accountEpoch,
      this.timeout = const Duration(seconds: 10),
      bool allowLoopbackHttp = false}) : accountEpoch = accountEpoch ?? _zeroEpoch {
    final loopback = ['127.0.0.1', 'localhost', '::1'].contains(baseUri.host);
    if ((baseUri.scheme != 'https' &&
            !(allowLoopbackHttp && loopback && baseUri.scheme == 'http')) ||
        baseUri.userInfo.isNotEmpty ||
        baseUri.hasQuery ||
        baseUri.hasFragment ||
        baseUri.host.isEmpty ||
        !(baseUri.path.isEmpty || baseUri.path == '/')) {
      throw ArgumentError('An HTTPS API origin is required');
    }
  }
  static int _zeroEpoch() => 0;
  final int Function() accountEpoch;
  final Uri baseUri;

  /// Cached provider account identity; must not refresh tokens or use network.
  final String? Function() knownSubject;

  /// Fresh token acquisition happens only when attempting transmission.
  final Future<ApiSession?> Function() session;
  final SosOutbox outbox;
  final http.Client httpClient;
  final Duration timeout;
  final bool requireIncidentKey;
  Future<SosAttempt>? _inFlight;
  String? _inFlightOwner;
  int? _inFlightEpoch;

  /// The sole operation allowed after local identity invalidation. A captured
  /// credential can revoke only itself; it cannot fetch account data. The
  /// response never changes local identity or another account's state.
  Future<bool> endSession(String accessToken) async {
    if(accessToken.isEmpty)return false;
    final request=http.Request('POST',baseUri.resolve('/v1/me/logout'))
      ..followRedirects=false
      ..headers.addAll({'authorization':'Bearer $accessToken','content-type':'application/json'})
      ..body='{}';
    try {
      final response=await httpClient.send(request).timeout(timeout);
      await response.stream.listen((_){}).cancel();
      return response.statusCode==204;
    } catch(_){return false;}
  }

  /// Account-bound transport shared by keyword, inbox and acknowledgment flows.
  /// Secrets exist only in the request; redirects and stale-account results fail
  /// closed. An HTTP resolve acknowledgment is not proof a keyword was correct.
  Future<Map<String, dynamic>> authenticatedJson(String method, String path,
      {Map<String, dynamic>? body}) async {
    final owner = knownSubject();
    final epoch = accountEpoch();
    if (owner == null || owner.isEmpty) throw const ApiOperationException(401);
    final target = baseUri.resolve(path);
    if (!path.startsWith('/v1/') || target.origin != baseUri.origin ||
        target.hasFragment || target.userInfo.isNotEmpty) {
      throw ArgumentError('An application API path is required');
    }
    final clock = Stopwatch()..start();
    Duration remaining() {
      final value = timeout - clock.elapsed;
      if (value <= Duration.zero) throw TimeoutException('API deadline');
      return value;
    }
    void accountCheck() {
      if (knownSubject() != owner || accountEpoch() != epoch) throw const ApiOperationException(401);
    }
    final current = await session().timeout(remaining());
    accountCheck();
    if (current == null || current.subject != owner || current.accessToken.isEmpty) {
      throw const ApiOperationException(401);
    }
    final request = http.Request(method, target)
      ..followRedirects = false
      ..headers['authorization'] = 'Bearer ${current.accessToken}';
    if (body != null) {
      request.headers['content-type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final response = await httpClient.send(request).timeout(remaining());
    final iterator = StreamIterator(response.stream);
    final bytes = <int>[];
    try {
      accountCheck();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw ApiOperationException(response.statusCode);
      }
      while (await iterator.moveNext().timeout(remaining())) {
        accountCheck();
        bytes.addAll(iterator.current);
        if (bytes.length > 64 * 1024) throw const ApiOperationException(502);
      }
      accountCheck();
      if (response.statusCode == 204) return const {};
      final decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is! Map<String, dynamic>) throw const ApiOperationException(502);
      return decoded;
    } on FormatException {
      throw const ApiOperationException(502);
    } finally {
      await iterator.cancel();
    }
  }

  Future<void> setKeyword(String keyword, {String? currentKeyword}) async {
    await authenticatedJson('PUT', '/v1/me/keyword', body: {
      'keyword': keyword,
      if (currentKeyword != null) 'currentKeyword': currentKeyword,
    });
  }
  Future<Map<String,dynamic>> keywordRecovery()=>authenticatedJson('GET','/v1/me/keyword/reset');
  Future<Map<String,dynamic>> requestKeywordRecovery()=>authenticatedJson('POST','/v1/me/keyword/reset',body:{});
  Future<void> cancelKeywordRecovery()=>authenticatedJson('DELETE','/v1/me/keyword/reset',body:{}).then((_){});
  Future<void> confirmKeywordRecovery(String keyword)=>authenticatedJson('POST','/v1/me/keyword/reset/confirm',body:{'keyword':keyword}).then((_){});

  Future<void> requestResolution(String alertId, String keyword, {String? incidentKey}) async {
    await authenticatedJson('POST',
        '/v1/alerts/${Uri.encodeComponent(alertId)}/resolve',
        body: {'keyword': keyword, if (incidentKey != null) 'incidentKey': incidentKey});
  }

  Future<Map<String, dynamic>> ownAlert() =>
      authenticatedJson('GET', '/v1/me/alert');

  Future<Map<String, dynamic>> inbox({int limit = 25}) {
    if (limit < 1 || limit > 100) throw ArgumentError('Invalid page size');
    return authenticatedJson('GET', '/v1/me/inbox?limit=$limit');
  }

  Future<Map<String, dynamic>> accept(String alertId, {String? incidentKey}) => authenticatedJson(
      'POST', '/v1/alerts/${Uri.encodeComponent(alertId)}/accept', body: {if (incidentKey != null) 'incidentKey': incidentKey});

  /// Only coordinates, their provenance and an opaque ID enter persistence.
  Future<PendingSos> enqueueSos(
      {double? latitude,
      double? longitude,
      double? accuracyMeters,
      double? locationAgeMs,
      String? requestId,
      DateTime? occurredAt}) async {
    final owner = knownSubject();
    if (owner == null || owner.trim().isEmpty) {
      throw StateError('A known account is required before persisting an SOS');
    }
    if ((latitude == null) != (longitude == null) ||
        (latitude != null && (!latitude.isFinite || latitude.abs() > 90)) ||
        (longitude != null && (!longitude.isFinite || longitude.abs() > 180)) ||
        (accuracyMeters != null &&
            (!accuracyMeters.isFinite || accuracyMeters <= 0)) ||
        (locationAgeMs != null &&
            (!locationAgeMs.isFinite || locationAgeMs < 0))) {
      throw ArgumentError('Invalid location evidence');
    }
    final random = Random.secure();
    if(requestId!=null&&!RegExp(r'^[a-zA-Z0-9-]{8,128}$').hasMatch(requestId))throw ArgumentError('Opaque request identity required');
    final id = requestId??List.generate(
            16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'))
        .join();
    return outbox.enqueue(PendingSos(owner, id, {
      'requestId': id,
      'latitude': latitude,
      'longitude': longitude,
      'accuracyMeters': accuracyMeters,
      'locationAgeMs': locationAgeMs,
      'occurredAt': (occurredAt ?? DateTime.now()).toUtc().toIso8601String(),
    }));
  }

  /// Call on an explicitly wired reconnect/resume/background event after cutover.
  /// No timers or new backend are enabled by importing this module.
  Future<SosAttempt> flush() {
    final owner = knownSubject();
    final epoch = accountEpoch();
    if (_inFlight != null && _inFlightOwner == owner && _inFlightEpoch == epoch) return _inFlight!;
    final work = _flush(owner, epoch);
    _inFlightEpoch = epoch;
    _inFlightOwner = owner;
    _inFlight = work;
    return work.whenComplete(() {
      if (identical(_inFlight, work)) _inFlight = null;
    });
  }

  Future<SosAttempt> _flush(String? owner, int epoch) async {
    bool sameAccount() => owner != null && owner.isNotEmpty && knownSubject() == owner && accountEpoch() == epoch;
    if (!sameAccount()) return const SosAttempt(SosDelivery.authenticationRequired);
    ApiSession? current;
    try {
      current = await session().timeout(timeout);
    } on TimeoutException {
      return const SosAttempt(SosDelivery.queued);
    } on ApiSessionUnavailable {
      return const SosAttempt(SosDelivery.queued);
    }
    if (current == null || !sameAccount()) {
      return const SosAttempt(SosDelivery.authenticationRequired);
    }
    if (current.subject != owner || current.accessToken.isEmpty) return const SosAttempt(SosDelivery.queued);
    final pending = await outbox.pending(current.subject);
    if (!sameAccount()) return const SosAttempt(SosDelivery.authenticationRequired);
    if (pending.isEmpty) return const SosAttempt(SosDelivery.queued);
    final item = pending.first;
    if (item.ownerSubject != current.subject ||
        item.payload['requestId'] != item.requestId) {
      return const SosAttempt(SosDelivery.reviewRequired);
    }
    try {
      final request = http.Request('POST', baseUri.resolve('/v1/alerts'))
        ..followRedirects = false
        ..headers.addAll({
          'authorization': 'Bearer ${current.accessToken}',
          'content-type': 'application/json'
        })
        ..body = jsonEncode(item.payload);
      final clock = Stopwatch()..start();
      final response = await httpClient.send(request).timeout(timeout);
      if (!sameAccount()) {
        await response.stream.listen(null).cancel();
        return const SosAttempt(SosDelivery.authenticationRequired);
      }
      if (response.statusCode == 401) {
        await response.stream.listen(null).cancel();
        return const SosAttempt(SosDelivery.authenticationRequired);
      }
      if (response.statusCode == 429 || response.statusCode >= 500) {
        await response.stream.listen(null).cancel();
        return const SosAttempt(SosDelivery.queued);
      }
      if (![200, 201].contains(response.statusCode)) {
        await response.stream.listen(null).cancel();
        return const SosAttempt(SosDelivery.reviewRequired);
      }
      final bytes = <int>[];
      final stream = StreamIterator(response.stream);
      try {
        while (true) {
          final remaining = timeout - clock.elapsed;
          if (remaining <= Duration.zero) {
            throw TimeoutException('API response deadline');
          }
          if (!await stream.moveNext().timeout(remaining)) break;
          if (!sameAccount()) return const SosAttempt(SosDelivery.authenticationRequired);
          bytes.addAll(stream.current);
          if (bytes.length > 64 * 1024) {
            return const SosAttempt(SosDelivery.reviewRequired);
          }
        }
      } finally {
        await stream.cancel();
      }
      final body = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
      final alert = body['alert'] as Map<String, dynamic>;
      final id = alert['id'], status = alert['status'];
      final incidentKey = alert['key'];
      final created = DateTime.tryParse(alert['createdAt'] as String);
      final expiry = DateTime.tryParse(alert['expiresAt'] as String);
      if ((requireIncidentKey && (incidentKey is! String || incidentKey.isEmpty || incidentKey.length > 128)) || id is! String ||
          id.isEmpty ||
          id.length > 128 ||
          !['active', 'escalated', 'resolved', 'cancelled', 'expired']
              .contains(status) ||
          created?.isUtc != true ||
          expiry?.isUtc != true ||
          expiry!.isBefore(created!)) {
        return const SosAttempt(SosDelivery.reviewRequired);
      }
      if (!sameAccount()) return const SosAttempt(SosDelivery.authenticationRequired);
      await outbox.acknowledge(item.ownerSubject, item.requestId);
      if (!sameAccount()) return const SosAttempt(SosDelivery.authenticationRequired);
      return SosAttempt(SosDelivery.sent,
          receipt: SosReceipt(id, status as String, incidentKey: incidentKey is String ? incidentKey : null));
    } on TimeoutException {
      return const SosAttempt(SosDelivery.queued);
    } on http.ClientException {
      return const SosAttempt(SosDelivery.queued);
    } on FormatException {
      return const SosAttempt(SosDelivery.reviewRequired);
    } on TypeError {
      return const SosAttempt(SosDelivery.reviewRequired);
    }
  }
}

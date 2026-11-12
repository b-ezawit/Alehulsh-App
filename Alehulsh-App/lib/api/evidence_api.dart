import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'migration_api_client.dart';

/// Signed storage capabilities are confined to an explicitly configured
/// storage origin. API credentials never accompany a PUT or a redirect.
class EvidenceApi {
  EvidenceApi(this.client,
      {required this.storageOrigin, required this.uploadClient});
  final MigrationApiClient client;
  final Uri storageOrigin;
  final http.Client Function() uploadClient;
  static const maxBytes = 100 * 1024 * 1024;
  Future<void> save(
      {required String owner,
      required String alertId,
      required String incidentKey,
      required String evidenceId,
      required int length,
      required Stream<List<int>> Function() bytes,
      required int durationMs}) async {
    final epoch = client.accountEpoch();
    void check() {
      if (client.knownSubject() != owner || client.accountEpoch() != epoch)
        throw const ApiOperationException(401);
    }

    check();
    if (length < 1 ||
        length > maxBytes ||
        storageOrigin.scheme != 'https' ||
        storageOrigin.userInfo.isNotEmpty ||
        storageOrigin.hasQuery ||
        storageOrigin.hasFragment ||
        storageOrigin.host.isEmpty ||
        !(storageOrigin.path.isEmpty || storageOrigin.path == '/'))
      throw const ApiOperationException(503);
    // A lost PUT/finalize response is recovered without overwriting stored
    // evidence. Failed finalization is retried through the same immutable ID.
    try {
      final recovered = await client.authenticatedJson(
          'POST', '/v1/evidence/$evidenceId/complete',
          body: {});
      check();
      if (recovered['evidence'] is! Map ||
          recovered['evidence']['id'] != evidenceId ||
          recovered['evidence']['uploaded'] != true)
        throw const ApiOperationException(502);
      return;
    } on ApiOperationException catch (e) {
      if (![404, 409].contains(e.status)) rethrow;
    }
    check();
    final ticket = await client.authenticatedJson(
        'POST', '/v1/alerts/${Uri.encodeComponent(alertId)}/evidence',
        body: {
          'contentType': 'audio/mp4',
          'durationMs': durationMs,
          'kind': 'deliberate',
          'evidenceId': evidenceId,
          'incidentKey': incidentKey
        });
    check();
    if (ticket['evidence'] is Map && ticket['evidence']['uploaded'] == true)
      return;
    if (ticket['evidenceId'] != evidenceId || ticket['upload'] is! Map)
      throw const ApiOperationException(502);
    final upload = ticket['upload'] as Map,
        url = Uri.tryParse(upload['url']?.toString() ?? ''),
        expiry = DateTime.tryParse(upload['expiresAt']?.toString() ?? '');
    if (url == null ||
        url.origin != storageOrigin.origin ||
        url.scheme != 'https' ||
        url.userInfo.isNotEmpty ||
        url.hasFragment ||
        expiry == null ||
        !expiry.isUtc ||
        !expiry.isAfter(DateTime.now()) ||
        upload['method'] != 'PUT' ||
        jsonEncode(upload['headers']) !=
            jsonEncode({'content-type': 'audio/mp4'}))
      throw const ApiOperationException(502);
    final transport = uploadClient(),
        request = http.StreamedRequest('PUT', url)
          ..followRedirects = false
          ..contentLength = length
          ..headers['content-type'] = 'audio/mp4';
    var read = 0;
    Stream<List<int>> bounded() async* {
      await for (final block in bytes()) {
        check();
        read += block.length;
        if (read > length) throw const ApiOperationException(413);
        yield block;
      }
      if (read != length) throw const ApiOperationException(409);
    }

    try {
      final response = transport.send(request);
      final pipe = bounded().pipe(request.sink);
      final result = await Future.wait<Object?>([response, pipe])
          .timeout(const Duration(seconds: 60));
      check();
      final received = result[0] as http.StreamedResponse;
      await received.stream.listen((_) {}).cancel();
      if (received.statusCode < 200 || received.statusCode >= 300)
        throw ApiOperationException(received.statusCode);
    } finally {
      transport.close();
    }
    check();
    final complete = await client.authenticatedJson(
        'POST', '/v1/evidence/$evidenceId/complete',
        body: {});
    check();
    if (complete['evidence'] is! Map ||
        complete['evidence']['id'] != evidenceId ||
        complete['evidence']['uploaded'] != true)
      throw const ApiOperationException(502);
  }
}

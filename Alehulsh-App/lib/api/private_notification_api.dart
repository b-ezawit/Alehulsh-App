import 'migration_api_client.dart';

class NotificationConsent {
  const NotificationConsent(this.version, this.text);
  final String version, text;
}

class PrivateIncidentHint {
  const PrivateIncidentHint(this.incidentId, this.active);
  final String incidentId;
  final bool active;
}

class PrivateNotificationApi {
  PrivateNotificationApi(this.client);
  final MigrationApiClient client;
  Future<NotificationConsent> policy() async {
    final body =
        await client.authenticatedJson('GET', '/v1/me/notification-policy');
    if (body['version'] is! String ||
        body['text'] is! String ||
        body['text'].toString().isEmpty) {
      throw const ApiOperationException(502);
    }
    return NotificationConsent(body['version'], body['text']);
  }

  Future<String> register(
      String id, String token, String version, int revision) async {
    final body = await client.authenticatedJson(
        'PUT', '/v1/me/devices/${Uri.encodeComponent(id)}', body: {
      'token': token,
      'consentVersion': version,
      'revision': revision
    });
    if (body['generation'] is! String) throw const ApiOperationException(502);
    return body['generation'];
  }

  Future<void> disable(String id, String? generation, int revision) => client
      .authenticatedJson('DELETE', '/v1/me/devices/${Uri.encodeComponent(id)}',
          body: {'generation': generation, 'revision': revision}).then((_) {});
  Future<PrivateIncidentHint> receipt(String deliveryId,
      {required bool opened}) async {
    if (!RegExp(r'^[0-9a-fA-F-]{36}$').hasMatch(deliveryId)) {
      throw const ApiOperationException(400);
    }
    final body = await client.authenticatedJson(
        'POST', '/v1/me/deliveries/$deliveryId/receipt',
        body: {'stage': opened ? 'opened' : 'received'});
    if (body['incidentId'] is! String || body['active'] is! bool) {
      throw const ApiOperationException(502);
    }
    return PrivateIncidentHint(body['incidentId'], body['active']);
  }
}

import 'dart:async';
import '../models/alert_model.dart';
import 'migration_api_client.dart';

/// Application-facing operations. No Firestore fallback is permitted here.
class TrustedAlertGateway {
  TrustedAlertGateway(this.client, {this.pollInterval = const Duration(seconds: 3)});
  final MigrationApiClient client;
  final Duration pollInterval;
  final Map<String, String> _keys = {};
  String? _owner;
  int? _epoch;

  void _check(String owner, int epoch) {
    if (client.knownSubject() != owner || client.accountEpoch() != epoch) throw const ApiOperationException(401);
    if (_owner != owner || _epoch != epoch) { _keys.clear(); _owner = owner; _epoch = epoch; }
  }

  Future<String> create(String owner, {double? latitude, double? longitude,
      double? accuracyMeters, double? locationAgeMs,String? requestId}) async {
    final epoch = client.accountEpoch();
    _check(owner, epoch);
    await client.enqueueSos(latitude: latitude, longitude: longitude,
        accuracyMeters: accuracyMeters, locationAgeMs: locationAgeMs,requestId:requestId);
    _check(owner, epoch);
    final result = await client.flush();
    _check(owner, epoch);
    if (result.delivery == SosDelivery.queued) throw TimeoutException('SOS is saved for retry');
    if(result.delivery==SosDelivery.authenticationRequired||result.delivery==SosDelivery.reviewRequired){
      throw PendingSosNeedsAction(authentication:result.delivery==SosDelivery.authenticationRequired);
    }
    if (result.delivery != SosDelivery.sent || result.receipt?.incidentKey == null) {
      throw const ApiOperationException(503);
    }
    final receipt = result.receipt!;
    if(!['active','escalated'].contains(receipt.status))throw const ApiOperationException(409);
    _keys[receipt.id] = receipt.incidentKey!;
    return receipt.id;
  }

  /// A receipt confirms persistence only. Recipient delivery is separate.
  Future<EmergencyAlert?> own(String owner) async {
    final epoch = client.accountEpoch();
    _check(owner, epoch);
    final body = await client.ownAlert();
    _check(owner, epoch);
    if (!body.containsKey('alert')) throw const ApiOperationException(502);
    if (body['alert'] == null) return null;
    return _parse(Map<String, dynamic>.from(body['alert'] as Map), owner: owner);
  }

  Future<List<EmergencyAlert>> inbox() async {
    final epoch = client.accountEpoch();
    final owner = client.knownSubject();
    if (owner == null) throw const ApiOperationException(401);
    _check(owner, epoch);
    final body = await client.inbox();
    _check(owner, epoch);
    final items = body['items'];
    if (items is! List) throw const ApiOperationException(502);
    final alerts = <EmergencyAlert>[];
    for (final item in items) {
      final alert = _parse(Map<String, dynamic>.from(item as Map));
      if (!alert.isExpired) alerts.add(alert);
    }
    return alerts;
  }

  EmergencyAlert _parse(Map<String, dynamic> data, {String? owner}) {
    final id = data[owner == null ? 'alertId' : 'id'];
    final key = data['key'];
    final created = DateTime.tryParse(data['createdAt']?.toString() ?? '');
    final expiry = DateTime.tryParse(data['expiresAt']?.toString() ?? '');
    if (id is! String || id.isEmpty || key is! String || key.isEmpty ||
        created == null || expiry == null || !created.isUtc || !expiry.isUtc ||
        expiry.isBefore(created) || !['active', 'escalated'].contains(data['status'])) {
      throw const ApiOperationException(502);
    }
    _keys[id] = key;
    return EmergencyAlert(id: id, incidentKey: key, userId: owner ?? '', audience: owner == null ? data['audience'] as String? : null,
      hasAcknowledged:data['hasAcknowledged']==true,
      message:data['message'] as String? ?? '',
      delivery:owner!=null&&data['delivery'] is Map?Map<String,dynamic>.from(data['delivery'] as Map).map((key,value)=>MapEntry(key,value is int&&value>=0?value:0)):null,
      userName: data['displayName'] as String? ?? 'Alehulsh User',
      latitude: (data['latitude'] as num?)?.toDouble(),
      longitude: (data['longitude'] as num?)?.toDouble(),
      locationName: data['precision'] == 'exact' ? 'Shared location' : 'Approximate location',
      timestamp: created, expiresAt: expiry, status: data['status'] as String,
      acknowledgmentCount: data['acknowledgmentCount'] is int && data['acknowledgmentCount'] >= 0 ? data['acknowledgmentCount'] as int : null,
      isUrgent: data['isUrgent'] == true);
  }

  Future<bool> resolve(String id, String keyword) async {
    final epoch = client.accountEpoch();
    final owner = client.knownSubject();
    if (owner == null) throw const ApiOperationException(401);
    _check(owner, epoch);
    final key = _keys[id];
    if (key == null) throw const ApiOperationException(409);
    await client.requestResolution(id, keyword, incidentKey: key);
    // Uniform resolve acknowledgments deliberately reveal no keyword outcome.
    // Only an authoritative subsequent read can confirm that the incident ended.
    final current = await own(owner);
    _check(owner, epoch);
    return current == null || current.id != id || current.incidentKey != key || current.isExpired;
  }

  Future<void> accept(String id, String owner) async {
    final epoch = client.accountEpoch();
    _check(owner, epoch);
    final key = _keys[id];
    if (key == null) throw const ApiOperationException(409);
    await client.accept(id, incidentKey: key);
    _check(owner, epoch);
  }
  Future<void> withdraw(String id,String owner)async{
    final epoch=client.accountEpoch();_check(owner,epoch);final key=_keys[id];
    if(key==null)throw const ApiOperationException(409);
    await client.authenticatedJson('DELETE','/v1/alerts/${Uri.encodeComponent(id)}/accept',body:{'incidentKey':key});_check(owner,epoch);
  }
  Future<void> updateDetails(String id,{String? message,bool? isUrgent})async{
    final owner=client.knownSubject(),epoch=client.accountEpoch();if(owner==null)throw const ApiOperationException(401);
    _check(owner,epoch);final key=_keys[id];if(key==null)throw const ApiOperationException(409);
    await client.authenticatedJson('PATCH','/v1/alerts/${Uri.encodeComponent(id)}',body:{'incidentKey':key,if(message!=null)'message':message,if(isUrgent!=null)'isUrgent':isUrgent});
    _check(owner,epoch);
  }
}

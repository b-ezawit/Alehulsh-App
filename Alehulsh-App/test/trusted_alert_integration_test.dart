import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:alehulsh_app/api/migration_api_client.dart';
import 'package:alehulsh_app/api/trusted_alert_gateway.dart';
import 'package:alehulsh_app/models/user_profile_model.dart';
import 'package:alehulsh_app/services/alert_service.dart';
import 'migration_api_client_test.dart' show MemoryOutbox;

Map<String, dynamic> incident({String key = 'incident-one', String status = 'active'}) => {
  'id': 'alice', 'key': key, 'status': status,
  'createdAt': DateTime.now().toUtc().subtract(const Duration(minutes: 1)).toIso8601String(),
  'expiresAt': DateTime.now().toUtc().add(const Duration(minutes: 10)).toIso8601String(),
};
UserProfile profile() => UserProfile.guestProfile().copyWith(uid: 'alice');
void main() {
  test('an authentication-blocked SOS remains durable and is explicitly classified for user action',()async{
    final box=MemoryOutbox();final api=MigrationApiClient(baseUri:Uri.parse('https://synthetic.invalid'),knownSubject:()=> 'alice',session:()async=>null,
      outbox:box,httpClient:MockClient((_)async=>throw StateError('must not transmit')));
    await expectLater(TrustedAlertGateway(api).create('alice'),throwsA(isA<PendingSosNeedsAction>()));
    expect((await box.pending('alice')).length,1);
  });
  test('trusted note, urgency and withdrawal retain incident identity and never carry a caller-selected UID',()async{
    final requests=<http.Request>[];
    final api=MigrationApiClient(baseUri:Uri.parse('https://synthetic.invalid'),knownSubject:()=> 'alice',session:()async=>const ApiSession('alice','synthetic'),
      outbox:MemoryOutbox(),httpClient:MockClient((r)async{
        requests.add(r);return http.Response(jsonEncode(r.method=='GET'?{'alert':incident()}:{'saved':true}),r.method=='DELETE'?204:200);
      }));
    final gateway=TrustedAlertGateway(api);await gateway.own('alice');
    await gateway.updateDetails('alice',message:'Synthetic note');await gateway.updateDetails('alice',isUrgent:true);await gateway.withdraw('alice','alice');
    for(final r in requests.skip(1)){
      final body=jsonDecode(r.body)as Map;expect(body['incidentKey'],'incident-one');expect(body.containsKey('uid'),isFalse);expect(r.followRedirects,isFalse);
    }
    expect(requests.last.method,'DELETE');expect(requests.last.url.path,'/v1/alerts/alice/accept');
  });
  late String owner;
  late int epoch;
  late MemoryOutbox outbox;
  setUp(() { owner = 'alice'; epoch = 0; outbox = MemoryOutbox(); });
  MigrationApiClient client(Future<http.Response> Function(http.Request) send) => MigrationApiClient(
    baseUri: Uri.parse('https://synthetic.invalid'), knownSubject: () => owner,
    accountEpoch: () => epoch, session: () async => ApiSession(owner, 'synthetic-token'),
    outbox: outbox, httpClient: MockClient(send), requireIncidentKey: true);
  http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status);

  test('live alert service creates through the API and keeps immutable incident identity', () async {
    final api = client((request) async {
      expect(request.followRedirects, isFalse);
      if(request.method=='PATCH'){
        expect(request.url.path,'/v1/alerts/alice');expect(jsonDecode(request.body)['incidentKey'],'incident-one');return json({'saved':true});
      }
      expect(request.url.path, '/v1/alerts');
      expect(jsonDecode(request.body)['requestId'], outbox.values['alice']!.requestId);
      return json({'alert': incident()}, 201);
    });
    final service = AlertService.withTrustedApi(TrustedAlertGateway(api));
    expect(await service.createSOSAlert(profile: profile(), latitude: null, longitude: null, locationName: 'Unavailable'), 'alice');
    expect(outbox.values, isEmpty);
    await service.updateMessageNote('alice','note');
    await service.toggleUrgentStatus('alice',true);
  });
  test('offline service submission remains durable and retry reuses the request', () async {
    final ids = <String>[];
    var online = false;
    final api = client((request) async {
      ids.add(jsonDecode(request.body)['requestId']);
      if (!online) throw http.ClientException('offline');
      return json({'alert': incident()}, 201);
    });
    final service = AlertService.withTrustedApi(TrustedAlertGateway(api));
    await expectLater(service.createSOSAlert(profile: profile(), latitude: null, longitude: null, locationName: ''), throwsA(isA<TimeoutException>()));
    online = true;
    expect((await api.flush()).delivery, SosDelivery.sent);
    expect(ids.toSet().length, 1);
    expect(outbox.values, isEmpty);
  });
  test('uniform resolution acknowledgment alone never declares cancellation successful', () async {
    var terminal = false;
    final api = client((request) async {
      if (request.method == 'POST') {
        expect(jsonDecode(request.body)['incidentKey'], 'incident-one');
        return json({'acknowledged': true});
      }
      return json({'alert': terminal ? null : incident()});
    });
    final gateway = TrustedAlertGateway(api);
    await gateway.own(owner);
    final service = AlertService.withTrustedApi(gateway);
    final wrong = await service.cancelSOSAlert(alertId: 'alice', userCatName: '', inputCatName: 'incorrect');
    expect(wrong.isSuccess, isFalse);
    terminal = true;
    final correct = await service.cancelSOSAlert(alertId: 'alice', userCatName: '', inputCatName: 'correct');
    expect(correct.isSuccess, isTrue);
  });
  test('owner stream includes escalated alerts and exposes authoritative absence', () async {
    var terminal = false;
    final api = client((_) async => json({'alert': terminal ? null : incident(status: 'escalated')}));
    final gateway = TrustedAlertGateway(api, pollInterval: const Duration(milliseconds: 1));
    final stream = StreamIterator(AlertService.withTrustedApi(gateway).getUserActiveAlertStream('alice'));
    await stream.moveNext();
    expect(stream.current.alert?.status, 'escalated');
    expect(stream.current.isAuthoritative, isTrue);
    terminal = true;
    await stream.moveNext();
    expect(stream.current.alert, isNull);
    expect(stream.current.isAuthoritative, isTrue);
    await stream.cancel();
  });
  test('network failure is unknown rather than authoritative terminal state', () async {
    final api = client((_) async => json({}, 503));
    final snapshot = await AlertService.withTrustedApi(TrustedAlertGateway(api)).getUserActiveAlertStream('alice').first;
    expect(snapshot.isAuthoritative, isFalse);
    expect(snapshot.alert, isNull);
  });
  test('recipient inbox uses server precision and rejects missing source expiry', () async {
    var expiryPresent = true;
    final api = client((request) async {
      expect(request.url.path, '/v1/me/inbox');
      final data = incident()..['alertId'] = 'alice'..['precision'] = 'geohash7'..['latitude'] = 9.0..['longitude'] = 38.0;
      if (!expiryPresent) data.remove('expiresAt');
      return json({'items': [data]});
    });
    final gateway = TrustedAlertGateway(api);
    expect((await gateway.inbox()).single.locationName, 'Approximate location');
    expiryPresent = false;
    await expectLater(gateway.inbox(), throwsA(isA<ApiOperationException>()));
  });
  test('account switch during response retains queued work and does not acknowledge it', () async {
    final api = client((_) async { owner = 'bob'; epoch++; return json({'alert': incident()}, 201); });
    await api.enqueueSos();
    expect((await api.flush()).delivery, SosDelivery.authenticationRequired);
    expect(outbox.values['alice'], isNotNull);
  });
  test('sign out and back into same account fences an old response', () async {
    final api = client((_) async { epoch += 2; return json({'alert': incident()}, 201); });
    await api.enqueueSos();
    expect((await api.flush()).delivery, SosDelivery.authenticationRequired);
    expect(outbox.values['alice'], isNotNull);
  });
  test('missing immutable receipt key never removes durable work', () async {
    final api = client((_) async => json({'alert': incident()..remove('key')}, 201));
    await api.enqueueSos();
    expect((await api.flush()).delivery, SosDelivery.reviewRequired);
    expect(outbox.values['alice'], isNotNull);
  });

  test('cached owner snapshots are not authoritative confirmation', () async {
    final alert = await TrustedAlertGateway(client((_) async => json({'alert':incident()}))).own('alice');
    expect(alert,isNotNull);
    expect(ActiveAlertSnapshot(alert:alert,isFromCache:true).isConfirmedDelivered,isFalse);
    expect(ActiveAlertSnapshot(alert:alert,isFromCache:false,isAuthoritative:true).isConfirmedDelivered,isTrue);
  });
  test('an offline pending submission is not erased by an empty owner response', () async {
    final api = client((request) async => request.method == 'POST' ? json({},503) : json({'alert':null}));
    await api.enqueueSos();
    final snapshot = await AlertService.withTrustedApi(TrustedAlertGateway(api)).getUserActiveAlertStream('alice').first;
    expect(snapshot.alert,isNull); expect(snapshot.isAuthoritative,isFalse);
    expect(outbox.values['alice'],isNotNull);
  });
  test('recipient acceptance carries the exact displayed incident key', () async {
    final api = client((request) async {
      if(request.method=='POST') {
        expect(jsonDecode(request.body)['incidentKey'],'incident-one');
        return json({'acceptance':{'alertId':'alice'}});
      }
      return json({'items':[{...incident(),'alertId':'alice','audience':'contact'}]});
    });
    final gateway=TrustedAlertGateway(api); await gateway.inbox();
    await gateway.accept('alice','alice');
    await expectLater(gateway.accept('alice','bob'),throwsA(isA<ApiOperationException>()));
  });
  test('inbox failure removes previous location, signals unavailability, and recovers', () async {
    var reads=0;
    final api=client((_) async {
      reads++;
      if(reads==2)return json({},503);
      return json({'items':[{...incident(),'alertId':'alice','latitude':9.0,'longitude':38.0,'audience':'contact'}]});
    });
    final gateway=TrustedAlertGateway(api,pollInterval:const Duration(milliseconds:1));
    final events=<int>[], errors=<Object>[]; final recovered=Completer<void>();
    final subscription=AlertService.withTrustedApi(gateway).alertsStream.listen((items){
      events.add(items.length); if(events.length>=3&&!recovered.isCompleted)recovered.complete();
    },onError:(Object error){errors.add(error);});
    await recovered.future.timeout(const Duration(seconds:2)); await subscription.cancel();
    expect(events.take(3),[1,0,1]); expect(errors.single,isA<ApiOperationException>());
  });

  test('in-app acknowledgment counts remain distinct from transport receipts', () async {
    final gateway=TrustedAlertGateway(client((_)async=>json({'alert':{...incident(),'acknowledgmentCount':1}})));
    expect((await gateway.own('alice'))!.acknowledgmentCount,1);
    expect((await TrustedAlertGateway(client((_)async=>json({'alert':incident()}))).own('alice'))!.acknowledgmentCount,isNull);
  });
}

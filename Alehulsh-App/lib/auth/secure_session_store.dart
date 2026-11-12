import 'package:flutter/services.dart';

abstract class SecureSessionStore {
  Future<String?> read();
  Future<void> write(String session);
  Future<void> remove();
}

/// Android Keystore + AtomicFile in noBackupFilesDir. Other platforms refuse
/// persistence until their reviewed secure adapter is supplied.
class NativeSessionStore implements SecureSessionStore {
  const NativeSessionStore(this.namespace, {this.slot = 'session'});
  final String namespace;
  final String slot;
  static const channel =
      MethodChannel('com.example.alehulsh_app/trusted_session');
  @override
  Future<String?> read() => channel
      .invokeMethod<String>('read', {'namespace': namespace, 'slot': slot});
  @override
  Future<void> write(String session) => channel.invokeMethod<void>(
      'write', {'namespace': namespace, 'slot': slot, 'session': session});
  @override
  Future<void> remove() => channel
      .invokeMethod<void>('remove', {'namespace': namespace, 'slot': slot});
}

class NativePushRevision {
  const NativePushRevision(this.namespace);
  final String namespace;
  Future<int> next(String owner, String deviceId) async {
    final revision = await NativeSessionStore.channel.invokeMethod<int>(
        'nextPushRevision',
        {'namespace': namespace, 'owner': owner, 'deviceId': deviceId});
    if (revision == null || revision < 1 || revision > 9007199254740991) {
      throw StateError('Durable notification intent unavailable');
    }
    return revision;
  }
}

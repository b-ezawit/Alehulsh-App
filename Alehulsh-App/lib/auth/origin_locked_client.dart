import 'dart:async';
import 'package:http/http.dart' as http;

/// Provider SDK calls are confined to the configured Auth origin. Redirects
/// never forward passwords, refresh tokens or bearer credentials.
class OriginLockedClient extends http.BaseClient {
  OriginLockedClient(this.origin, this.inner,
      {this.timeout = const Duration(seconds: 10)});
  final Uri origin;
  final http.Client inner;
  final Duration timeout;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.origin != origin.origin ||
        !request.url.path.startsWith('/auth/v1/')) {
      throw http.ClientException('Authentication origin refused');
    }
    request.followRedirects = false;
    final clock = Stopwatch()..start();
    final response = await inner.send(request).timeout(timeout);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      await response.stream.listen(null).cancel();
      throw http.ClientException('Authentication redirect refused');
    }
    Stream<List<int>> bounded() async* {
      var size = 0;
      final iterator = StreamIterator(response.stream);
      try {
        while (true) {
          final left = timeout - clock.elapsed;
          if (left <= Duration.zero)
            throw TimeoutException('Authentication deadline');
          if (!await iterator.moveNext().timeout(left)) break;
          size += iterator.current.length;
          if (size > 64 * 1024)
            throw http.ClientException('Authentication response limit');
          yield iterator.current;
        }
      } finally {
        await iterator.cancel();
      }
    }

    return http.StreamedResponse(bounded(), response.statusCode,
        headers: response.headers);
  }

  @override
  void close() => inner.close();
}

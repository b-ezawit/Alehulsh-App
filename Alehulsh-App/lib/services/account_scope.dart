class AccountTicket {
  const AccountTicket(this.owner, this.generation);
  final String owner;
  final int generation;
}

/// Invalidates asynchronous work before a different account can observe it.
class AccountScope {
  String? _owner;
  int _generation = 0;
  void bind(String? owner) {
    if (_owner == owner) return;
    _owner = owner;
    _generation++;
  }

  AccountTicket? capture(String owner) => _owner == owner
      ? AccountTicket(owner, _generation) : null;
  bool owns(AccountTicket ticket) =>
      _owner == ticket.owner && _generation == ticket.generation;

  Future<T?> read<T>(AccountTicket ticket, Future<T> Function() operation) async {
    if (!owns(ticket)) return null;
    final result = await operation();
    return owns(ticket) ? result : null;
  }
}

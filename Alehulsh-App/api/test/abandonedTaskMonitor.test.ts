/**
 * Abandoned-task monitoring: classification, severity, and what gets logged.
 *
 * No database and NO NETWORK. The Queryable is a stub, so every case is
 * deterministic, and `fetch` is replaced with a function that fails the test
 * if anything calls it - the monitoring path must not be able to reach a
 * provider even by accident.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Queryable } from '../src/db/pool.js';
import type { Logger } from '../src/logger.js';
import {
  AbandonedTaskMonitor, classifyTaskError, extractHttpStatus,
  isRegisteredKind, severityForKind,
  NON_SAFETY_KINDS, SAFETY_CRITICAL_KINDS,
} from '../src/queue/AbandonedTaskMonitor.js';

interface Line { level: string; msg: string; ctx: Record<string, unknown> | undefined }

function recordingLogger(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
    lines.push({ level, msg, ctx });
  };
  return {
    lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
  } as Logger & { lines: Line[] };
}

interface Candidate {
  id: string; kind: string; attempts: number; max_attempts: number;
  abandoned_at: Date; last_error: string | null;
}

/**
 * A Queryable that answers the two statements the monitor issues.
 *
 * `announce` decides which ids the ledger hands back, which is how a
 * concurrent monitor and an already-recorded task are simulated.
 */
function stubDb(candidates: Candidate[], options: {
  announce?: (ids: string[]) => string[];
  failOn?: 'select' | 'insert';
} = {}): Queryable & { calls: { sql: string; params: readonly unknown[] }[] } {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const announce = options.announce ?? ((ids: string[]) => ids);
  return {
    calls,
    async query<R extends QueryResultRow = QueryResultRow>(
      sql: string, params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      calls.push({ sql, params });
      const isSelect = sql.includes('FROM task_queue');
      if (options.failOn === 'select' && isSelect) throw new Error('connection terminated');
      if (options.failOn === 'insert' && !isSelect) throw new Error('permission denied for function');
      const rows = isSelect
        ? candidates.slice(0, Number(params[0]))
        : announce((params[0] as string[])).map((id) => ({ record_task_alerts: id }));
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<R>;
    },
  } as Queryable & { calls: { sql: string; params: readonly unknown[] }[] };
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: '1', kind: 'safety-check', attempts: 5, max_attempts: 5,
  abandoned_at: new Date('2026-10-20T09:00:00.000Z'), last_error: 'task route returned 500',
  ...over,
});

// Nothing in this suite may touch the network.
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (() => { fetchCalls += 1; throw new Error('fetch must not be called'); }) as typeof fetch;
afterEach(() => { assert.equal(fetchCalls, 0, 'the monitoring path made a network call'); });
process.on('exit', () => { globalThis.fetch = realFetch; });

describe('classifyTaskError — a closed vocabulary', () => {
  test('recognises every message this system actually produces', () => {
    assert.equal(classifyTaskError("no handler registered for task kind 'notify-contacts'"), 'no_handler');
    assert.equal(classifyTaskError('task notify-contacts carries no alertId'), 'missing_alert_id');
    assert.equal(classifyTaskError('task route returned 500'), 'route_rejected');
    assert.equal(classifyTaskError('task route returned 401'), 'route_rejected');
    assert.equal(classifyTaskError('lease expired with attempts exhausted'), 'lease_expired');
    assert.equal(classifyTaskError('This operation was aborted'), 'timeout');
    assert.equal(classifyTaskError('fetch failed'), 'unreachable');
    assert.equal(classifyTaskError('connect ECONNREFUSED 127.0.0.1:1'), 'unreachable');
    assert.equal(classifyTaskError('getaddrinfo ENOTFOUND api.invalid'), 'unreachable');
    assert.equal(classifyTaskError('socket hang up'), 'unreachable');
  });

  test('no error recorded is `none`, not `unclassified`', () => {
    assert.equal(classifyTaskError(null), 'none');
    assert.equal(classifyTaskError(undefined), 'none');
    assert.equal(classifyTaskError(''), 'none');
    assert.equal(classifyTaskError('   '), 'none');
  });

  test('anything else is `unclassified` — it does not guess', () => {
    assert.equal(classifyTaskError('Firestore: 7 PERMISSION_DENIED'), 'unclassified');
    assert.equal(classifyTaskError('x'.repeat(10_000)), 'unclassified');
  });

  test('a near-miss on a known shape does not borrow its classification', () => {
    // Not the sweep's exact sentinel, so it must not claim to be a dead worker.
    assert.equal(classifyTaskError('lease expired with attempts exhausted (retrying)'), 'unclassified');
    // Not three digits, so not the dispatcher's own message.
    assert.equal(classifyTaskError('task route returned 5000'), 'unclassified');
  });

  test('the classification of an arbitrary message never contains the message', () => {
    const secretish = 'POST https://api.example/v1?token=abc123 failed for +251911000000';
    const cls: string = classifyTaskError(secretish);
    assert.equal(cls, 'unclassified');
    assert.ok(!secretish.includes(cls) || cls === 'unclassified');
    assert.equal(extractHttpStatus(secretish), null);
  });
});

describe('extractHttpStatus', () => {
  test('returns the status only for the dispatcher’s exact message', () => {
    assert.equal(extractHttpStatus('task route returned 503'), 503);
    assert.equal(extractHttpStatus('task route returned 503 from upstream'), null);
    assert.equal(extractHttpStatus(null), null);
  });
});

describe('severity — safety by default, background only on purpose', () => {
  test('every kind this queue carries is safety-critical', () => {
    for (const kind of ['safety-check', 'expiry', 'notify-contacts']) {
      assert.equal(severityForKind(kind), 'safety');
      assert.ok(isRegisteredKind(kind));
    }
    assert.equal(SAFETY_CRITICAL_KINDS.size, 3);
  });

  test('nothing is downgraded today, so an unknown kind is treated as safety', () => {
    assert.equal(NON_SAFETY_KINDS.size, 0);
    assert.equal(severityForKind('some-future-kind'), 'safety');
    // ...and says the rating was defaulted rather than decided.
    assert.equal(isRegisteredKind('some-future-kind'), false);
  });

  test('an explicitly downgraded kind becomes background', () => {
    const nonSafety = new Set(['metrics-rollup']);
    assert.equal(severityForKind('metrics-rollup', nonSafety), 'background');
    assert.equal(isRegisteredKind('metrics-rollup', nonSafety), true);
    // The downgrade is per-kind and does not leak to the safety kinds.
    assert.equal(severityForKind('safety-check', nonSafety), 'safety');
  });
});

describe('scan', () => {
  test('an empty queue still logs the liveness line, and records nothing', async () => {
    const logger = recordingLogger();
    const db = stubDb([]);
    const result = await new AbandonedTaskMonitor(db, logger).scan();

    assert.deepEqual(result, {
      candidates: 0, reported: 0, suppressed: 0,
      safety: 0, background: 0, truncated: false, failed: false,
    });
    assert.equal(db.calls.length, 1, 'no insert is attempted for an empty scan');
    const liveness = logger.lines.filter((l) => l.msg === 'abandoned-task scan');
    assert.equal(liveness.length, 1);
    assert.equal(liveness[0]?.level, 'info');
  });

  test('a safety-critical abandonment is reported at error', async () => {
    const logger = recordingLogger();
    const result = await new AbandonedTaskMonitor(
      stubDb([candidate({ id: '42', kind: 'safety-check' })]), logger,
    ).scan();

    assert.equal(result.reported, 1);
    assert.equal(result.safety, 1);
    assert.equal(result.background, 0);
    const line = logger.lines.find((l) => l.msg.startsWith('ABANDONED safety-critical'));
    assert.ok(line, 'a safety abandonment must be logged at error');
    assert.equal(line?.level, 'error');
    assert.equal(line?.ctx?.['taskId'], '42');
    assert.equal(line?.ctx?.['kind'], 'safety-check');
    assert.equal(line?.ctx?.['errorClass'], 'route_rejected');
    assert.equal(line?.ctx?.['httpStatus'], 500);
    assert.equal(line?.ctx?.['severity'], 'safety');
    assert.equal(line?.ctx?.['kindRegistered'], true);
  });

  test('a background abandonment is distinguished, and logged at warn', async () => {
    const logger = recordingLogger();
    const monitor = new AbandonedTaskMonitor(
      stubDb([candidate({ id: '7', kind: 'metrics-rollup', last_error: null })]),
      logger, { nonSafetyKinds: new Set(['metrics-rollup']) },
    );
    const result = await monitor.scan();

    assert.equal(result.background, 1);
    assert.equal(result.safety, 0);
    const line = logger.lines.find((l) => l.msg === 'abandoned background task');
    assert.equal(line?.level, 'warn');
    assert.equal(line?.ctx?.['errorClass'], 'none');
    assert.ok(!('httpStatus' in (line?.ctx ?? {})), 'no status is invented when there was none');
    assert.equal(
      logger.lines.some((l) => l.msg.startsWith('ABANDONED safety-critical')), false,
      'a background task must not be announced as safety-critical',
    );
  });

  test('an unregistered kind is treated as safety and says the rating was defaulted', async () => {
    const logger = recordingLogger();
    await new AbandonedTaskMonitor(
      stubDb([candidate({ id: '9', kind: 'brand-new-kind' })]), logger,
    ).scan();

    const line = logger.lines.find((l) => l.msg.startsWith('ABANDONED safety-critical'));
    assert.equal(line?.level, 'error');
    assert.equal(line?.ctx?.['kindRegistered'], false);
  });

  test('the ledger decides who announces: a task it does not return is suppressed', async () => {
    const logger = recordingLogger();
    const db = stubDb(
      [candidate({ id: '1' }), candidate({ id: '2' }), candidate({ id: '3' })],
      // Another monitor got 1 and 3 first.
      { announce: () => ['2'] },
    );
    const result = await new AbandonedTaskMonitor(db, logger).scan();

    assert.equal(result.candidates, 3);
    assert.equal(result.reported, 1);
    assert.equal(result.suppressed, 2);
    const announced = logger.lines
      .filter((l) => l.msg.startsWith('ABANDONED'))
      .map((l) => l.ctx?.['taskId']);
    assert.deepEqual(announced, ['2'], 'only the id the ledger returned is announced');
  });

  test('records before announcing, so a signal always has a durable row behind it', async () => {
    const logger = recordingLogger();
    const db = stubDb([candidate()], { failOn: 'insert' });
    const result = await new AbandonedTaskMonitor(db, logger).scan();

    assert.equal(result.failed, true);
    assert.equal(result.reported, 0);
    assert.equal(
      logger.lines.some((l) => l.msg.startsWith('ABANDONED')), false,
      'nothing may be announced when the ledger write failed',
    );
  });

  test('the batch is bounded and says when more may remain', async () => {
    const many = Array.from({ length: 10 }, (_, i) => candidate({ id: String(i + 1) }));
    const logger = recordingLogger();
    const db = stubDb(many);
    const result = await new AbandonedTaskMonitor(db, logger, { batchSize: 4 }).scan();

    assert.equal(result.candidates, 4);
    assert.equal(result.truncated, true, 'a full batch means more may be waiting');
    assert.equal(db.calls[0]?.params[0], 4);
  });

  test('a batch that is not full is not reported as truncated', async () => {
    const result = await new AbandonedTaskMonitor(
      stubDb([candidate()]), recordingLogger(), { batchSize: 4 },
    ).scan();
    assert.equal(result.truncated, false);
  });

  test('a nonsense batch size cannot disable the scan', async () => {
    const db = stubDb([candidate()]);
    await new AbandonedTaskMonitor(db, recordingLogger(), { batchSize: 0 }).scan();
    assert.equal(db.calls[0]?.params[0], 1, 'clamped to at least one');
  });

  test('a database failure is loud, returns failed, and NEVER throws', async () => {
    const logger = recordingLogger();
    const monitor = new AbandonedTaskMonitor(stubDb([], { failOn: 'select' }), logger);

    const result = await monitor.scan();
    assert.equal(result.failed, true);
    assert.equal(monitor.stats.failures, 1);
    assert.equal(monitor.stats.consecutiveFailures, 1);
    assert.equal(monitor.stats.scans, 0, 'a failed scan is not counted as a scan');
    const err = logger.lines.find((l) => l.msg.startsWith('abandoned-task scan FAILED'));
    assert.equal(err?.level, 'error');
    assert.equal(err?.ctx?.['consecutiveFailures'], 1);
  });

  test('every failure is logged, not only the first', async () => {
    const logger = recordingLogger();
    const monitor = new AbandonedTaskMonitor(stubDb([], { failOn: 'select' }), logger);
    await monitor.scan();
    await monitor.scan();
    await monitor.scan();

    assert.equal(monitor.stats.consecutiveFailures, 3);
    assert.equal(
      logger.lines.filter((l) => l.msg.startsWith('abandoned-task scan FAILED')).length, 3,
      'an operator needs to see it continuing to fail',
    );
  });

  test('recovery after failure resets the consecutive count', async () => {
    const logger = recordingLogger();
    let broken = true;
    const db: Queryable = {
      async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
        if (broken) throw new Error('connection terminated unexpectedly');
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<R>;
      },
    };
    const monitor = new AbandonedTaskMonitor(db, logger);

    await monitor.scan();
    assert.equal(monitor.stats.consecutiveFailures, 1);
    broken = false;
    const after = await monitor.scan();

    assert.equal(after.failed, false);
    assert.equal(monitor.stats.consecutiveFailures, 0);
    assert.equal(monitor.stats.failures, 1, 'the historical total is kept');
    assert.equal(monitor.stats.scans, 1);
    assert.ok(monitor.stats.lastScanAt instanceof Date);
    assert.ok(monitor.stats.lastFailureAt instanceof Date);
  });
});

describe('redaction', () => {
  test('no log line carries the payload, an alert id, or the raw error text', async () => {
    const logger = recordingLogger();
    // Everything that must not escape, in the one field that is free text.
    const nasty = 'POST /x?token=sk-live-99 failed: alertId=5f2c user +251911223344 '
      + 'at 8.9956,38.7897 keyword=Milo';
    await new AbandonedTaskMonitor(
      stubDb([candidate({ id: '11', kind: 'safety-check', last_error: nasty })]), logger,
    ).scan();

    const dump = JSON.stringify(logger.lines);
    for (const forbidden of [
      'sk-live-99', 'alertId', '5f2c', '251911223344', '8.9956', '38.7897', 'Milo',
      'payload', 'token',
    ]) {
      assert.ok(!dump.includes(forbidden), `a log line leaked ${forbidden}`);
    }
    const line = logger.lines.find((l) => l.msg.startsWith('ABANDONED'));
    assert.equal(line?.ctx?.['errorClass'], 'unclassified');
  });

  test('the candidate query never selects the payload at all', async () => {
    const db = stubDb([candidate()]);
    await new AbandonedTaskMonitor(db, recordingLogger()).scan();
    const select = db.calls[0]?.sql ?? '';
    assert.ok(select.includes('FROM task_queue'));
    assert.ok(!/\bpayload\b/.test(select), 'the payload must not even be fetched');
  });

  test('a kind longer than the ledger allows is truncated, not rejected forever', async () => {
    const logger = recordingLogger();
    const db = stubDb([candidate({ id: '3', kind: 'k'.repeat(200) })]);
    await new AbandonedTaskMonitor(db, logger).scan();

    const kinds = db.calls[1]?.params[1] as string[];
    assert.equal(kinds[0]?.length, 64);
  });
});

describe('what it must never do', () => {
  test('it issues only a read of task_queue and a call to the ledger function', async () => {
    const db = stubDb([candidate()]);
    await new AbandonedTaskMonitor(db, recordingLogger()).scan();

    assert.equal(db.calls.length, 2);
    for (const { sql } of db.calls) {
      for (const forbidden of [
        'claim_tasks', 'complete_task', 'cancel_task', 'enqueue_task',
        'UPDATE task_queue', 'DELETE', 'INSERT INTO task_queue',
      ]) {
        assert.ok(!sql.includes(forbidden), `the monitor issued ${forbidden}`);
      }
    }
    assert.ok(db.calls[1]?.sql.includes('record_task_alerts'));
  });
});

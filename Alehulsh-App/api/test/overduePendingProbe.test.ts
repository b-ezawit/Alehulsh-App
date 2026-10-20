/**
 * The overdue-pending probe: what it classifies, and what it refuses to claim.
 *
 * No database and NO NETWORK. The Queryable is a stub, so the stall / backlog
 * distinction is driven exactly, and `fetch` is replaced with a function that
 * fails the test if anything calls it.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Queryable } from '../src/db/pool.js';
import type { Logger } from '../src/logger.js';
import { OverduePendingProbe } from '../src/queue/OverduePendingProbe.js';

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

interface Row {
  kind: string; due_count: number; reclaimable_count: number; retrying: number;
  oldest_due_ms: string; head_id: string | null;
}

const row = (over: Partial<Row> = {}): Row => ({
  kind: 'safety-check', due_count: 1, reclaimable_count: 0, retrying: 0,
  oldest_due_ms: '5000', head_id: '100', ...over,
});

/** Answers the probe's one statement with a scripted sequence of results. */
function stubDb(script: (Row[] | Error)[]): Queryable & { sql: string[] } {
  let i = 0;
  const sql: string[] = [];
  return {
    sql,
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string, params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      sql.push(text);
      const next = script[Math.min(i, script.length - 1)] ?? [];
      i += 1;
      if (next instanceof Error) throw next;
      const rows = next.slice(0, Number(params[0] ?? 999));
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<R>;
    },
  } as Queryable & { sql: string[] };
}

const drained = { claimed: 0, capacity: 10 };
const saturated = { claimed: 10, capacity: 10 };

const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (() => { fetchCalls += 1; throw new Error('fetch must not be called'); }) as typeof fetch;
afterEach(() => { assert.equal(fetchCalls, 0, 'the probe made a network call'); });
process.on('exit', () => { globalThis.fetch = realFetch; });

describe('an empty claimable set', () => {
  test('reports facts at info and nothing else', async () => {
    const logger = recordingLogger();
    const result = await new OverduePendingProbe(stubDb([[]]), logger).scan(drained);

    assert.equal(result.dueTotal, 0);
    assert.equal(result.reclaimableTotal, 0);
    assert.equal(result.oldestDueMs, 0);
    assert.deepEqual(result.persisting, []);
    assert.equal(result.failed, false);
    const line = logger.lines.find((l) => l.msg === 'overdue-pending probe');
    assert.equal(line?.level, 'info', 'the liveness line is emitted even with nothing to report');
    assert.equal(logger.lines.some((l) => l.level === 'warn' || l.level === 'error'), false);
  });
});

describe('technically due is NOT reported as stalled', () => {
  test('a first sighting is only a fact, however old the task is', async () => {
    // No threshold exists, so age alone must never produce a verdict - the
    // worker may simply not have come round yet.
    const logger = recordingLogger();
    const result = await new OverduePendingProbe(
      stubDb([[row({ oldest_due_ms: '3600000' })]]), logger,
    ).scan(drained);

    assert.equal(result.dueTotal, 1);
    assert.equal(result.oldestDueMs, 3_600_000);
    assert.deepEqual(result.persisting, [], 'one sighting cannot confirm anything');
    assert.equal(logger.lines.filter((l) => l.level === 'warn').length, 0);
    const line = logger.lines.find((l) => l.msg === 'overdue-pending probe');
    assert.equal(line?.level, 'info');
    // ...and the age is reported, because it is the measurement a threshold
    // would have to be chosen from.
    assert.equal(line?.ctx?.['oldestDueMs'], 3_600_000);
  });

  test('a head that MOVES between scans is draining, so never warned about', async () => {
    const logger = recordingLogger();
    const probe = new OverduePendingProbe(
      stubDb([[row({ head_id: '1' })], [row({ head_id: '2' })], [row({ head_id: '3' })]]),
      logger,
    );
    await probe.scan(drained);
    await probe.scan(drained);
    await probe.scan(drained);

    assert.equal(logger.lines.filter((l) => l.level === 'warn').length, 0);
    assert.equal(probe.stats.scans, 3);
  });
});

describe('confirmed by observation, not by a clock', () => {
  test('a head that has not moved across two scans is warned about', async () => {
    const logger = recordingLogger();
    const probe = new OverduePendingProbe(stubDb([[row({ head_id: '77' })]]), logger);

    const first = await probe.scan(drained);
    assert.deepEqual(first.persisting, []);

    const second = await probe.scan(drained);
    assert.deepEqual(second.persisting, ['safety-check']);

    const warn = logger.lines.find((l) => l.level === 'warn');
    assert.ok(warn);
    assert.match(warn.msg, /NOT DRAINING/);
    assert.deepEqual(warn.ctx?.['persistingKinds'], ['safety-check']);
  });

  test('spare capacity means a stall; a full batch means a backlog', async () => {
    const stalled = recordingLogger();
    const probeA = new OverduePendingProbe(stubDb([[row({ head_id: '5' })]]), stalled);
    await probeA.scan(drained);
    await probeA.scan(drained);
    const a = stalled.lines.find((l) => l.level === 'warn');
    assert.match(a!.msg, /spare capacity/);
    assert.equal(a!.ctx?.['spareCapacity'], true);

    const behind = recordingLogger();
    const probeB = new OverduePendingProbe(stubDb([[row({ head_id: '5' })]]), behind);
    await probeB.scan(saturated);
    await probeB.scan(saturated);
    const b = behind.lines.find((l) => l.level === 'warn');
    assert.match(b!.msg, /backlog, not a stall/);
    assert.equal(b!.ctx?.['spareCapacity'], false);
  });

  test('NOTHING is logged at error — that needs the threshold decision', async () => {
    const logger = recordingLogger();
    const probe = new OverduePendingProbe(
      stubDb([[row({ head_id: '9', oldest_due_ms: '86400000' })]]), logger,
    );
    await probe.scan(drained);
    await probe.scan(drained);

    assert.equal(
      logger.lines.some((l) => l.level === 'error'), false,
      'calling a busy-but-working queue an error is how a channel gets ignored',
    );
  });

  test('per-kind heads are tracked independently', async () => {
    const logger = recordingLogger();
    const probe = new OverduePendingProbe(stubDb([
      [row({ kind: 'safety-check', head_id: '1' }), row({ kind: 'expiry', head_id: '2' })],
      // safety-check drained, expiry did not.
      [row({ kind: 'safety-check', head_id: '9' }), row({ kind: 'expiry', head_id: '2' })],
    ]), logger);

    await probe.scan(drained);
    const second = await probe.scan(drained);

    assert.deepEqual(second.persisting, ['expiry'], 'only the kind that stood still');
  });

  test('a kind that disappears and returns is not treated as persisting', async () => {
    const logger = recordingLogger();
    const probe = new OverduePendingProbe(stubDb([
      [row({ head_id: '4' })],
      [],                        // drained entirely
      [row({ head_id: '4' })],   // a different task cycle, same id reused is impossible
    ]), logger);

    await probe.scan(drained);
    await probe.scan(drained);
    const third = await probe.scan(drained);

    assert.deepEqual(third.persisting, [], 'the memory is reset by an empty scan');
  });
});

describe('expired leases are a separate, named stall class', () => {
  test('reclaimable rows are counted but never confused with pending ones', async () => {
    const logger = recordingLogger();
    const result = await new OverduePendingProbe(stubDb([[
      row({ kind: 'expiry', due_count: 0, reclaimable_count: 3, head_id: null }),
    ]]), logger).scan(drained);

    assert.equal(result.dueTotal, 0);
    assert.equal(result.reclaimableTotal, 3);
    assert.deepEqual(result.persisting, [], 'no pending head to track');
    const line = logger.lines.find((l) => l.msg === 'overdue-pending probe');
    assert.equal(line?.ctx?.['reclaimableTotal'], 3);
  });
});

describe('failure and hygiene', () => {
  test('a database failure is loud, returns failed, and NEVER throws', async () => {
    const logger = recordingLogger();
    const probe = new OverduePendingProbe(stubDb([new Error('connection terminated')]), logger);

    const result = await probe.scan(drained);
    assert.equal(result.failed, true);
    assert.equal(result.dueTotal, 0);
    assert.equal(probe.stats.failures, 1);
    assert.equal(probe.stats.consecutiveFailures, 1);
    assert.equal(probe.stats.scans, 0, 'a failed scan is not counted as a scan');
    const err = logger.lines.find((l) => l.msg.startsWith('overdue-pending probe FAILED'));
    assert.equal(err?.level, 'error');
  });

  test('every failure is logged, and recovery resets the count', async () => {
    const logger = recordingLogger();
    const boom = new Error('connection terminated');
    const probe = new OverduePendingProbe(stubDb([boom, boom, []]), logger);
    await probe.scan(drained);
    await probe.scan(drained);
    assert.equal(probe.stats.consecutiveFailures, 2);
    assert.equal(logger.lines.filter((l) => l.msg.startsWith('overdue-pending probe FAILED')).length, 2);

    await probe.scan(drained);
    assert.equal(probe.stats.consecutiveFailures, 0);
    assert.equal(probe.stats.failures, 2, 'the historical total is kept');
  });

  test('a failed scan does not poison the head memory', async () => {
    // Otherwise an outage would make the next scan look like a fresh sighting
    // and silently suppress a warning that was already due.
    const logger = recordingLogger();
    const probe = new OverduePendingProbe(stubDb([
      [row({ head_id: '8' })], new Error('blip'), [row({ head_id: '8' })],
    ]), logger);

    await probe.scan(drained);
    await probe.scan(drained);
    const third = await probe.scan(drained);

    assert.deepEqual(third.persisting, ['safety-check'],
      'the head is still the head; an outage in between does not excuse it');
  });

  test('it is READ-ONLY: one statement, and nothing that writes', async () => {
    const db = stubDb([[row()]]);
    await new OverduePendingProbe(db, recordingLogger()).scan(drained);

    assert.equal(db.sql.length, 1);
    const sql = db.sql[0] ?? '';
    for (const forbidden of [
      'UPDATE', 'INSERT', 'DELETE', 'claim_tasks', 'complete_task',
      'cancel_task', 'enqueue_task', 'record_task_alerts', 'FOR UPDATE',
    ]) {
      assert.ok(!sql.includes(forbidden), `the probe issued ${forbidden}`);
    }
  });

  test('the query never selects the payload', async () => {
    const db = stubDb([[row()]]);
    await new OverduePendingProbe(db, recordingLogger()).scan(drained);
    assert.ok(!/\bpayload\b/.test(db.sql[0] ?? ''));
  });

  test('it asks exactly the question claim_tasks asks', async () => {
    // If these drift, the probe starts reporting work the claimer would not
    // have taken, or missing work it would.
    const db = stubDb([[row()]]);
    await new OverduePendingProbe(db, recordingLogger()).scan(drained);
    const sql = (db.sql[0] ?? '').replace(/\s+/g, ' ');
    assert.ok(sql.includes("t.run_at <= now()"));
    assert.ok(sql.includes("t.state = 'pending'"));
    assert.ok(sql.includes("t.state = 'claimed' AND t.claimed_until < now()"));
  });

  test('no log line carries a payload, alert id, phone, location or token', async () => {
    const logger = recordingLogger();
    const probe = new OverduePendingProbe(stubDb([[row({ head_id: '12' })]]), logger);
    await probe.scan(drained);
    await probe.scan(drained);

    const dump = JSON.stringify(logger.lines);
    for (const forbidden of [
      'alertId', 'payload', 'phone', 'latitude', 'longitude', 'secret',
      'token', 'contact', 'audio', 'keyword', 'lastError', 'last_error',
    ]) {
      assert.ok(!dump.includes(forbidden), `a log line mentioned ${forbidden}`);
    }
  });

  test('the kind bound is clamped and reported', async () => {
    const many = ['a', 'b', 'c'].map((k) => row({ kind: k }));
    const logger = recordingLogger();
    const result = await new OverduePendingProbe(stubDb([many]), logger, { kindLimit: 2 }).scan(drained);
    assert.equal(result.kinds.length, 2);
    assert.equal(result.truncated, true);

    const clamped = await new OverduePendingProbe(stubDb([many]), recordingLogger(), { kindLimit: 0 }).scan(drained);
    assert.equal(clamped.kinds.length, 1, 'clamped to at least one');
  });
});

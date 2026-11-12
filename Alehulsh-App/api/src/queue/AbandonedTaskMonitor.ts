/**
 * Makes abandoned tasks observable.  (P2-17)
 *
 * An `abandoned` task is work the system accepted, retried to exhaustion and
 * gave up on. For every kind this queue carries that has a victim: an
 * abandoned `safety-check` is a woman who was never escalated, an abandoned
 * `notify-contacts` is contacts who were never told, an abandoned `expiry` is
 * an alert left non-terminal past its window.
 *
 * WHY A SCAN AND NOT A HOOK. A task reaches `abandoned` by TWO paths:
 * `complete_task` when a reported failure exhausts its attempts, and the
 * `claim_tasks` lease sweep (0010) when the worker DIED before reporting. The
 * second is performed by a different worker's next claim, so an in-process
 * hook on "the task I just failed" would miss exactly the failure mode where
 * the handler is killing its worker. Both paths set `state = 'abandoned'`, so
 * a scan over terminal state covers both - and gets restart recovery for free,
 * because it never depended on having witnessed the transition.
 *
 * NOTHING IS SENT. No notification, SMS, email, push or outbound request
 * exists in this path. A log line and a database row are not an alert, and
 * this class must not be read as one. Connecting a real destination still
 * needs three things it does not have: a destination and an owner; a DELIVERY
 * state distinct from `noticed_at`, which means noticed and nothing more; and
 * the sending done out of this process, so a provider outage cannot sit on the
 * path of the thing that runs safety checks.
 *
 * IT CANNOT BREAK WHAT IT WATCHES. One SELECT on task_queue, one INSERT into
 * task_alert_log, and nothing else: it never claims, completes, cancels or
 * writes a task. `scan()` never throws, because a monitor able to propagate an
 * exception into the worker loop is a monitor that can stop safety checks from
 * running.
 */
import type { Queryable } from '../db/pool.js';
import type { Logger } from '../logger.js';

/**
 * A CLOSED vocabulary for why a task was dropped.
 *
 * `task_queue.last_error` is whatever `err.message` happened to be - a URL, a
 * response fragment, a library exception. It is read, classified and
 * DISCARDED: never logged, never stored. The database enforces this with a
 * CHECK over these exact values (migration 0011), so a bug that tried to put a
 * raw message in its place is refused rather than quietly persisted.
 */
export type TaskErrorClass =
  | 'none'
  | 'no_handler'
  | 'missing_alert_id'
  | 'route_rejected'
  | 'timeout'
  | 'unreachable'
  | 'lease_expired'
  | 'unclassified';

export type AlertSeverity = 'safety' | 'background';

/** Every kind this queue currently carries. All are safety or privacy relevant. */
export const SAFETY_CRITICAL_KINDS: ReadonlySet<string> = new Set([
  'safety-check',
  'expiry',
  'notify-contacts',
  'retract-inbox',
]);

/**
 * Kinds explicitly downgraded to ordinary background work. EMPTY TODAY.
 *
 * The default is deliberately the other way round: a kind in neither list is
 * treated as SAFETY-CRITICAL. The inverse default - safety only for a known
 * list - silently downgrades a safety kind somebody forgot to register, and on
 * this platform that trade is the wrong way round. An unrecognised kind is
 * reported at error with `kindRegistered: false`, which says both that work
 * was dropped and that the monitor does not know how to rate it.
 *
 * The consequence, stated rather than hidden: today EVERY abandoned task
 * produces a safety-severity signal.
 */
export const NON_SAFETY_KINDS: ReadonlySet<string> = new Set<string>();

/** The CHECK in 0011 caps this; the writer truncates so the cap never fires. */
const MAX_KIND_LENGTH = 64;

/**
 * Classify a raw error message into the closed vocabulary.
 *
 * Pure, so it is testable without a database, and so the one place that
 * touches an untrusted string is one place.
 */
export function classifyTaskError(raw: string | null | undefined): TaskErrorClass {
  if (raw === null || raw === undefined || raw.trim() === '') return 'none';

  // The sweep's sentinel: the worker died rather than reporting a failure.
  if (raw === 'lease expired with attempts exhausted') return 'lease_expired';

  // TaskWorker / httpTaskDispatcher produce these three exactly.
  if (/^no handler registered for task kind /.test(raw)) return 'no_handler';
  if (/ carries no alertId$/.test(raw)) return 'missing_alert_id';
  if (/^task route returned \d{3}$/.test(raw)) return 'route_rejected';

  // Anything from fetch/undici. Matched loosely because these messages are
  // not ours and change between Node versions.
  if (/abort|timeout|ETIMEDOUT/i.test(raw)) return 'timeout';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(raw)) {
    return 'unreachable';
  }

  // Deliberately uninformative. An operator must go and look at the row - we
  // will not guess, and we will not copy the message out to make guessing
  // easier.
  return 'unclassified';
}

/**
 * The HTTP status, when the message is exactly the dispatcher's own.
 *
 * Three digits cannot leak anything, and the difference between 401 (the
 * secret is wrong) and 500 (the handler is broken) is the first thing an
 * operator needs. Logged only; the ledger has no column for it.
 */
export function extractHttpStatus(raw: string | null | undefined): number | null {
  const m = /^task route returned (\d{3})$/.exec(raw ?? '');
  return m?.[1] === undefined ? null : Number(m[1]);
}

export function severityForKind(
  kind: string,
  nonSafetyKinds: ReadonlySet<string> = NON_SAFETY_KINDS,
): AlertSeverity {
  return nonSafetyKinds.has(kind) ? 'background' : 'safety';
}

export function isRegisteredKind(
  kind: string,
  nonSafetyKinds: ReadonlySet<string> = NON_SAFETY_KINDS,
): boolean {
  return SAFETY_CRITICAL_KINDS.has(kind) || nonSafetyKinds.has(kind);
}

/** What is reported about one abandoned task. No payload, no alert id. */
export interface AbandonedTaskSignal {
  taskId: string;
  kind: string;
  attempts: number;
  maxAttempts: number;
  abandonedAt: Date;
  errorClass: TaskErrorClass;
  severity: AlertSeverity;
  /** false when the rating was defaulted rather than decided. */
  kindRegistered: boolean;
  httpStatus: number | null;
}

export interface MonitorScanResult {
  /** Unreported abandoned tasks this scan found, bounded by the batch size. */
  candidates: number;
  /** Announced by THIS scan. The ledger insert decided these. */
  reported: number;
  /** Found, but not ours: already in the ledger, or no longer abandoned. */
  suppressed: number;
  safety: number;
  background: number;
  /** The batch was full, so more may be waiting. */
  truncated: boolean;
  /** The scan could not run. Nothing was reported and nothing was lost. */
  failed: boolean;
}

export interface MonitorStats {
  scans: number;
  reported: number;
  failures: number;
  /** Reset by any scan that completes. */
  consecutiveFailures: number;
  lastScanAt: Date | null;
  lastFailureAt: Date | null;
}

interface CandidateRow {
  id: string;
  kind: string;
  attempts: number;
  max_attempts: number;
  abandoned_at: Date;
  last_error: string | null;
}

/**
 * Abandoned tasks not yet in the ledger, oldest first.
 *
 * Bounded: on a first run against a backlog this must not pull the whole table
 * into one log burst. `truncated` tells the caller more may remain, and the
 * next scan continues - `ORDER BY id` makes progress monotonic.
 *
 * COALESCE on completed_at is defensive only. `task_terminal_has_time`
 * guarantees an abandoned row has it; the fallback exists so an
 * (impossible) NULL cannot make the ledger insert fail forever on the same
 * row, which would be a permanent, self-inflicted monitoring outage.
 */
const CANDIDATE_SQL = `
  SELECT t.id, t.kind, t.attempts, t.max_attempts,
         COALESCE(t.completed_at, t.created_at) AS abandoned_at,
         t.last_error
    FROM task_queue t
   WHERE t.state = 'abandoned'
     AND NOT EXISTS (SELECT 1 FROM task_alert_log l WHERE l.task_id = t.id)
   ORDER BY t.id
   LIMIT $1`;

const RECORD_SQL = `
  SELECT record_task_alerts(
           $1::bigint[], $2::text[], $3::int[], $4::int[],
           $5::timestamptz[], $6::text[], $7::text[], $8::boolean[])`;

const DEFAULT_BATCH_SIZE = 100;

export interface AbandonedTaskMonitorOptions {
  batchSize?: number;
  /**
   * Overrides NON_SAFETY_KINDS. Exists so a test can prove the safety /
   * background distinction works while the production set is empty.
   */
  nonSafetyKinds?: ReadonlySet<string>;
}

export class AbandonedTaskMonitor {
  private readonly batchSize: number;
  private readonly nonSafetyKinds: ReadonlySet<string>;

  readonly stats: MonitorStats = {
    scans: 0, reported: 0, failures: 0, consecutiveFailures: 0,
    lastScanAt: null, lastFailureAt: null,
  };

  constructor(
    private readonly db: Queryable,
    private readonly logger: Logger,
    options: AbandonedTaskMonitorOptions = {},
  ) {
    this.batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE));
    this.nonSafetyKinds = options.nonSafetyKinds ?? NON_SAFETY_KINDS;
  }

  /**
   * One scan. NEVER THROWS.
   *
   * Find, record, then announce - in that order. The ledger insert is the gate
   * rather than the select: `task_alert_log.task_id` is the primary key, so
   * two monitors that both see a row both attempt the insert and exactly one
   * gets it back. Only that one logs. Deduplication is therefore a database
   * property that holds across repeated polling, across restarts, and across
   * concurrent workers by the same single mechanism.
   *
   * Recording before announcing, not after: the row is the durable fact. The
   * opposite order would announce work it might then fail to record, and
   * announce it again on the next scan.
   */
  async scan(): Promise<MonitorScanResult> {
    const blank: MonitorScanResult = {
      candidates: 0, reported: 0, suppressed: 0,
      safety: 0, background: 0, truncated: false, failed: false,
    };

    let signals: AbandonedTaskSignal[];
    let announced: Set<string>;
    try {
      const { rows } = await this.db.query<CandidateRow>(CANDIDATE_SQL, [this.batchSize]);
      signals = rows.map((r) => this.toSignal(r));
      announced = signals.length === 0 ? new Set() : await this.record(signals);
    } catch (err: unknown) {
      this.stats.failures += 1;
      this.stats.consecutiveFailures += 1;
      this.stats.lastFailureAt = new Date();
      // Loud every time, not only the first: an operator needs to see it
      // CONTINUING to fail. Time-gated by the caller, so this cannot spin.
      this.logger.error(
        'abandoned-task scan FAILED — dropped safety work is currently unobserved',
        {
          consecutiveFailures: this.stats.consecutiveFailures,
          detail: err instanceof Error ? err.message : String(err),
        },
      );
      return { ...blank, failed: true };
    }

    this.stats.scans += 1;
    this.stats.consecutiveFailures = 0;
    this.stats.lastScanAt = new Date();

    const result: MonitorScanResult = {
      ...blank,
      candidates: signals.length,
      truncated: signals.length >= this.batchSize,
    };

    for (const signal of signals) {
      if (!announced.has(signal.taskId)) {
        // Already in the ledger, or no longer abandoned. Either way it is not
        // ours to announce.
        result.suppressed += 1;
        continue;
      }
      result.reported += 1;
      result[signal.severity] += 1;
      this.emit(signal);
    }
    this.stats.reported += result.reported;

    // The liveness signal. Emitted on EVERY completed scan, including an empty
    // one: absence of this line for more than two intervals means the monitor
    // is not running, which is checkable without trusting the monitor to
    // report its own death. Logging only on findings makes a healthy monitor
    // and a dead one look identical.
    this.logger.info('abandoned-task scan', { ...result, scans: this.stats.scans });
    return result;
  }

  private toSignal(row: CandidateRow): AbandonedTaskSignal {
    // Truncated so the ledger's CHECK cannot reject the row and make this task
    // a permanent scan failure. 'unknown' matches PostgresTaskQueue.kindOf,
    // which already records an absent payload kind that way.
    const kind = row.kind.slice(0, MAX_KIND_LENGTH) || 'unknown';
    return {
      taskId: String(row.id),
      kind,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      abandonedAt: row.abandoned_at,
      errorClass: classifyTaskError(row.last_error),
      severity: severityForKind(kind, this.nonSafetyKinds),
      kindRegistered: isRegisteredKind(kind, this.nonSafetyKinds),
      httpStatus: extractHttpStatus(row.last_error),
    };
  }

  /** @returns the ids this process may announce. */
  private async record(signals: AbandonedTaskSignal[]): Promise<Set<string>> {
    const { rows } = await this.db.query<{ record_task_alerts: string }>(RECORD_SQL, [
      signals.map((s) => s.taskId),
      signals.map((s) => s.kind),
      signals.map((s) => s.attempts),
      signals.map((s) => s.maxAttempts),
      signals.map((s) => s.abandonedAt),
      signals.map((s) => s.errorClass),
      signals.map((s) => s.severity),
      signals.map((s) => s.kindRegistered),
    ]);
    return new Set(rows.map((r) => String(r.record_task_alerts)));
  }

  /**
   * One structured line per newly recorded task.
   *
   * Deliberately thin, and the same discipline as TaskWorker: ids, kind,
   * attempt counts, a classification. NO PAYLOAD, no alert id, no error text.
   * The payload is never even fetched by the candidate query.
   */
  private emit(signal: AbandonedTaskSignal): void {
    const ctx: Record<string, unknown> = {
      taskId: signal.taskId,
      kind: signal.kind,
      attempts: signal.attempts,
      maxAttempts: signal.maxAttempts,
      abandonedAt: signal.abandonedAt.toISOString(),
      errorClass: signal.errorClass,
      severity: signal.severity,
      kindRegistered: signal.kindRegistered,
    };
    if (signal.httpStatus !== null) ctx['httpStatus'] = signal.httpStatus;

    if (signal.severity === 'safety') {
      this.logger.error(
        'ABANDONED safety-critical task — work that should have protected someone did not run',
        ctx,
      );
    } else {
      this.logger.warn('abandoned background task', ctx);
    }
  }
}

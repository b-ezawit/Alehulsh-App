/**
 * Detects claimable work that is not being claimed.  (P2-17b, read-only)
 *
 * The gap this fills. AbandonedTaskMonitor watches work the queue GAVE UP on.
 * A worse failure never reaches that state at all: a task sits `pending`, its
 * `run_at` passes, and nothing claims it. Nothing is retried, nothing is
 * abandoned, nothing is logged, and from the request's point of view the
 * schedule succeeded. A safety check that is never claimed is a woman who is
 * never escalated - and the queue looks healthy throughout.
 *
 * WHAT "OVERDUE" MEANS HERE, and why it needs no threshold. The predicate is
 * not "older than N seconds". It is the EXACT predicate `claim_tasks` uses
 * (0010):
 *
 *     run_at <= now() AND (state = 'pending'
 *                          OR (state = 'claimed' AND claimed_until < now()))
 *
 * So this asks the database the same question the claimer asks: what is
 * claimable right now? No timing policy is invented, because none is needed to
 * ask it. Being claimable for a millisecond is normal; the signal is that the
 * set is NOT DRAINING, which is established by observation below.
 *
 * NO THRESHOLD IS CHOSEN, and that is deliberate - it has not been approved.
 * What this produces instead is the measurement a threshold would have to be
 * chosen FROM: the age of the oldest claimable task, per kind, over time.
 *
 * WHAT IT CANNOT SEE. It runs inside the worker process, so it cannot detect
 * the worst case - NO WORKER RUNNING AT ALL. Nothing scans when nothing runs.
 * That case needs a check OUTSIDE this process: the predicate below run from
 * somewhere else, or an alarm on the absence of the line this emits every
 * scan. An external check needs none of this code - the query is plain SQL
 * over task_queue.
 *
 * READ-ONLY. One SELECT. It issues no UPDATE, INSERT or DELETE, calls no queue
 * function, writes no ledger row, and sends nothing anywhere.
 */
import type { Queryable } from '../db/pool.js';
import type { Logger } from '../logger.js';

/**
 * The claim predicate, verbatim from claim_tasks.
 *
 * Covered by the EXISTING `task_queue_due_idx` partial index
 * (`(run_at) WHERE state IN ('pending','claimed')`), so this needs no
 * migration. Measured: Index Scan returning 12 rows from 20,012 pending, not a
 * sequential scan.
 *
 * The payload is deliberately NOT selected. Counts, ages, kinds and opaque row
 * ids are all an operator needs to decide whether to go and look.
 */
const CLAIMABLE_SQL = `
  SELECT t.kind,
         count(*) FILTER (WHERE t.state = 'pending')::int AS due_count,
         count(*) FILTER (WHERE t.state = 'claimed')::int AS reclaimable_count,
         count(*) FILTER (WHERE t.state = 'pending' AND t.attempts > 0)::int AS retrying,
         COALESCE(max(extract(epoch from (now() - t.run_at)) * 1000)
                  FILTER (WHERE t.state = 'pending'), 0)::bigint AS oldest_due_ms,
         (array_agg(t.id ORDER BY t.run_at)
          FILTER (WHERE t.state = 'pending'))[1] AS head_id
    FROM task_queue t
   WHERE t.run_at <= now()
     AND (t.state = 'pending'
          OR (t.state = 'claimed' AND t.claimed_until < now()))
   GROUP BY t.kind
   ORDER BY t.kind
   LIMIT $1`;

interface ClaimableRow {
  kind: string;
  due_count: number;
  reclaimable_count: number;
  retrying: number;
  oldest_due_ms: string;
  head_id: string | null;
}

export interface OverdueKind {
  kind: string;
  /** `pending` and due: the claimer should be taking these now. */
  dueCount: number;
  /**
   * `claimed` with an expired lease. Also claimable, and a separate stall
   * class: a worker that died mid-dispatch leaves these, and if no worker ever
   * returns they are never reclaimed and never abandoned either, because the
   * 0010 sweep only runs inside a claim.
   */
  reclaimableCount: number;
  /** Of the due ones, how many are on a retry rather than a first attempt. */
  retrying: number;
  /** Age of the oldest due task. A MEASUREMENT, compared against nothing. */
  oldestDueMs: number;
  /** The row `claim_tasks` must take next for this kind - it orders by run_at. */
  headTaskId: string | null;
}

export interface OverdueScanResult {
  dueTotal: number;
  reclaimableTotal: number;
  /** Across all kinds. */
  oldestDueMs: number;
  kinds: OverdueKind[];
  /** More kinds than the bound; impossible today with three, kept honest. */
  truncated: boolean;
  /**
   * The pass that just ran claimed fewer tasks than it asked for.
   *
   * This is what separates a STALL from a BACKLOG. A full batch means the
   * worker is draining as fast as it was told it may; spare capacity means it
   * asked for work, had room, and this task was claimable and still not taken.
   */
  spareCapacity: boolean;
  /**
   * Kinds whose head row is the SAME row it was at the previous scan.
   *
   * The observational confirmation, in place of a clock. The probe runs only
   * after a pass that reached the database, and scans are intervals apart, so
   * many claim attempts happen in between. A head that has not moved across
   * two scans has survived all of them.
   */
  persisting: string[];
  failed: boolean;
}

export interface OverdueProbeStats {
  scans: number;
  failures: number;
  consecutiveFailures: number;
  lastScanAt: Date | null;
}

/** What the pass that just ran managed to claim. */
export interface ClaimContext {
  claimed: number;
  /** The worker's batch size: the most it was willing to take. */
  capacity: number;
}

const DEFAULT_KIND_LIMIT = 32;

export class OverduePendingProbe {
  private readonly kindLimit: number;
  /** kind -> head row id at the previous scan. */
  private previousHeads = new Map<string, string>();

  readonly stats: OverdueProbeStats = {
    scans: 0, failures: 0, consecutiveFailures: 0, lastScanAt: null,
  };

  constructor(
    private readonly db: Queryable,
    private readonly logger: Logger,
    options: { kindLimit?: number } = {},
  ) {
    this.kindLimit = Math.max(1, Math.trunc(options.kindLimit ?? DEFAULT_KIND_LIMIT));
  }

  /**
   * One read-only scan. NEVER THROWS, for the same reason the abandoned-task
   * monitor does not: a diagnostic that can propagate an exception into the
   * worker loop is a diagnostic that can stop safety checks from running.
   */
  async scan(context: ClaimContext): Promise<OverdueScanResult> {
    const blank: OverdueScanResult = {
      dueTotal: 0, reclaimableTotal: 0, oldestDueMs: 0, kinds: [],
      truncated: false, spareCapacity: false, persisting: [], failed: false,
    };

    let rows: ClaimableRow[];
    try {
      ({ rows } = await this.db.query<ClaimableRow>(CLAIMABLE_SQL, [this.kindLimit]));
    } catch (err: unknown) {
      this.stats.failures += 1;
      this.stats.consecutiveFailures += 1;
      // Loud every time. Time-gated by the caller, so it cannot spin.
      this.logger.error(
        'overdue-pending probe FAILED — a stalled queue would currently be invisible',
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

    const kinds: OverdueKind[] = rows.map((r) => ({
      kind: r.kind,
      dueCount: Number(r.due_count),
      reclaimableCount: Number(r.reclaimable_count),
      retrying: Number(r.retrying),
      oldestDueMs: Number(r.oldest_due_ms),
      headTaskId: r.head_id === null ? null : String(r.head_id),
    }));

    const heads = new Map<string, string>();
    const persisting: string[] = [];
    for (const k of kinds) {
      if (k.headTaskId === null) continue;
      heads.set(k.kind, k.headTaskId);
      if (this.previousHeads.get(k.kind) === k.headTaskId) persisting.push(k.kind);
    }
    this.previousHeads = heads;

    const result: OverdueScanResult = {
      dueTotal: kinds.reduce((n, k) => n + k.dueCount, 0),
      reclaimableTotal: kinds.reduce((n, k) => n + k.reclaimableCount, 0),
      oldestDueMs: kinds.reduce((n, k) => Math.max(n, k.oldestDueMs), 0),
      kinds,
      truncated: rows.length >= this.kindLimit,
      spareCapacity: context.claimed < context.capacity,
      persisting,
      failed: false,
    };

    this.emit(result);
    return result;
  }

  /**
   * Facts at info; the not-draining condition at warn.
   *
   * NOTHING IS LOGGED AT ERROR, deliberately. Calling a busy-but-working queue
   * an error is how a channel gets ignored, and telling the two apart needs the
   * threshold decision that has not been made. The facts needed to make it are
   * in every line.
   */
  private emit(r: OverdueScanResult): void {
    const ctx: Record<string, unknown> = {
      dueTotal: r.dueTotal,
      reclaimableTotal: r.reclaimableTotal,
      oldestDueMs: r.oldestDueMs,
      spareCapacity: r.spareCapacity,
      scans: this.stats.scans,
      byKind: r.kinds.map((k) => ({
        kind: k.kind, due: k.dueCount, reclaimable: k.reclaimableCount,
        retrying: k.retrying, oldestDueMs: k.oldestDueMs, headTaskId: k.headTaskId,
      })),
      ...(r.truncated ? { truncated: true } : {}),
    };

    if (r.persisting.length === 0) {
      // Including the empty case: this line is the liveness signal, so its
      // ABSENCE is what tells an operator the probe is not running.
      this.logger.info('overdue-pending probe', ctx);
      return;
    }

    // The head of the queue has not moved since the previous scan, across
    // every claim attempt in between. Which of the two messages it is says
    // whether the queue is stalled or merely behind.
    this.logger.warn(
      r.spareCapacity
        ? 'claimable work is NOT DRAINING although the worker had spare capacity'
        : 'claimable work is not draining; every claim batch was full (a backlog, not a stall)',
      { ...ctx, persistingKinds: r.persisting },
    );
  }
}

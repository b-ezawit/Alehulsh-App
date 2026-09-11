/**
 * Swap point #2 of 3. See docs/api-layer.md.
 *
 * Firestore now; PostgreSQL + PostGIS after C-04 (M-05). Handlers depend on
 * these interfaces only, so the migration replaces implementations and leaves
 * the alert state machine, keyword verification and escalation untouched.
 *
 * Shapes follow docs/alert-lifecycle.md.
 */

export type AlertStatus = 'active' | 'resolved' | 'escalated' | 'expired';

export interface Alert {
  id: string;
  ownerId: string;
  status: AlertStatus;
  createdAt: Date;
  /** Server-stamped. Never the device clock — see alert-lifecycle.md §3. */
  expiresAt: Date;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;
  resolvedAt?: Date;
  resolvedBy?: 'owner' | 'owner_late';
  escalatedAt?: Date;
  escalationReason?: 'wrong_keyword' | 'no_answer' | 'attempts_exhausted';
}

export interface AlertRepository {
  findById(id: string): Promise<Alert | null>;
  findActiveByOwner(ownerId: string): Promise<Alert | null>;
  /**
   * Idempotent — alert-lifecycle.md §7. `created` is false when an alert was
   * already live, so the caller knows not to reschedule the safety check.
   * Re-triggering must not let someone postpone escalation indefinitely.
   */
  create(input: {
    requestId: string;
    ownerId: string;
    latitude: number | null;
    longitude: number | null;
  }): Promise<{ alert: Alert; created: boolean }>;
  updateStatus(id: string, next: AlertStatus, fields: Partial<Alert>): Promise<Alert>;
}

export interface UserRecord {
  uid: string;
  /** Hash only. The plaintext keyword never enters this process — CRIT-05. */
  safetyKeywordHash: string | null;
}

export interface UserRepository {
  findByUid(uid: string): Promise<UserRecord | null>;
}

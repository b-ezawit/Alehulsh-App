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
  /** Failed keyword attempts. A cluster of these is itself evidence. */
  attemptCount: number;
  lastAttemptAt?: Date;
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
  /** Records a failed keyword attempt. Never resets. */
  recordFailedAttempt(id: string, at: Date): Promise<Alert>;
}

export interface UserRecord {
  uid: string;
  /** Hash only. The plaintext keyword never enters this process — CRIT-05. */
  safetyKeywordHash: string | null;
  /**
   * True for users migrated off the shipped default, or who never had one.
   * They cannot resolve until they set a real keyword — see P1-11.
   */
  mustSetKeyword: boolean;
}

export interface UserRepository {
  findByUid(uid: string): Promise<UserRecord | null>;
  /**
   * Resolves a hashed phone or email to an account, so the fan-out can reach a
   * contact who has the app without ever handling her raw number (P2-09).
   * Returns null when the contact is not a user — which at launch is most of
   * them, and is exactly what P3-01 §5 has to answer for.
   */
  findUidByIdentifierHash(hash: string): Promise<string | null>;
}

/**
 * One row per contact, not an array element. P2-01 §4: only rows can be
 * individually deleted (C-16), carry consent state (P2-23), and answer
 * "can we reach this person?" (P3-02).
 */
export interface EmergencyContact {
  id: string;
  ownerUid: string;
  /** Raw values are shown back to her; they never leave the server otherwise. */
  name: string;
  phoneHash: string | null;
  emailHash: string | null;
  isPrimary: boolean;
}

export interface ContactRepository {
  listByOwner(ownerUid: string): Promise<EmergencyContact[]>;
}

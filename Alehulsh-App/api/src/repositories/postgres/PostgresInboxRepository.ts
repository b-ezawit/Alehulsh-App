import type { Queryable } from '../../db/pool.js';
import type {VerifiedIdentifierSource} from '../../auth/VerifiedIdentifierSource.js';
import {contactProjectionProven} from '../../services/contactProjectionProof.js';
import type { AlertProjection, InboxRepository } from '../types.js';

/**
 * InboxRepository on PostgreSQL.  (M-05)
 *
 * The read side of the fan-out, which `GET /v1/me/inbox` serves. One row per
 * (recipient, alert), with the audience-tiered projection as `jsonb`.
 *
 * WHY THE PROJECTION IS A jsonb BLOB rather than columns: it is a SNAPSHOT of
 * what this recipient was told, at the moment she was told it. Normalising it
 * would make it a live view of the alert, and a responder must see the position
 * as it was reported - not silently re-resolved later. `docs/responder-
 * projection.md` §2: never the alert itself.
 *
 * IDENTITY. Recipients are external subjects at the boundary and internal
 * uuids in the table, translated through `identity_map` in SQL. Same rule as
 * every other Postgres repository: the uuid never crosses this line.
 *
 * ISOLATION. `inbox` has RLS enabled AND forced (0002), with the client role
 * granted SELECT only under a policy scoped to its own `recipient_id` - so even
 * if a client ever reached the database directly it could not read another
 * woman's inbox. This repository runs as `alehulsh_api` and scopes by argument,
 * which is the same guarantee one layer up.
 */

function couldBeSubject(subject: string): boolean {
  return subject.length > 0 && !subject.includes('\u0000');
}

/**
 * Could this be an `alerts.id`? It is a `uuid` column, and comparing a
 * non-uuid raises SQLSTATE 22P02 instead of matching nothing - which would
 * turn "no such alert" into a 500. Mirrors PostgresAlertRepository's guard
 * rather than being stricter: the column accepts uppercase, braces and
 * arbitrary hyphen placement, so a canonical-only regex would reject ids that
 * match real rows.
 */
function looksLikeAlertId(id: string): boolean {
  if (id.length === 0 || id.length > 64) return false;
  const bare = id.startsWith('{') && id.endsWith('}') ? id.slice(1, -1) : id;
  return /^[0-9a-fA-F]{32}$/.test(bare.replace(/-/g, ''));
}

/** The stored snapshot. `createdAt` is an ISO string inside jsonb. */
interface StoredProjection {
  contactIdentifierHashes?:string[];
  alertId: string;
  alertKey?: string;
  displayName: string;
  fuzzedLat: number | null;
  fuzzedLng: number | null;
  fuzzedPrecision: string;
  isUrgent: boolean;
  status: 'active' | 'escalated';
  createdAt: string;
  hasVoiceNote: boolean;
  reportedDelayMs: number | null;
  audience: 'responder' | 'contact';
}

function toProjection(stored: StoredProjection, audience: string): AlertProjection {
  return {
    ...(stored.contactIdentifierHashes?{contactIdentifierHashes:stored.contactIdentifierHashes}:{}),
    alertId: stored.alertId,
    ...(stored.alertKey ? { alertKey: stored.alertKey } : {}),
    displayName: stored.displayName ?? '',
    fuzzedLat: stored.fuzzedLat ?? null,
    fuzzedLng: stored.fuzzedLng ?? null,
    fuzzedPrecision: stored.fuzzedPrecision,
    isUrgent: stored.isUrgent === true,
    status: stored.status,
    createdAt: new Date(stored.createdAt),
    hasVoiceNote: stored.hasVoiceNote === true,
    reportedDelayMs: stored.reportedDelayMs ?? null,
    // The COLUMN wins over the blob. `audience` is a real column with an enum
    // type and it is what RLS and the authorization checks read, so a blob that
    // disagreed with it must not be able to upgrade a responder to a contact.
    audience: audience === 'contact' ? 'contact' : 'responder',
  };
}

export class PostgresInboxRepository implements InboxRepository {
  constructor(private readonly db: Queryable,private readonly identifiers?:VerifiedIdentifierSource) {}
  private async stillLive(ids:string[]):Promise<Set<string>>{
    if(!ids.length)return new Set();
    const {rows}=await this.db.query<{id:string}>("SELECT id::text FROM alerts WHERE id=ANY($1::uuid[]) AND status IN ('active','escalated') AND expires_at>clock_timestamp()",[ids]);
    return new Set(rows.map(r=>r.id));
  }

  /**
   * Idempotent on (recipient, alert), as the interface requires.
   *
   * ON CONFLICT DO UPDATE, not DO NOTHING: re-running the fan-out must REFRESH
   * the snapshot - an alert that escalated between two runs should show as
   * escalated - while never producing a second row. `created_at` is left alone
   * so the ordering `GET /v1/me/inbox` depends on does not jump when a
   * projection is refreshed.
   *
   * Silently writes nothing when either side is unmapped. That is deliberate
   * and matches the fan-out's own contract: a contact without an account is
   * not an error (`P3-01` §5 - at launch most are not users), and the fan-out
   * already reports unreachable contacts separately. A live alert row is
   * locked before writing; migration 0013 uses the same lock when a terminal
   * transition retracts projections, so late fan-out cannot restore them.
   */
  async put(recipientUid: string, projection: AlertProjection): Promise<void> {
    if (!couldBeSubject(recipientUid)) return;
    if (!looksLikeAlertId(projection.alertId)) return;
    if (projection.alertKey !== undefined && projection.alertKey !== projection.alertId) return;

    await this.db.query(
      `WITH live AS MATERIALIZED (
         SELECT id FROM alerts
          WHERE id = $2::uuid AND status IN ('active','escalated') AND expires_at > clock_timestamp()
          FOR UPDATE
       )
       INSERT INTO inbox (recipient_id, alert_id, audience, projection)
       SELECT m.user_id, $2::uuid, $3::audience_kind, $4::jsonb
         FROM identity_map m
         JOIN live ON live.id = $2::uuid
        WHERE m.firebase_uid = $1
       ON CONFLICT (recipient_id, alert_id) DO UPDATE
          SET audience = EXCLUDED.audience,
              projection = EXCLUDED.projection`,
      [
        recipientUid,
        projection.alertId,
        projection.audience,
        JSON.stringify({ ...projection, createdAt: projection.createdAt.toISOString() }),
      ],
    );
  }

  async remove(recipientUid: string, alertId: string, alertKey?: string): Promise<void> {
    if (!couldBeSubject(recipientUid) || !looksLikeAlertId(alertId)) return;
    if (alertKey !== undefined && alertKey !== alertId) return;

    await this.db.query(
      `DELETE FROM inbox
        WHERE alert_id = $2::uuid
          AND recipient_id = (SELECT m.user_id FROM identity_map m
                               WHERE m.firebase_uid = $1)`,
      [recipientUid, alertId],
    );
  }

  /**
   * The authorization surface for accept (P1-10): a projection exists only
   * where the server chose to write one, so "do you hold one?" answers "were
   * you selected?" without trusting the caller.
   */
  async get(recipientUid: string, alertId: string): Promise<AlertProjection | null> {
    if (!couldBeSubject(recipientUid) || !looksLikeAlertId(alertId)) return null;

    const { rows } = await this.db.query<{ projection: StoredProjection; audience: string; expires_at: Date }>(
      `SELECT i.projection, i.audience::text AS audience, a.expires_at
         FROM inbox i
         JOIN identity_map m ON m.user_id = i.recipient_id
         JOIN alerts a ON a.id = i.alert_id
        WHERE m.firebase_uid = $1 AND i.alert_id = $2::uuid
          AND a.status IN ('active','escalated') AND a.expires_at > clock_timestamp()`,
      [recipientUid, alertId],
    );
    const row = rows[0];
    if(!row)return null;
    const projection={...toProjection(row.projection,row.audience),expiresAt:row.expires_at};
    if(!await contactProjectionProven(this.identifiers,recipientUid,projection))return null;
    return !this.identifiers||(await this.stillLive([alertId])).has(alertId)?projection:null;
  }

  /** Server-only, for retracting an alert when it ends. */
  async listRecipients(alertId: string): Promise<string[]> {
    if (!looksLikeAlertId(alertId)) return [];

    const { rows } = await this.db.query<{ firebase_uid: string }>(
      `SELECT m.firebase_uid
         FROM inbox i
         JOIN identity_map m ON m.user_id = i.recipient_id
        WHERE i.alert_id = $1::uuid
        ORDER BY m.firebase_uid`,
      [alertId],
    );
    return rows.map((r) => r.firebase_uid);
  }

  /**
   * One recipient's own inbox, newest first, bounded.
   *
   * Scoped by argument rather than by a filter the caller supplies, so there is
   * no query shape this method can express that returns somebody else's rows.
   *
   * Unlike the Firestore implementation, the order here is TOTAL:
   * `(created_at DESC, alert_id DESC)` breaks ties deterministically, so this
   * backend could support a stable cursor. The interface does not expose one
   * yet because Firestore cannot make the same guarantee, and a contract that
   * holds on only one backend is worse than none.
   */
  async listForRecipient(recipientUid: string, limit: number): Promise<AlertProjection[]> {
    if (!couldBeSubject(recipientUid)) return [];

    const { rows } = await this.db.query<{ projection: StoredProjection; audience: string; expires_at: Date }>(
      `SELECT i.projection, i.audience::text AS audience, a.expires_at
         FROM inbox i
         JOIN identity_map m ON m.user_id = i.recipient_id
         JOIN alerts a ON a.id = i.alert_id
        WHERE m.firebase_uid = $1
          AND a.status IN ('active','escalated') AND a.expires_at > clock_timestamp()
        ORDER BY i.created_at DESC, i.alert_id DESC
        LIMIT $2`,
      [recipientUid, Math.max(1, Math.trunc(limit))],
    );
    const projections=rows.map((r) => ({ ...toProjection(r.projection, r.audience), expiresAt: r.expires_at }));
    if(!this.identifiers)return projections;
    const valid=await Promise.all(projections.map(async p=>await contactProjectionProven(this.identifiers,recipientUid,p)?p:null));
    const selected=valid.filter((p):p is NonNullable<typeof p>=>p!==null),live=await this.stillLive(selected.map(p=>p.alertId));
    return selected.filter(p=>live.has(p.alertId));
  }
}

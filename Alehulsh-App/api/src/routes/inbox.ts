import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import type { AlertProjection } from '../repositories/types.js';
import type { Deps } from '../server.js';
import { ownAlertState } from '../services/ownAlertState.js';
import {inboxState} from '../services/inboxState.js';

/**
 * GET /v1/me/inbox — the alerts she was sent.  (P1-02)
 *
 * The read side of the fan-out. `AlertFanout` and the notify-contacts task
 * have been writing durable per-recipient projections, and until now nothing
 * could read them: the rows were correct and invisible.
 *
 * WHOSE INBOX. The subject comes from the verified token and nowhere else.
 * There is no uid path parameter, no uid body field, and the querystring is
 * `additionalProperties: false`, so a request for someone else's inbox is not
 * a request this endpoint can express - a `?uid=` is rejected as a malformed
 * query rather than quietly ignored. Same shape as /v1/me/export.
 *
 * ISOLATION IS STRUCTURAL, not a filter. The repository is scoped by its
 * recipient argument: `inbox/{recipientUid}/alerts/*` in Firestore, where the
 * uid is the parent document path. There is no predicate to forget or invert,
 * so there is no query this handler can build that returns another recipient's
 * projections.
 *
 * WHAT A RECIPIENT MAY SEE is already decided at WRITE time by
 * AlertFanout.project, and this endpoint deliberately adds nothing to it. The
 * stored projection is the audience-tiered view: a contact she chose receives
 * the true position, a responder the snapped cell centre. Nothing here reads
 * the alert document, so a phone number, an emergency contact list, an
 * evidence key or a keyword hash cannot reach this response - they are not in
 * the projection to begin with.
 *
 * KNOWING AN ALERT ID BUYS NOTHING. The alert id is not an input. A caller who
 * knows one still receives only projections written for her, which is the same
 * property `POST /v1/alerts/:id/accept` relies on.
 *
 * BACKEND. `deps.inbox` is the `InboxRepository` interface, so this route is
 * backend-agnostic by construction. In production that is Firestore today:
 * `alehulsh_api` is NOLOGIN and the composition root wires no PostgreSQL
 * repository, so claiming otherwise would be false. When the PostgreSQL
 * implementation is wired this handler does not change.
 */

/** The default page. Small enough to be cheap, large enough to be useful. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * What the client receives.
 *
 * Renamed from the stored field names on purpose. The projection calls these
 * `fuzzedLat`/`fuzzedLng` because a responder's copy is a cell centre - but a
 * contact's copy holds the TRUE position with `fuzzedPrecision: 'exact'`, so a
 * client field literally named "fuzzed" would misdescribe her own data.
 * `precision` is what says which it is, and it is always sent.
 */
interface InboxItem {
  hasAcknowledged:boolean|null;
  alertId: string;
  key: string;
  expiresAt: string | null;
  displayName: string;
  latitude: number | null;
  longitude: number | null;
  /** 'exact' for a contact's copy, otherwise the fuzzing label. */
  precision: string;
  isUrgent: boolean;
  status: 'active' | 'escalated';
  createdAt: string;
  /** That a recording exists. Never the recording, never a link to it. */
  hasVoiceNote: boolean;
  reportedDelayMs: number | null;
  audience: 'responder' | 'contact';
}

function toItem(p: AlertProjection&{hasAcknowledged:boolean|null}): InboxItem {
  return {
    hasAcknowledged:p.hasAcknowledged,
    alertId: p.alertId,
    key: p.alertKey ?? p.alertId,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    displayName: p.displayName,
    latitude: p.fuzzedLat,
    longitude: p.fuzzedLng,
    precision: p.fuzzedPrecision,
    isUrgent: p.isUrgent,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    hasVoiceNote: p.hasVoiceNote,
    reportedDelayMs: p.reportedDelayMs,
    audience: p.audience,
  };
}

interface Query {
  /**
   * A STRING, because this API sets `coerceTypes: false` deliberately
   * (src/server.ts): coercion "turns 999 into 999, which defeats range checks
   * and hides client bugs we would rather see". A querystring value is always
   * a string, so an `integer` schema here could never match and every explicit
   * limit would be rejected. The schema checks the shape; the handler checks
   * the range, so neither the global decision nor the bound is weakened.
   */
  limit?: string;
}

export function registerInboxRoute(app: FastifyInstance, deps: Deps): void {
  app.get('/v1/me/alert', { onRequest: requireSubject(deps.tokenVerifier) }, async (req, reply) => {
    if (Object.keys(req.query as object).length) throw new AppError('invalid_request');
    return reply.send({ alert: await ownAlertState(deps.alerts, deps.acceptances, subjectOf(req).uid) });
  });
  app.get<{ Querystring: Query }>(
    '/v1/me/inbox',
    {
      onRequest: requireSubject(deps.tokenVerifier),
      schema: {
        querystring: {
          type: 'object',
          // Rejects anything we did not define - including a `uid`, which is
          // the parameter this endpoint must never honour.
          additionalProperties: false,
          properties: {
            // Shape only: up to three digits. The range is enforced below so
            // the bound appears once, as a number, next to its default.
            limit: { type: 'string', pattern: '^[0-9]{1,3}$' },
          },
        },
      },
    },
    async (req, reply) => {
      const { uid } = subjectOf(req);

      const limit = req.query.limit === undefined
        ? DEFAULT_LIMIT
        : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        // Refused, not clamped. A client asking for 500 has a bug, and
        // silently serving 100 hides it - the same reasoning as the
        // no-coercion decision above.
        throw new AppError(
          'invalid_request',
          `limit must be between 1 and ${MAX_LIMIT}`,
        );
      }

      const projections = await inboxState(deps.inbox,deps.acceptances,uid,limit);

      // No count of what was NOT returned. Reporting a total would tell a
      // caller how many alerts exist beyond her page, and `truncated` is all a
      // client needs to know there may be more.
      return reply.send({
        items: projections.map(toItem),
        count: projections.length,
        limit,
        truncated: projections.length === limit,
      });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import { DataExporter } from '../services/DataExporter.js';
import type { Deps } from '../server.js';

/**
 * GET /v1/me/export — her own data.  (P2-21 · C-16 Art 24-32)
 *
 * Only ever the caller's own data. There is no uid parameter, so there is
 * nothing to tamper with: the subject comes from the verified token and an
 * export of someone else is not a request this endpoint can express.
 *
 * A NOTE ON COERCION, because this endpoint deserves it. An abuser holding her
 * unlocked phone can call this and get everything in one file — contacts,
 * alert state, links to recordings. He could already browse most of it in the
 * app, so this is a concentration risk rather than a new one, but it is real.
 * What is done about it here:
 *
 *   recordings are expiring links, not bytes, so the file stops working;
 *   every export is logged against the uid, so it is at least visible;
 *   it is rate limited, so repeated attempts are not free.
 *
 * What is NOT done, and needs a product decision: there is no second factor
 * and no out-of-band notice, because we have no channel to reach her that he
 * does not also control. Notifying her on the same device would tell him she
 * might report it.
 */
const EXPORT_CAP = 5;
const EXPORT_WINDOW_MS = 60 * 60 * 1000;

export function registerExportRoute(app: FastifyInstance, deps: Deps): void {
  const exporter = new DataExporter(
    deps.users, deps.alerts, deps.contacts, deps.evidence, deps.evidenceStore, deps.logger,
  );

  app.get(
    '/v1/me/export',
    { onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);

      const { allowed, count } = await deps.limiter.hit(
        `export:${uid}`, EXPORT_CAP, EXPORT_WINDOW_MS,
      );
      if (!allowed) {
        deps.logger.warn('data export rate limited', { subject: uid, count });
        throw new AppError('rate_limited', `${count} export requests for ${uid}`);
      }

      const data = await exporter.exportFor(uid);

      // Served as a file. A survivor taking this to a lawyer or a court should
      // get something she can save and hand over, not a page she has to
      // screenshot.
      void reply.header(
        'content-disposition',
        `attachment; filename="alehulsh-export-${data.exportedAt.slice(0, 10)}.json"`,
      );
      return reply.send(data);
    },
  );
}

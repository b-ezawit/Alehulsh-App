import { alertCreateSchema as bodySchema } from '../http/schemas.js';
import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import { AppError } from '../errors.js';
import { readDeviceTime } from '../domain/deviceTime.js';
import type { Deps } from '../server.js';
import { expediteAlertWork } from '../services/alertWork.js';
import { voidResetOnAlert } from './keywordReset.js';
import {alertDetailsSchema,type AlertDetailsBody} from '../http/alertDetails.js';

/**
 * POST /v1/alerts — raise an SOS.  (P1-08)
 *
 * The client no longer writes the alert. This is what lets the server stamp its
 * own clock, enforce idempotency, and schedule the escalation that
 * docs/coercion-and-escalation.md depends on.
 */


interface Body {
  requestId: string;
  latitude?: number | null;
  longitude?: number | null;
  occurredAt?: string | null;
  accuracyMeters?: number | null;
  locationAgeMs?: number | null;
}

export function registerAlertRoutes(app: FastifyInstance, deps: Deps): void {
  app.patch<{Params:{id:string};Body:AlertDetailsBody}>('/v1/alerts/:id',{
    schema:{body:alertDetailsSchema},onRequest:requireSubject(deps.tokenVerifier),
  },async(req,reply)=>{
    if(!deps.alerts.updateOwnedDetails)return reply.code(503).send({error:{code:'unavailable',message:'This operation is unavailable.'}});
    const {incidentKey,...details}=req.body;
    await deps.alerts.updateOwnedDetails(subjectOf(req).uid,req.params.id,incidentKey,details);return reply.send({saved:true});
  });
  app.post<{ Body: Body }>(
    '/v1/alerts',
    { schema: { body: bodySchema }, onRequest: requireSubject(deps.tokenVerifier) },
    async (req, reply) => {
      const { uid } = subjectOf(req);
      const lat = req.body.latitude ?? null;
      const lon = req.body.longitude ?? null;

      // Half a fix is not a fix. Accepting one coordinate would put her on the
      // equator or the prime meridian.
      if ((lat === null) !== (lon === null)) {
        throw new AppError('invalid_request', 'latitude and longitude must both be present or both absent');
      }

      // Rate limiting (P1-15) — and the two things it must never do.
      //
      // 1. It must never touch a live emergency. If she already has an active
      //    or escalated alert this request folds into it rather than creating
      //    anything, so the limiter is skipped entirely. A woman re-triggering
      //    during an ongoing emergency is the one case where being wrong is
      //    unforgivable, and the cheapest way to be right is not to ask.
      // 2. It must not ration emergencies. The cap is an abuse ceiling for
      //    scripts, set far above anything a person does: twenty distinct
      //    alerts in an hour is not someone in trouble twenty times, it is
      //    automation. Below it nothing is throttled, delayed or degraded.
      //
      // NOT IMPLEMENTED, deliberately: the per-device half of this task. It
      // needs a persistent device identifier, which is a tracking vector this
      // app should not create (CLAUDE.md §6) — and every alert already requires
      // an authenticated account, so the per-user cap covers the same abuse
      // without the new identifier. Revisit only if accounts become cheap
      // enough to script.
      const live = await deps.alerts.findActiveByOwner(uid);
      if (!live) {
        const { allowed, count } = await deps.limiter.hit(
          `alert:create:${uid}`, deps.config.alertCreateCap, deps.config.alertCreateWindowMs,
        );
        if (!allowed) {
          // error, not warn: if this fires for a real person we have refused
          // someone an emergency alert and need to know immediately.
          deps.logger.error('alert creation refused — abuse ceiling reached', {
            subject: uid, count, cap: deps.config.alertCreateCap,
          });
          throw new AppError('rate_limited', `${count} alerts in window for ${uid}`);
        }
      }

      // An unusable date becomes "we do not know", never an error and never a
      // guess. The alert matters more than the metadata on it, and an
      // offset-less timestamp is ambiguous rather than wrong - interpreting it
      // in the server's timezone would silently misreport how old her position
      // is. See src/domain/deviceTime.ts.
      const deviceTime = readDeviceTime(req.body.occurredAt);
      if (deviceTime.rejection === 'no_offset' || deviceTime.rejection === 'unparseable') {
        // warn, not error: the alert is proceeding normally. This exists to
        // surface a client build sending unusable timestamps. The reason is
        // logged; the value never is.
        deps.logger.warn('occurredAt ignored', { reason: deviceTime.rejection });
      }

      const { alert, created } = await deps.alerts.create({
        requestId: req.body.requestId,
        ownerId: uid,
        latitude: lat,
        longitude: lon,
        occurredAt: deviceTime.at,
        accuracyMeters: req.body.accuracyMeters ?? null,
        locationAgeMs: req.body.locationAgeMs ?? null,
      });

      // Repair legacy initialization on retries without moving deadlines.
      if (alert.status === 'active' || alert.status === 'escalated') {
        await voidResetOnAlert(deps, uid);
      }
      await expediteAlertWork(alert, deps.config.safetyCheckDelayMs, deps.queue, deps.logger);

      if (alert.status === 'active' || alert.status === 'escalated') {
        // Her contacts get the alert NOW, not on escalation.  (P2-05)
        //
        // Inline rather than queued, because the latency of a queue poll is
        // latency on an emergency. Written as a per-recipient projection so
        // the database is only ever asked "is this your own inbox?" — a
        // question rules and RLS both express, unlike "are you near this
        // alert?".
        //
        // A FAN-OUT FAILURE MUST NOT COST HER THE ALERT. The alert row is the
        // irreplaceable part and it is already committed; failing the request
        // here would turn a notification problem into a lost SOS. So the
        // failure is caught, logged at error, and handed to the durable queue
        // to retry — the notify-contacts task exists precisely to do this work
        // out of band, with bounded retries and an abandonment signal if it
        // never succeeds.
        try {
          const fan = await deps.fanout.dispatch(alert);
          deps.logger.info('alert fanned out on creation', {
            alertId: alert.id,
            contactCount: fan.contacts.length,
            unreachableContacts: fan.unreachableContacts,
            responderDiscovery: fan.responderDiscovery,
          });
        } catch (err: unknown) {
          deps.logger.error('fan-out failed on creation; queued for retry', {
            alertId: alert.id,
            detail: err instanceof Error ? err.message : String(err),
          });
          // The initial notification intent was committed with the alert.
        }
      }

      deps.logger.info(created ? 'alert created' : 'alert re-trigger folded into existing', {
        alertId: alert.id,
        subject: uid,
        hasLocation: lat !== null,
        reportedDelayMs: alert.reportedDelayMs ?? null,
      });

      // 201 for a new alert, 200 when an existing one was returned, so the
      // client can tell a retry from a fresh dispatch.
      return reply.status(created ? 201 : 200).send({
        alert: {
          id: alert.id,
          key: alert.key,
          status: alert.status,
          createdAt: alert.createdAt.toISOString(),
          expiresAt: alert.expiresAt.toISOString(),
          hasLocation: alert.latitude !== null,
          /**
           * What the SERVER concluded the position is, so the client can show
           * "last known location, 20 min old" instead of implying a live fix.
           * The client's own view is a claim; this is the decision.
           *
           * The coordinates themselves are deliberately NOT echoed: she sent
           * them, so returning them tells her nothing and widens where her
           * position appears for no benefit.
           */
          locationQuality: alert.locationQuality,
          // Echoed back so the client can say "this was queued for two hours"
          // rather than implying it just went out.
          reportedDelayMs: alert.reportedDelayMs ?? null,
        },
      });
    },
  );
}

import { acceptAlert } from '../services/acceptAlert.js';
import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import type { Deps } from '../server.js';
import type { Acceptance } from '../repositories/types.js';

/**
 * POST /v1/alerts/:id/accept — a responder answers.  (P1-10)
 *
 * Replaces the client-side write removed by P0-07, where any authenticated
 * user could append to `responders` on any alert (CRIT-03). The same clause
 * let them overwrite `voiceNotes`, so the bug was not only impersonation but
 * remote evidence destruction.
 *
 * Two properties the old write could not have, both from the acceptance
 * criteria:
 *
 *   only yourself — the uid comes from the verified token. There is no uid in
 *     the request at all, so there is nothing to forge;
 *   only an alert you were told about — proven by holding an inbox
 *     projection, which only the fan-out writes.
 *
 * What it deliberately does not do:
 *
 *   it does not change the alert's status (alert-lifecycle.md §6 — a helper
 *     en route is not a safety confirmation, and treating it as one would let
 *     an attacker who registers as a helper silence his victim's alert);
 *   it does not cancel the safety check or escalation, for the same reason;
 *   it does not return exact coordinates. Accepting is the precondition for
 *     staged reveal (P2-08), not the reveal itself.
 */
export function registerAcceptRoute(app: FastifyInstance, deps: Deps): void {
  app.delete<{Params:{id:string};Body:{incidentKey:string}}>('/v1/alerts/:id/accept',{
    onRequest:requireSubject(deps.tokenVerifier),schema:{body:{type:'object',required:['incidentKey'],additionalProperties:false,
      properties:{incidentKey:{type:'string',minLength:1,maxLength:128}}}},
  },async(req,reply)=>{
    if(!deps.acceptances.withdraw)return reply.code(503).send({error:{code:'unavailable',message:'This operation is unavailable.'}});
    await deps.acceptances.withdraw(req.params.id,subjectOf(req).uid,req.body.incidentKey);return reply.code(204).send();
  });
  app.post<{ Params: { id: string; }; Body: { incidentKey?: string; }; }>(
    '/v1/alerts/:id/accept',
    {
      // No body. (alertId, uid) is the natural key, so a replay is the same
      // request rather than something needing an idempotency token.
      schema: { body: { type: 'object', additionalProperties: false, properties: { incidentKey: { type: 'string', minLength: 1, maxLength: 128 } } } },
      onRequest: requireSubject(deps.tokenVerifier),
    },
    async (req, reply) => {
      const result = await acceptAlert(deps, subjectOf(req).uid, req.params.id, req.body?.incidentKey);
      return reply.status(result.created ? 201 : 200).send(result.body);
    },
  );
}

/**
 * Adapter so account deletion reaches acceptances too.  (P2-20 · C-16)
 *
 * Registered at composition. A store the deleter does not know about is data
 * she was told had been erased and has not been.
 */
export function acceptanceDeletableStore(repo: {
  deleteAllForResponder(uid: string): Promise<number>;
}): { readonly name: string; purge(uid: string): Promise<number>; } {
  return {
    name: 'acceptances',
    purge: (uid) => repo.deleteAllForResponder(uid),
  };
}

export type { Acceptance };

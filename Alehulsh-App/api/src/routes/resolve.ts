import type { FastifyInstance } from 'fastify';
import { requireSubject, subjectOf } from '../auth/middleware.js';
import type { Deps } from '../server.js';
import { resolveOwnedAlert } from '../services/resolveOwnedAlert.js';
export function registerResolveRoute(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { id: string; }; Body: { keyword: string; incidentKey?: string; }; }>(
    '/v1/alerts/:id/resolve',
    {
      schema: {
        body: {
          type: 'object', required: ['keyword'], additionalProperties: false,
          properties: { keyword: { type: 'string', minLength: 1, maxLength: 256 }, incidentKey: { type: 'string', minLength: 1, maxLength: 128 } }
        }
      },
      onRequest: requireSubject(deps.tokenVerifier)
    },
    async (req, reply) => {
      await resolveOwnedAlert(deps, subjectOf(req).uid, req.params.id, req.body.keyword, req.body.incidentKey);
      return reply.send({ acknowledged: true });
    },
  );
}

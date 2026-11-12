import type { FastifyInstance } from 'fastify';
import { requireTaskRunner } from '../auth/taskAuth.js';
import type { Deps } from '../server.js';
import { processAlertTask, type AlertTaskInput, type AlertTaskKind } from '../services/processAlertTask.js';

const bodySchema = {
  type: 'object', required: ['alertId'], additionalProperties: false,
  properties: {
    alertId: { type: 'string', minLength: 1, maxLength: 128 },
    alertKey: { type: 'string', minLength: 1, maxLength: 128 }
  },
} as const;

/** Same domain operation is used by the bounded Workers dispatcher. */
export function registerTaskRoutes(app: FastifyInstance, deps: Deps): void {
  const preHandler = requireTaskRunner(deps.config.taskRunnerSecret);
  for (const kind of ['safety-check', 'expiry', 'notify-contacts', 'retract-inbox'] satisfies AlertTaskKind[]) {
    app.post<{ Body: AlertTaskInput; }>(`/internal/tasks/${kind}`,
      { schema: { body: bodySchema }, preHandler },
      async (req, reply) => reply.send(await processAlertTask(deps, kind, req.body)));
  }
}

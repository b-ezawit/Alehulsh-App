import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { toClientError } from './errors.js';
import type { Logger } from './logger.js';
import type { TokenVerifier } from './auth/TokenVerifier.js';
import type { AlertRepository, UserRepository } from './repositories/types.js';
import type { TaskQueue } from './queue/TaskQueue.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerResolveRoute } from './routes/resolve.js';
import { registerTaskRoutes } from './routes/tasks.js';

/**
 * Everything the handlers need, injected. No module reaches for a global
 * client, which is what keeps the swap at C-04 to three files.
 */
export interface Deps {
  config: Config;
  logger: Logger;
  tokenVerifier: TokenVerifier;
  alerts: AlertRepository;
  users: UserRepository;
  queue: TaskQueue;
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({
    // We log through our own redacting logger. Fastify's would print headers,
    // which carry the bearer token.
    logger: false,
    // Trust the platform proxy for client IP — needed by rate limiting (P1-14).
    trustProxy: true,
    bodyLimit: 64 * 1024,
    ajv: {
      customOptions: {
        // Fastify's defaults are wrong for this API:
        //   removeAdditional strips unknown fields silently, so a client
        //     sending `status` or `userId` gets a 201 instead of an error and
        //     we never learn it tried;
        //   coerceTypes turns "999" into 999, which defeats range checks and
        //     hides client bugs we would rather see.
        // Reject, do not repair.
        removeAdditional: false,
        coerceTypes: false,
        allErrors: false,
      },
    },
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body, internal } = toClientError(err);
    const level = status >= 500 ? 'error' : 'warn';
    deps.logger[level]('request failed', {
      method: req.method,
      path: req.routeOptions?.url ?? req.url,
      status,
      subject: req.subject?.uid,
      ...internal,
    });
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: { code: 'not_found', message: 'Not available.' } });
  });

  // Liveness. Deliberately reveals nothing about state or dependencies.
  app.get('/healthz', async () => ({ ok: true }));

  registerAlertRoutes(app, deps);
  registerResolveRoute(app, deps);
  registerTaskRoutes(app, deps);
  // P1-10 (/accept) lands next.

  return app;
}

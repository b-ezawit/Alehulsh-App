import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { mustUpgrade } from '../version.js';
import type { Deps } from '../server.js';

/**
 * GET /v1/app/policy — the force-upgrade gate.  (P1-26.1, P1-26.3)
 *
 * Why this exists: P1-27 closes direct client writes to Firestore, and that
 * cannot happen while old builds still depend on them. Without a floor we can
 * raise, the exposure stays open until the slowest user updates. This lets us
 * end it on our timeline instead of theirs.
 *
 * UNAUTHENTICATED, on purpose. It runs at launch, before sign-in, and a user
 * who cannot sign in is exactly the one who might need an update. It returns
 * the same public policy to everyone and reads nothing about the caller.
 *
 * THE RULE THE WHOLE FEATURE HANGS ON: when in doubt, do not block. An
 * unreadable client version, an unreadable or missing minimum, an unknown
 * platform, a failed policy read — every one of them returns
 * `mustUpgrade: false`. See version.ts.
 *
 * The client half (P1-26.2) must follow the same rule: if this endpoint is
 * unreachable or slow, continue into the app. A safety app that will not open
 * because a config endpoint is down is worse than one running an old build.
 */
const querySchema = {
  type: 'object',
  required: ['platform'],
  additionalProperties: false,
  properties: {
    platform: { type: 'string', enum: ['android', 'ios'] },
    version: { type: 'string', maxLength: 40 },
  },
} as const;

interface Query { platform: 'android' | 'ios'; version?: string }

export function registerAppPolicyRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Querystring: Query }>(
    '/v1/app/policy',
    { schema: { querystring: querySchema } },
    async (req, reply) => {
      const { platform, version } = req.query;
      const policy = await deps.clientPolicy.get();
      const forPlatform = policy[platform];

      // Adoption telemetry, only when the caller happens to be signed in.
      // Recorded against the account uid, which already exists — no device
      // identifier is created for this (CLAUDE.md §6). A failure here must
      // never affect the answer, so it is caught and dropped.
      if (version) {
        void recordVersion(deps, req.headers.authorization, platform, version);
      }

      return reply.send({
        mustUpgrade: mustUpgrade(version, forPlatform.minVersion),
        minVersion: forPlatform.minVersion,
        latestVersion: forPlatform.latestVersion,
      });
    },
  );

  /** The adoption number P1-27 is gated on. Operator-only. */
  app.get(
    '/internal/version-distribution',
    async (req, reply) => {
      const presented = req.headers['x-task-secret'];
      if (typeof presented !== 'string' || presented !== deps.config.taskRunnerSecret) {
        throw new AppError('not_found', 'version distribution requires the operator secret');
      }
      return reply.send({ distribution: await deps.versionTelemetry.distribution() });
    },
  );
}

async function recordVersion(
  deps: Deps,
  authorization: string | undefined,
  platform: 'android' | 'ios',
  version: string,
): Promise<void> {
  try {
    if (!authorization?.startsWith('Bearer ')) return;
    const token = authorization.slice('Bearer '.length).trim();
    if (!token) return;
    const subject = await deps.tokenVerifier.verify(token);
    await deps.versionTelemetry.record(subject.uid, platform, version, new Date());
  } catch {
    // An anonymous or expired caller is the normal case here, not an error.
    // Telemetry is never worth failing a launch check over.
  }
}

/** C-16 — her last-seen version goes with everything else. */
export function versionTelemetryDeletableStore(repo: {
  deleteForUid(uid: string): Promise<number>;
}): { readonly name: string; purge(uid: string): Promise<number> } {
  return { name: 'client_versions', purge: (uid) => repo.deleteForUid(uid) };
}

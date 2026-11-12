import { registerOwnedAccountRoutes } from './accountRoutes.js';
import {registerDeliveryRoutes} from './deliveryRoutes.js';
import {inboxState} from '../services/inboxState.js';
import {PostgresIdentifierSource} from '../auth/PostgresIdentifierSource.js';
import {alertDetailsSchema,type AlertDetailsBody} from '../http/alertDetails.js';
import {PrivateDelivery} from '../notifications/PrivateDelivery.js';
import { ownAlertState } from '../services/ownAlertState.js';
import { Unavailable } from './availability.js';
export { Unavailable } from './availability.js';
import { PostgresProfileRepository } from '../repositories/postgres/PostgresProfileRepository.js';
import { PostgresContactManagementRepository } from '../repositories/postgres/PostgresContactManagementRepository.js';
import { SupabaseSessionBridge, readSessionPolicy } from '../auth/SupabaseSessionBridge.js';
import type { Queryable } from '../db/pool.js';
import { IdentityNotMappedError } from '../repositories/types.js';
import { withWorkerDatabase } from './database.js';
import { PostgresClientPolicyRepository } from '../repositories/postgres/PostgresClientPolicyRepository.js';
import { PostgresVersionTelemetryRepository } from '../repositories/postgres/PostgresVersionTelemetryRepository.js';
import { mustUpgrade } from '../version.js';
import { DataExporter } from '../services/DataExporter.js';
import type { ClientPolicy, ContactRepository, VersionTelemetryRepository } from '../repositories/types.js';
import { acceptAlert } from '../services/acceptAlert.js';
import { evidenceCreateSchema, issueEvidence, completeEvidence, listOwnerEvidence, type EvidenceCreateBody } from '../services/ownerEvidence.js';
import { PostgresAcceptanceRepository } from '../repositories/postgres/PostgresAcceptanceRepository.js';
import { PostgresEvidenceRepository } from '../repositories/postgres/PostgresEvidenceRepository.js';
import { R2EvidenceStore } from '../evidence/R2EvidenceStore.js';
import type { EvidenceStore } from '../evidence/EvidenceStore.js';
import type { PublicationBucket } from '../evidence/R2ImmutablePublisher.js';
import type { AcceptanceRepository, EvidenceRepository } from '../repositories/types.js';
import { PostgresUserRepository } from '../repositories/postgres/PostgresUserRepository.js';
import { PostgresKeywordResetRepository } from '../repositories/postgres/PostgresKeywordResetRepository.js';
import { PostgresContactRepository } from '../repositories/postgres/PostgresContactRepository.js';
import { PostgresTaskQueue } from '../queue/PostgresTaskQueue.js';
import { ContactMatcher } from '../services/ContactMatcher.js';
import { AlertFanout } from '../services/AlertFanout.js';
import { resolveOwnedAlert } from '../services/resolveOwnedAlert.js';
import { readDeviceTime } from '../domain/deviceTime.js';
import { hashKeyword, verifyKeyword, normalizeKeyword, isShippedDefault } from '../crypto/keyword.js';
import { InMemorySlidingWindowLimiter } from '../rate/RateLimiter.js';
import { alertCreateSchema, keywordChangeSchema, keywordConfirmSchema } from '../http/schemas.js';
import { validatedJson } from './validation.js';
import { redact, type Logger } from '../logger.js';
import type { UserRepository, KeywordResetRepository } from '../repositories/types.js';
import type { TaskQueue } from '../queue/TaskQueue.js';
import { Hono } from 'hono';
import { AppError, toClientError } from '../errors.js';
import type { AlertRepository, InboxRepository } from '../repositories/types.js';
import { PostgresAlertRepository } from '../repositories/postgres/PostgresAlertRepository.js';
import { PostgresInboxRepository } from '../repositories/postgres/PostgresInboxRepository.js';
import { SupabaseTokenVerifier, type SupabaseSubject } from './SupabaseTokenVerifier.js';

/** Only Cloudflare's supplied binding may establish the database connection. */
export interface WorkerBindings {
  PUSH_CONSENT_VERSION?:string;
  PUSH_CONSENT_TEXT?:string;
  HYPERDRIVE?: { connectionString: string; };
  EVIDENCE_BUCKET?: PublicationBucket;
  R2_ENDPOINT?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  SUPABASE_AUTH_ISSUER?: string;
  SUPABASE_AUTH_AUDIENCE?: string;
  KEYWORD_PEPPER?: string;
  SUPABASE_SESSION_MAX_AGE_SECONDS?: string;
  SUPABASE_SESSION_INACTIVITY_SECONDS?: string;
}

export interface MutationRepositories {
  alerts: AlertRepository; users: UserRepository; keywordResets: KeywordResetRepository;
  inbox: InboxRepository; queue: TaskQueue; fanout: AlertFanout;
  contacts?: ContactRepository;
  acceptances?: AcceptanceRepository;
  evidence?: EvidenceRepository;
  evidenceStore?: EvidenceStore;
}
export interface ReadRepositories {
  deliveries?:PrivateDelivery;
  acceptances?: Pick<AcceptanceRepository, 'listForAlert'> & Partial<Pick<AcceptanceRepository,'findFor'>>;
  writes?: MutationRepositories;
  versionTelemetry?: VersionTelemetryRepository;
  alerts: Pick<AlertRepository, 'findActiveByOwner'> & Partial<Pick<AlertRepository, 'listHistoryForOwner'>>;
  profiles?: Pick<PostgresProfileRepository, 'get' | 'update'>;
  contactManagement?: Pick<PostgresContactManagementRepository, 'list' | 'put' | 'remove'>;
  inbox: Pick<InboxRepository, 'listForRecipient'>;
}

export interface WorkerDependencies {
  withAuthDatabase?: <T>(env: WorkerBindings, run: (db: Queryable) => Promise<T>) => Promise<T>;
  clientPolicy?: (env: WorkerBindings) => Promise<ClientPolicy>;
  /** Must check live revocation/disabled-account state; JWT validity is insufficient. */
  sessionIsActive?: (subject: SupabaseSubject, env: WorkerBindings) => Promise<boolean>;
  tokenVerifier?: (env: WorkerBindings) => Pick<SupabaseTokenVerifier, 'verify'>;
  withRepositories?: <T>(env: WorkerBindings, subject: SupabaseSubject,
    run: (repos: ReadRepositories) => Promise<T>) => Promise<T>;
}

export const workerLogger: Logger = {
  debug() { }, info() { },
  warn(message, context) { console.warn(message, redact(context)); },
  error(message, context) { console.error(message, redact(context)); },
};
const limiter = new InMemorySlidingWindowLimiter();
const operationConfig = (pepper: string) => ({
  keywordPepper: pepper, keywordAttemptCap: 3,
  keywordAttemptCooldownMs: 30_000, safetyCheckDelayMs: 120_000
});
const emptyBody = { type: 'object', additionalProperties: false, properties: {} };
const resolveSchema = {
  type: 'object', required: ['keyword'], additionalProperties: false,
  properties: { keyword: { type: 'string', minLength: 1, maxLength: 256 }, incidentKey: { type: 'string', minLength: 1, maxLength: 128 } }
};
function newKeyword(raw: string) {
  if (normalizeKeyword(raw).length < 3 || isShippedDefault(raw)) throw new AppError('invalid_request');
}


let cachedVerifier: { issuer: string; audience: string; verifier: SupabaseTokenVerifier; } | undefined;

function verifier(env: WorkerBindings): SupabaseTokenVerifier {
  if (!env.SUPABASE_AUTH_ISSUER || !env.SUPABASE_AUTH_AUDIENCE) throw new Unavailable();
  try {
    if (cachedVerifier?.issuer === env.SUPABASE_AUTH_ISSUER
      && cachedVerifier.audience === env.SUPABASE_AUTH_AUDIENCE) return cachedVerifier.verifier;
    const instance = new SupabaseTokenVerifier({
      issuer: env.SUPABASE_AUTH_ISSUER, audience: env.SUPABASE_AUTH_AUDIENCE,
    });
    cachedVerifier = {
      issuer: env.SUPABASE_AUTH_ISSUER, audience: env.SUPABASE_AUTH_AUDIENCE,
      verifier: instance,
    };
    return instance;
  } catch { throw new Unavailable(); }
}

async function withRepositories<T>(
  env: WorkerBindings, subject: SupabaseSubject, run: (repos: ReadRepositories) => Promise<T>,
): Promise<T> {
  if (!env.HYPERDRIVE?.connectionString) throw new Unavailable();
  try {
    return await withWorkerDatabase(env, subject.uid, async db => {
      const alerts = new PostgresAlertRepository(db, 2 * 60 * 60 * 1000);
      const pepper = env.KEYWORD_PEPPER;
      // No proof source means contact projections are unavailable, never
      // downgraded to trusting historical profile flags.
      const identifiers=pepper?new PostgresIdentifierSource(db,pepper):{proves:async()=>false};
      const inbox = new PostgresInboxRepository(db,identifiers);
      const users = new PostgresUserRepository(db,identifiers);
      const contacts = pepper ? new PostgresContactRepository(db, pepper) : undefined;
      let evidenceStore: EvidenceStore | undefined;
      if (env.EVIDENCE_BUCKET && env.R2_ENDPOINT && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
        try {
          evidenceStore = new R2EvidenceStore({
            endpoint: env.R2_ENDPOINT, bucket: env.R2_BUCKET,
            accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY
          }, fetch, env.EVIDENCE_BUCKET);
        } catch { throw new Unavailable(); }
      }
      return await run({
        alerts, inbox, deliveries:new PrivateDelivery(db,identifiers), acceptances: new PostgresAcceptanceRepository(db), profiles: new PostgresProfileRepository(db), contactManagement: new PostgresContactManagementRepository(db), versionTelemetry: new PostgresVersionTelemetryRepository(db), ...(pepper ? {
          writes: {
            alerts, inbox, users, contacts: contacts!, acceptances: new PostgresAcceptanceRepository(db),
            ...(evidenceStore ? { evidence: new PostgresEvidenceRepository(db), evidenceStore } : {}), keywordResets: new PostgresKeywordResetRepository(db),
            queue: new PostgresTaskQueue(db), fanout: new AlertFanout(inbox, null, null,
              new ContactMatcher(contacts!, users), workerLogger),
          }
        } : {})
      });
    });
  } catch (error) {
    if (error instanceof AppError || error instanceof IdentityNotMappedError) throw error;
    throw new Unavailable();
  }
}

/** A real Hono Fetch API. Unported methods are absent, never proxied to Node. */
export function createWorkersApp(deps: WorkerDependencies = {}) {
  const app = new Hono<{ Bindings: WorkerBindings; Variables: { subject: SupabaseSubject; providerSubject: SupabaseSubject; accountMapped: boolean; }; }>();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof Unavailable) {
      return c.json({ error: { code: 'unavailable', message: 'Service temporarily unavailable.' } }, 503);
    }
    const { status, body } = toClientError(err);
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not available.' } }, 404));
  app.get('/healthz', (c) => c.json({ ok: true }));

  // Public launch policy intentionally precedes authentication. A failed
  // policy read must not prevent someone opening the emergency application.
  app.get('/v1/app/policy', async c => {
    const query = new URL(c.req.url).searchParams, platform = query.get('platform'), version = query.get('version') ?? undefined;
    if (!['android', 'ios'].includes(platform ?? '') || (version?.length ?? 0) > 40 ||
      [...query.keys()].some(k => !['platform', 'version'].includes(k)) ||
      query.getAll('platform').length !== 1 || query.getAll('version').length > 1) throw new AppError('invalid_request');
    let policy: ClientPolicy = { android: { minVersion: null, latestVersion: null }, ios: { minVersion: null, latestVersion: null } };
    try {
      if (deps.clientPolicy) policy = await deps.clientPolicy(c.env);
      else if (c.env.HYPERDRIVE?.connectionString) {
        policy = await withWorkerDatabase(c.env, null, db => new PostgresClientPolicyRepository(db).get());
      }
    } catch { /* Advisory outage: continue into the app. */ }
    const header = c.req.header('authorization');
    if (version && header?.startsWith('Bearer ') && deps.sessionIsActive) {
      try {
        const actor = await (deps.tokenVerifier ?? verifier)(c.env).verify(header.slice(7).trim());
        if (await deps.sessionIsActive(actor, c.env)) await (deps.withRepositories ?? withRepositories)(c.env, actor,
          repos => repos.versionTelemetry?.record(actor.uid, platform as 'android' | 'ios', version, new Date()) ?? Promise.resolve());
      } catch { /* Account telemetry never determines whether the app opens. */ }
    }
    const selected = policy[platform as 'android' | 'ios'];
    return c.json({ mustUpgrade: mustUpgrade(version, selected.minVersion), minVersion: selected.minVersion, latestVersion: selected.latestVersion });
  });

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ') || !header.slice(7).trim()) throw new AppError('unauthenticated');
    // Signature verification alone never establishes a live provider session.
    if (!deps.sessionIsActive) {
      if (!deps.withAuthDatabase && !c.env.HYPERDRIVE?.connectionString) throw new Unavailable();
      try { readSessionPolicy(c.env); } catch { throw new Unavailable(); }
    }
    const providerSubject = await (deps.tokenVerifier ?? verifier)(c.env).verify(header.slice(7).trim());
    let subject = providerSubject, accountMapped = true;
    if (deps.sessionIsActive) {
      let active: boolean;
      try { active = await deps.sessionIsActive(providerSubject, c.env); } catch { throw new Unavailable(); }
      if (active !== true) throw new AppError('unauthenticated');
    } else {
      let identity;
      try {
        identity = await (deps.withAuthDatabase ?? ((env, run) => withWorkerDatabase(env, null, run)))(c.env,
          async db => {
            const bridge=new SupabaseSessionBridge(db,readSessionPolicy(c.env));
            const identity=await bridge.inspect(providerSubject);
            if(identity?.applicationSubject && c.env.KEYWORD_PEPPER?.trim())
              await bridge.synchronizeIdentifiers(providerSubject,identity,c.env.KEYWORD_PEPPER);
            return identity;
          });
      } catch { throw new Unavailable(); }
      if (!identity) throw new AppError('unauthenticated');
      accountMapped = identity.applicationSubject !== null;
      if (identity.applicationSubject) subject = { ...providerSubject, uid: identity.applicationSubject };
    }
    c.set('providerSubject', providerSubject);
    c.set('subject', subject);
    c.set('accountMapped', accountMapped);
    if (!accountMapped && !['/v1/me/account','/v1/me/logout'].includes(c.req.path)) throw new IdentityNotMappedError();
    await next();
  });

  app.get('/v1/me/account', c => c.json({ provisioned: c.get('accountMapped') }));
  app.post('/v1/me/logout', async c => {
    await validatedJson(c.req.raw,emptyBody);
    try {
      await (deps.withAuthDatabase ?? ((env,run)=>withWorkerDatabase(env,null,run)))(c.env,
        db=>new SupabaseSessionBridge(db,readSessionPolicy(c.env)).revoke(c.get('providerSubject')));
    } catch(e) { if(e instanceof AppError)throw e;throw new Unavailable(); }
    return c.body(null,204);
  });
  app.post('/v1/me/account', async c => {
    const body = await validatedJson<{ name: string; homeAddress?: string; keyword: string; }>(c.req.raw, {
      type: 'object', required: ['name', 'keyword'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 }, homeAddress: { type: 'string', maxLength: 1000 },
        keyword: { type: 'string', minLength: 3, maxLength: 256 },
      },
    });
    if (!c.env.KEYWORD_PEPPER?.trim()) throw new Unavailable();
    newKeyword(body.keyword);
    if (!body.name.trim()) throw new AppError('invalid_request');
    const uid = c.get('providerSubject').uid;
    if (!(await limiter.hit(`account:provision:${uid}`, 5, 3600000)).allowed) throw new AppError('rate_limited');
    const hash = await hashKeyword(body.keyword, c.env.KEYWORD_PEPPER);
    try {
      await (deps.withAuthDatabase ?? ((env, run) => withWorkerDatabase(env, null, run)))(c.env,
        db => new SupabaseSessionBridge(db, readSessionPolicy(c.env)).provision(c.get('providerSubject'), {
          name: body.name.trim(), homeAddress: body.homeAddress ?? '', keywordHash: hash,
        }));
    } catch (error) { if (error instanceof AppError) throw error; throw new Unavailable(); }
    return c.json({ provisioned: true }, 201);
  });

  app.get('/v1/me/inbox', async (c) => {
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some((key) => key !== 'limit') || query.getAll('limit').length > 1) {
      throw new AppError('invalid_request');
    }
    const raw = query.get('limit');
    if (raw !== null && !/^[0-9]{1,3}$/.test(raw)) throw new AppError('invalid_request');
    const limit = raw === null ? 25 : Number(raw);
    if (limit < 1 || limit > 100) throw new AppError('invalid_request');
    const subject = c.get('subject');
    const items = await (deps.withRepositories ?? withRepositories)(c.env, subject, async (repos) => {
      const projections = await inboxState(repos.inbox,repos.acceptances,subject.uid,limit);
      return projections.map((p) => ({
        alertId: p.alertId, key: p.alertKey ?? p.alertId, expiresAt: p.expiresAt?.toISOString() ?? null, displayName: p.displayName,
        latitude: p.fuzzedLat, longitude: p.fuzzedLng, precision: p.fuzzedPrecision,
        isUrgent: p.isUrgent, status: p.status, createdAt: p.createdAt.toISOString(),
        hasVoiceNote: p.hasVoiceNote, reportedDelayMs: p.reportedDelayMs, audience: p.audience,hasAcknowledged:p.hasAcknowledged,
      }));
    });
    return c.json({ items, count: items.length, limit, truncated: items.length === limit });
  });

  app.get('/v1/me/alert', async (c) => {
    if (new URL(c.req.url).searchParams.size) throw new AppError('invalid_request');
    const subject = c.get('subject');
    const alert = await (deps.withRepositories ?? withRepositories)(c.env, subject,
      async repos => {
        const state=await ownAlertState(repos.alerts,repos.acceptances,subject.uid);
        if(!state||!repos.deliveries)return state;
        const summary=await repos.deliveries.summary(state.id);
        const current=await repos.alerts.findActiveByOwner(subject.uid);
        if(!current)return null;
        if(current.key!==state.key)return ownAlertState(repos.alerts,repos.acceptances,subject.uid);
        return {...state,delivery:{queuedDeviceIntents:summary?.['queued']??0,providerAcceptedDeviceIntents:summary?.['provider_accepted']??0,
          deviceReportedReceipts:summary?.['device_received']??0,openedDeviceIntents:summary?.['opened']??0,abandonedDeviceIntents:summary?.['abandoned']??0,
          selectedRecipients:summary?.['selected_recipients']??0,selectionPendingTasks:summary?.['selection_pending']??0,selectionAbandonedTasks:summary?.['selection_abandoned']??0}};
      });
    return c.json({ alert });
  });

  // Write adapters are deliberately gated independently of the read scaffold.
  const mutate = async <T>(env: WorkerBindings, subject: SupabaseSubject,
    run: (repos: MutationRepositories, pepper: string) => Promise<T>): Promise<T> => {
    if (!env.KEYWORD_PEPPER?.trim()) throw new Unavailable();
    return (deps.withRepositories ?? withRepositories)(env, subject, repos => {
      if (!repos.writes) throw new Unavailable();
      return run(repos.writes, env.KEYWORD_PEPPER!);
    });
  };
  app.post('/v1/alerts', async c => {
    const body = await validatedJson<{
      requestId: string; latitude?: number | null; longitude?: number | null;
      occurredAt?: string | null; accuracyMeters?: number | null; locationAgeMs?: number | null
      ;
    }>(c.req.raw, alertCreateSchema);
    const latitude = body.latitude ?? null, longitude = body.longitude ?? null;
    if ((latitude === null) !== (longitude === null)) throw new AppError('invalid_request');
    const { alert, created } = await mutate(c.env, c.get('subject'), async repos => {
      const uid = c.get('subject').uid;
      if (!await repos.alerts.findActiveByOwner(uid) && !(await limiter.hit(`alert:create:${uid}`, 20, 3600000)).allowed) throw new AppError('rate_limited');
      return repos.alerts.create({
        requestId: body.requestId, ownerId: uid, latitude, longitude,
        occurredAt: readDeviceTime(body.occurredAt).at, accuracyMeters: body.accuracyMeters ?? null, locationAgeMs: body.locationAgeMs ?? null
      });
    });
    return c.json({
      alert: {
        id: alert.id, key: alert.key, status: alert.status, createdAt: alert.createdAt.toISOString(),
        expiresAt: alert.expiresAt.toISOString(), hasLocation: alert.latitude !== null,
        locationQuality: alert.locationQuality, reportedDelayMs: alert.reportedDelayMs ?? null
      }
    }, created ? 201 : 200);
  });
  app.post('/v1/alerts/:id/resolve', async c => {
    const body = await validatedJson<{ keyword: string; incidentKey?: string; }>(c.req.raw, resolveSchema);
    await mutate(c.env, c.get('subject'), async (repos, pepper) => resolveOwnedAlert({
      ...repos, config: operationConfig(pepper), logger: workerLogger,
    }, c.get('subject').uid, c.req.param('id'), body.keyword, body.incidentKey));
    return c.json({ acknowledged: true });
  });
  app.put('/v1/me/keyword', async c => {
    const body = await validatedJson<{ keyword: string; currentKeyword?: string; }>(c.req.raw, keywordChangeSchema);
    await mutate(c.env, c.get('subject'), async (repos, pepper) => {
      const uid = c.get('subject').uid;
      if (await repos.alerts.findActiveByOwner(uid)) throw new AppError('conflict');
      if (!(await limiter.hit(`keyword:set:${uid}`, 5, 3600000)).allowed) throw new AppError('rate_limited');
      newKeyword(body.keyword);
      const user = await repos.users.findByUid(uid);
      if(user?.legacyKeywordMigrationRequired)throw new AppError('conflict');
      const existing = user?.safetyKeywordHash;
      if (existing && !user.mustSetKeyword) {
        if (!body.currentKeyword) throw new AppError('invalid_request');
        if (!await verifyKeyword(body.currentKeyword, existing, pepper)) throw new AppError('forbidden');
        if (await verifyKeyword(body.keyword, existing, pepper)) throw new AppError('invalid_request');
      }
      const hash = await hashKeyword(body.keyword, pepper);
      await repos.users.compareAndSetSafetyKeyword(uid, existing ?? null, hash);
    });
    return c.json({ keywordSet: true });
  });
  app.post('/v1/me/keyword/reset', async c => {
    await validatedJson(c.req.raw, emptyBody);
    const reset = await mutate(c.env, c.get('subject'), repos => {
      const now = new Date();
      return repos.keywordResets.create({
        uid: c.get('subject').uid, requestedAt: now,
        eligibleAt: new Date(now.getTime() + 72 * 3600000), status: 'pending'
      });
    });
    return c.json({ eligibleAt: reset.eligibleAt.toISOString(), currentKeywordStillWorks: true }, 202);
  });
  app.get('/v1/me/keyword/reset', async c => {
    const reset = await mutate(c.env, c.get('subject'), repos => repos.keywordResets.findPending(c.get('subject').uid));
    return c.json(reset ? { pending: true, eligibleAt: reset.eligibleAt.toISOString(), currentKeywordStillWorks: true } : { pending: false });
  });
  app.delete('/v1/me/keyword/reset', async c => {
    await mutate(c.env, c.get('subject'), repos => repos.keywordResets.update(c.get('subject').uid,
      { status: 'cancelled', cancelledAt: new Date(), cancelledReason: 'user' }));
    return c.json({ pending: false });
  });
  app.post('/v1/me/keyword/reset/confirm', async c => {
    const body = await validatedJson<{ keyword: string; }>(c.req.raw, keywordConfirmSchema);
    await mutate(c.env, c.get('subject'), async (repos, pepper) => {
      const uid = c.get('subject').uid;
      if (await repos.alerts.findActiveByOwner(uid)) throw new AppError('conflict');
      const pending = await repos.keywordResets.findPending(uid);
      if (!pending) throw new AppError('not_found');
      const now = new Date(); if (pending.eligibleAt > now) throw new AppError('conflict');
      newKeyword(body.keyword);
      await repos.keywordResets.confirm(uid, pending.requestedAt, await hashKeyword(body.keyword, pepper), now);
    });
    return c.json({ keywordSet: true });
  });

  app.post('/v1/alerts/:id/accept', async c => {
    const body = await validatedJson<{ incidentKey?: string }>(c.req.raw, { ...emptyBody, properties: { incidentKey: { type: 'string', minLength: 1, maxLength: 128 } } });
    const result = await mutate(c.env, c.get('subject'), repos => {
      if (!repos.acceptances) throw new Unavailable();
      return acceptAlert({ ...repos, acceptances: repos.acceptances }, c.get('subject').uid, c.req.param('id'), body.incidentKey);
    });
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.patch('/v1/alerts/:id',async c=>{
    const {incidentKey,...details}=await validatedJson<AlertDetailsBody>(c.req.raw,alertDetailsSchema);
    await mutate(c.env,c.get('subject'),async repos=>{
      if(!repos.alerts.updateOwnedDetails)throw new Unavailable();
      await repos.alerts.updateOwnedDetails(c.get('subject').uid,c.req.param('id'),incidentKey,details);
    });return c.json({saved:true});
  });
  app.delete('/v1/alerts/:id/accept',async c=>{
    const body=await validatedJson<{incidentKey:string}>(c.req.raw,{type:'object',required:['incidentKey'],additionalProperties:false,
      properties:{incidentKey:{type:'string',minLength:1,maxLength:128}}});
    await mutate(c.env,c.get('subject'),async repos=>{
      if(!repos.acceptances?.withdraw)throw new Unavailable();
      await repos.acceptances.withdraw(c.req.param('id'),c.get('subject').uid,body.incidentKey);
    });return c.body(null,204);
  });
  const evidenceRepos = (repos: MutationRepositories) => {
    if (!repos.evidence || !repos.evidenceStore) throw new Unavailable();
    return { ...repos, evidence: repos.evidence, evidenceStore: repos.evidenceStore };
  };
  app.post('/v1/alerts/:id/evidence', async c => {
    const body = await validatedJson<EvidenceCreateBody>(c.req.raw, evidenceCreateSchema);
    const result = await mutate(c.env, c.get('subject'), repos => issueEvidence(
      evidenceRepos(repos), c.get('subject').uid, c.req.param('id'), body));
    return c.json(result, 201);
  });
  app.post('/v1/evidence/:evidenceId/complete', async c => {
    await validatedJson(c.req.raw, emptyBody);
    const result = await mutate(c.env, c.get('subject'), repos => completeEvidence(
      evidenceRepos(repos), c.get('subject').uid, c.req.param('evidenceId')));
    return c.json(result);
  });
  app.get('/v1/alerts/:id/evidence', async c => {
    const result = await mutate(c.env, c.get('subject'), repos => listOwnerEvidence(
      evidenceRepos(repos), c.get('subject').uid, c.req.param('id')));
    return c.json(result);
  });
  app.get('/v1/me/export', async c => {
    if (new URL(c.req.url).searchParams.size) throw new AppError('invalid_request');
    const uid = c.get('subject').uid;
    if (!(await limiter.hit(`export:${uid}`, 5, 3600000)).allowed) throw new AppError('rate_limited');
    const data = await mutate(c.env, c.get('subject'), repos => {
      const evidence = evidenceRepos(repos);
      if (!repos.contacts) throw new Unavailable();
      return new DataExporter(repos.users, repos.alerts, repos.contacts, evidence.evidence, evidence.evidenceStore, workerLogger).exportFor(uid);
    });
    c.header('Content-Disposition', `attachment; filename="alehulsh-export-${data.exportedAt.slice(0, 10)}.json"`);
    return c.json(data);
  });
  // These require the audited reveal policy and repository.
  // The routes exist so callers receive an explicit unavailable response.
  app.post('/v1/alerts/:id/reveal', () => { throw new Unavailable(); });
  for (const path of ['/v1/alerts/:id/evidence/responder']) {
    app.get(path, () => { throw new Unavailable(); });
  }
  registerOwnedAccountRoutes(app, deps.withRepositories ?? withRepositories);
  registerDeliveryRoutes(app,deps.withRepositories??withRepositories);
  return app;
}

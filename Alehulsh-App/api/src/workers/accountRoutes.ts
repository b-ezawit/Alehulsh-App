import type { Hono } from 'hono';
import type { WorkerBindings, ReadRepositories } from './app.js';
import type { SupabaseSubject } from './SupabaseTokenVerifier.js';
import { Unavailable } from './availability.js';
import { AppError } from '../errors.js';
import { validatedJson } from './validation.js';
import { normalizePhone, normalizeEmail } from '../crypto/identifier.js';
import type { ProfileUpdate } from '../repositories/postgres/PostgresProfileRepository.js';
import type { ContactWrite } from '../repositories/postgres/PostgresContactManagementRepository.js';
type Env = { Bindings: WorkerBindings; Variables: { subject: SupabaseSubject; providerSubject: SupabaseSubject; accountMapped: boolean; }; };
type Repositories = <T>(env: WorkerBindings, subject: SupabaseSubject, run: (repos: ReadRepositories) => Promise<T>) => Promise<T>;
const profileSchema = {
  type: 'object', minProperties: 1, additionalProperties: false, properties: {
    fullName: { type: 'string', minLength: 1, maxLength: 120 }, homeAddress: { type: 'string', maxLength: 1000 },
    phoneNumber: { type: ['string', 'null'], maxLength: 50 },
    locationSharingEnabled: { type: 'boolean' }, autoAudioRecording: { type: 'boolean' }, fakeCallEnabled: { type: 'boolean' }, communityAlertsEnabled: { type: 'boolean' },
  }
};
const contactSchema = {
  type: 'object', required: ['name', 'phone', 'isPrimary'], additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 }, phone: { type: 'string', minLength: 1, maxLength: 50 }, email: { type: 'string', maxLength: 320 },
    relationship: { type: 'string', maxLength: 120 }, isPrimary: { type: 'boolean' },
  }
};
function contactId(value: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new AppError('invalid_request'); return value; }
export function registerOwnedAccountRoutes(app: Hono<Env>, withRepositories: Repositories) {
  app.get('/v1/me/profile', async c => {
    if (new URL(c.req.url).searchParams.size) throw new AppError('invalid_request');
    const profile = await withRepositories(c.env, c.get('subject'), repos => { if (!repos.profiles) throw new Unavailable(); return repos.profiles.get(c.get('subject').uid); });
    if (!profile) throw new AppError('not_found'); return c.json({ profile, locationPreferenceScope: 'future_alerts' });
  });
  app.patch('/v1/me/profile', async c => {
    const body = await validatedJson<ProfileUpdate>(c.req.raw, profileSchema);
    if (body.fullName !== undefined) { body.fullName = body.fullName.trim(); if (!body.fullName) throw new AppError('invalid_request'); }
    if (body.phoneNumber) { const normalized = normalizePhone(body.phoneNumber); if (!normalized) throw new AppError('invalid_request'); body.phoneNumber = normalized; }
    else if (body.phoneNumber === '') body.phoneNumber = null;
    const profile = await withRepositories(c.env, c.get('subject'), repos => { if (!repos.profiles) throw new Unavailable(); return repos.profiles.update(c.get('subject').uid, body); });
    return c.json({ profile, locationPreferenceScope: 'future_alerts' });
  });
  app.get('/v1/me/contacts', async c => {
    if (new URL(c.req.url).searchParams.size) throw new AppError('invalid_request');
    const contacts = await withRepositories(c.env, c.get('subject'), repos => { if (!repos.contactManagement) throw new Unavailable(); return repos.contactManagement.list(c.get('subject').uid); });
    return c.json({ contacts });
  });
  app.put('/v1/me/contacts/:id', async c => {
    const id = contactId(c.req.param('id'));
    const body = await validatedJson<ContactWrite>(c.req.raw, contactSchema);
    const name = body.name.trim(), phone = normalizePhone(body.phone), email = body.email ? normalizeEmail(body.email) : '';
    if (!name || !phone || email === null) throw new AppError('invalid_request');
    const created = await withRepositories(c.env, c.get('subject'), repos => {
      if (!repos.contactManagement) throw new Unavailable();
      return repos.contactManagement.put(c.get('subject').uid, id, { name, phone, email, relationship: body.relationship ?? '', isPrimary: body.isPrimary });
    });
    return c.json({ saved: true }, created ? 201 : 200);
  });
  app.delete('/v1/me/contacts/:id', async c => {
    const id = contactId(c.req.param('id'));
    await withRepositories(c.env, c.get('subject'), repos => { if (!repos.contactManagement) throw new Unavailable(); return repos.contactManagement.remove(c.get('subject').uid, id); });
    return c.body(null, 204);
  });
  app.get('/v1/me/alerts', async c => {
    const query = new URL(c.req.url).searchParams, raw = query.get('limit');
    if ([...query.keys()].some(key => key !== 'limit') || query.getAll('limit').length > 1 || (raw !== null && !/^\d{1,3}$/.test(raw))) throw new AppError('invalid_request');
    const limit = raw === null ? 25 : Number(raw); if (limit < 1 || limit > 100) throw new AppError('invalid_request');
    const history = await withRepositories(c.env, c.get('subject'), repos => { if (!repos.alerts.listHistoryForOwner) throw new Unavailable(); return repos.alerts.listHistoryForOwner(c.get('subject').uid, limit); });
    return c.json({
      alerts: history.map(alert => ({
        id: alert.id, key: alert.key, status: alert.status, createdAt: alert.createdAt.toISOString(),
        expiresAt: alert.expiresAt.toISOString(), resolvedAt: alert.resolvedAt?.toISOString() ?? null, hasLocation: alert.latitude !== null,
        locationQuality: alert.locationQuality, reportedDelayMs: alert.reportedDelayMs ?? null
      })), limit, truncated: history.length === limit
    });
  });
}

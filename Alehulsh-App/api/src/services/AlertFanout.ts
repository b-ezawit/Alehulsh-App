import { encodeGeohash } from '../geo.js';
import { FUZZ_LABEL, FUZZ_PRECISION, fuzzFromGeohash } from '../geoFuzz.js';
import type { Logger } from '../logger.js';
import type {
  Alert, AlertProjection, InboxRepository, ResponderLocationRepository,
} from '../repositories/types.js';
import type { ContactMatcher } from './ContactMatcher.js';
import type { ResponderRegistry } from './ResponderRegistry.js';

/**
 * Writes per-recipient projections when an alert is raised.  (P2-05)
 *
 * This is what lets responder discovery come back after Phase 0 switched it
 * off. Firestore rules cannot express "only if you are near this alert", so
 * instead of asking the database an unanswerable question, a server writes each
 * recipient their own copy and the database is only ever asked "is this your
 * own inbox?" — which rules and RLS both express trivially.
 *
 * Cost follows: alerts x selected recipients, not alerts x every listening
 * device. The audit measured the old global-listener design at roughly 330M
 * reads per day at 100K users; this is about 33K.
 */
export interface FanoutResult {
  alertId: string;
  responders: string[];
  contacts: string[];
  /** Contacts with no account. Not an error — P3-01 §6 shows her these. */
  unreachableContacts: number;
}

export class AlertFanout {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly responderLocations: ResponderLocationRepository,
    private readonly registry: ResponderRegistry,
    private readonly contacts: ContactMatcher,
    private readonly logger: Logger,
  ) {}

  async dispatch(alert: Alert): Promise<FanoutResult> {
    const [responders, contactResult] = await Promise.all([
      this.selectResponders(alert),
      this.contacts.resolveForOwner(alert.ownerId),
    ]);

    const contactUids = [...new Set(
      contactResult.map((c) => c.uid).filter((u): u is string => u !== null && u !== alert.ownerId),
    )];

    // A contact who is also a nearby responder is a contact — she gets the
    // fuller view she was chosen for, not the stranger's one.
    const responderUids = responders.filter((uid) => !contactUids.includes(uid));

    await Promise.all([
      ...responderUids.map((uid) => this.inbox.put(uid, this.project(alert, 'responder'))),
      ...contactUids.map((uid) => this.inbox.put(uid, this.project(alert, 'contact'))),
    ]);

    const result: FanoutResult = {
      alertId: alert.id,
      responders: responderUids,
      contacts: contactUids,
      unreachableContacts: contactResult.filter((c) => c.uid === null).length,
    };

    this.logger.info('alert fanned out', {
      alertId: alert.id,
      responderCount: responderUids.length,
      contactCount: contactUids.length,
      unreachableContacts: result.unreachableContacts,
    });

    return result;
  }

  /** Called when an alert reaches a terminal state. A responder's inbox must
   *  not become a history of other people's emergencies. */
  async retract(alertId: string): Promise<number> {
    const recipients = await this.inbox.listRecipients(alertId);
    await Promise.all(recipients.map((uid) => this.inbox.remove(uid, alertId)));
    this.logger.info('alert retracted from inboxes', { alertId, count: recipients.length });
    return recipients.length;
  }

  private async selectResponders(alert: Alert): Promise<string[]> {
    if (alert.latitude === null || alert.longitude === null) {
      // No location, no proximity. Contacts still get it; strangers cannot be
      // sent somewhere we do not know.
      return [];
    }

    // The centre cell alone misses someone standing metres away across a
    // boundary (SCALE-06), so query the eight neighbours too.
    const prefixes = surroundingPrefixes(alert.latitude, alert.longitude, 5);
    const nearby = await this.responderLocations.findByGeohashPrefixes(prefixes);

    const eligible: string[] = [];
    for (const { uid } of nearby) {
      if (uid === alert.ownerId) continue;
      // P4-07. Until vouching has admitted anyone this returns false for
      // everyone, and the fan-out is inert — which is correct. A fan-out that
      // guessed at eligibility would broadcast her position to strangers.
      if (await this.registry.isEligible(uid)) eligible.push(uid);
    }
    return eligible;
  }

  private project(alert: Alert, audience: 'responder' | 'contact'): AlertProjection {
    // Contacts were chosen by her in advance and get the true position
    // (P1-01 §4). Responders are strangers the system selected and get the
    // snapped cell centre.
    const fuzzed = fuzzFromGeohash(alert.geohash ?? encodeGeohashOrNull(alert));
    const exact = audience === 'contact' && alert.latitude !== null && alert.longitude !== null;

    return {
      alertId: alert.id,
      displayName: '',            // filled by the caller from the owner profile
      fuzzedLat: exact ? alert.latitude : fuzzed?.lat ?? null,
      fuzzedLng: exact ? alert.longitude : fuzzed?.lng ?? null,
      fuzzedPrecision: exact ? 'exact' : FUZZ_LABEL,
      isUrgent: false,
      status: alert.status === 'escalated' ? 'escalated' : 'active',
      createdAt: alert.createdAt,
      hasVoiceNote: false,
      audience,
    };
  }
}

function encodeGeohashOrNull(alert: Alert): string | null {
  if (alert.latitude === null || alert.longitude === null) return null;
  return encodeGeohash(alert.latitude, alert.longitude, FUZZ_PRECISION);
}

/** Centre cell plus its eight neighbours, so boundaries do not hide anyone. */
export function surroundingPrefixes(lat: number, lng: number, precision: number): string[] {
  const latDelta = 0.009;                                   // ~1km
  const lngDelta = 0.009 / Math.cos((lat * Math.PI) / 180);
  const out = new Set<string>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      out.add(encodeGeohash(lat + dy * latDelta, lng + dx * lngDelta, precision));
    }
  }
  return [...out];
}

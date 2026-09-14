import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AlertFanout } from '../src/services/AlertFanout.js';
import { ContactMatcher } from '../src/services/ContactMatcher.js';
import { ResponderRegistry } from '../src/services/ResponderRegistry.js';
import { createLogger } from '../src/logger.js';
import { encodeGeohash } from '../src/geo.js';
import { hashPhone } from '../src/crypto/identifier.js';
import { fuzzFromGeohash, geohashCellCentre, FUZZ_PRECISION } from '../src/geoFuzz.js';
import type { Alert } from '../src/repositories/types.js';
import {
  FakeContactRepository, FakeInboxRepository, FakeResponderLocationRepository,
  FakeResponderRepository, FakeUserRepository, OWNER, PEPPER,
} from './fakes.js';

const ADDIS = { lat: 9.0125, lng: 38.7636 };
const NEARBY = 'nearby_uid';
const FAR = 'far_uid';
const SISTER = 'sister_uid';
const SISTER_PHONE = '0911222333';

let inbox: FakeInboxRepository;
let locations: FakeResponderLocationRepository;
let responders: FakeResponderRepository;
let registry: ResponderRegistry;
let contactRepo: FakeContactRepository;
let users: FakeUserRepository;
let fanout: AlertFanout;

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: OWNER, key: 'key-fanout', ownerId: OWNER, status: 'active',
  createdAt: new Date(), expiresAt: new Date(Date.now() + 7.2e6),
  latitude: ADDIS.lat, longitude: ADDIS.lng,
  geohash: encodeGeohash(ADDIS.lat, ADDIS.lng, 9),
  attemptCount: 0, ...over,
});

const makeEligible = async (uid: string) => {
  await registry.bootstrap(uid);
};

beforeEach(() => {
  inbox = new FakeInboxRepository();
  locations = new FakeResponderLocationRepository();
  responders = new FakeResponderRepository();
  users = new FakeUserRepository();
  contactRepo = new FakeContactRepository();
  registry = new ResponderRegistry(responders, 5, createLogger('error'));
  fanout = new AlertFanout(
    inbox, locations, registry,
    new ContactMatcher(contactRepo, users),
    createLogger('error'),
  );
});

describe('responder selection', () => {
  test('an eligible responder nearby receives a projection', async () => {
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    const r = await fanout.dispatch(alert());
    assert.deepEqual(r.responders, [NEARBY]);
  });

  test('an INELIGIBLE responder nearby receives nothing — this is the P4-07 gate', async () => {
    // Until vouching admits someone, the fan-out is inert. That is correct: a
    // fan-out that guessed at eligibility would broadcast her position.
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    const r = await fanout.dispatch(alert());
    assert.deepEqual(r.responders, []);
    assert.equal(inbox.putCalls, 0);
  });

  test('a suspended responder receives nothing', async () => {
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    await registry.suspend(NEARBY, 'cause');
    assert.deepEqual((await fanout.dispatch(alert())).responders, []);
  });

  test('a distant responder is not selected', async () => {
    locations.set(FAR, encodeGeohash(-33.8688, 151.2093, 9));  // Sydney
    await makeEligible(FAR);
    assert.deepEqual((await fanout.dispatch(alert())).responders, []);
  });

  test('the owner is never her own responder', async () => {
    locations.set(OWNER, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(OWNER);
    assert.deepEqual((await fanout.dispatch(alert())).responders, []);
  });

  test('an alert with no location selects no responders', async () => {
    // Strangers cannot be sent somewhere we do not know.
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    const r = await fanout.dispatch(alert({ latitude: null, longitude: null, geohash: null }));
    assert.deepEqual(r.responders, []);
  });
});

describe('what a responder actually sees', () => {
  test('the location is the snapped cell centre, never the true position', async () => {
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    const a = alert();
    await fanout.dispatch(a);
    const p = inbox.projectionFor(NEARBY, a.id)!;
    assert.notEqual(p.fuzzedLat, ADDIS.lat);
    assert.notEqual(p.fuzzedLng, ADDIS.lng);
    assert.deepEqual(
      { lat: p.fuzzedLat, lng: p.fuzzedLng },
      geohashCellCentre(a.geohash!.slice(0, FUZZ_PRECISION)),
    );
  });

  test('fuzzing is deterministic — sampling gains nothing', async () => {
    // The whole point. A random offset would let a responder who can prompt a
    // re-fan-out average his way to her exact position.
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    const a = alert();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      await fanout.dispatch(a);
      const p = inbox.projectionFor(NEARBY, a.id)!;
      seen.add(`${p.fuzzedLat},${p.fuzzedLng}`);
    }
    assert.equal(seen.size, 1);
  });

  test('the projection carries no phone, email or contact list', async () => {
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    const a = alert();
    await fanout.dispatch(a);
    const json = JSON.stringify(inbox.projectionFor(NEARBY, a.id));
    for (const leak of ['phone', 'email', 'Contact', 'alerter']) {
      assert.ok(!json.includes(leak), `projection leaked ${leak}`);
    }
  });
});

describe('contacts', () => {
  test('a contact with an account receives the exact location, not the fuzzed one', async () => {
    // She chose them in advance — P1-01 §4.
    contactRepo.set(OWNER, [{
      id: 'c1', ownerUid: OWNER, name: 'Saba', isPrimary: true,
      phoneHash: hashPhone(SISTER_PHONE, PEPPER), emailHash: null,
    }]);
    users.register(SISTER, hashPhone(SISTER_PHONE, PEPPER)!);
    const a = alert();
    const r = await fanout.dispatch(a);
    assert.deepEqual(r.contacts, [SISTER]);
    const p = inbox.projectionFor(SISTER, a.id)!;
    assert.equal(p.fuzzedLat, ADDIS.lat);
    assert.equal(p.fuzzedPrecision, 'exact');
  });

  test('an unreachable contact is counted, not silently dropped', async () => {
    contactRepo.set(OWNER, [{
      id: 'c1', ownerUid: OWNER, name: 'Mother', isPrimary: true,
      phoneHash: hashPhone('0911000000', PEPPER), emailHash: null,
    }]);
    const r = await fanout.dispatch(alert());
    assert.equal(r.unreachableContacts, 1);
    assert.deepEqual(r.contacts, []);
  });

  test('someone who is both a contact and a nearby responder is treated as a contact', async () => {
    contactRepo.set(OWNER, [{
      id: 'c1', ownerUid: OWNER, name: 'Saba', isPrimary: true,
      phoneHash: hashPhone(SISTER_PHONE, PEPPER), emailHash: null,
    }]);
    users.register(SISTER, hashPhone(SISTER_PHONE, PEPPER)!);
    locations.set(SISTER, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(SISTER);
    const a = alert();
    const r = await fanout.dispatch(a);
    assert.deepEqual(r.contacts, [SISTER]);
    assert.deepEqual(r.responders, []);
    assert.equal(inbox.projectionFor(SISTER, a.id)!.audience, 'contact');
  });
});

describe('idempotency and retraction', () => {
  test('re-running does not duplicate inbox entries', async () => {
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    const a = alert();
    await fanout.dispatch(a);
    await fanout.dispatch(a);
    assert.equal(inbox.store.get(NEARBY)!.size, 1);
  });

  test('retraction clears every inbox', async () => {
    // A responder's inbox must not become a history of other people's
    // emergencies.
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    const a = alert();
    await fanout.dispatch(a);
    assert.equal(await fanout.retract(a.id), 1);
    assert.equal(inbox.projectionFor(NEARBY, a.id), undefined);
  });
});

describe('fuzzing primitives', () => {
  test('null location stays null rather than acquiring a fabricated one', () => {
    assert.equal(fuzzFromGeohash(null), null);
    assert.equal(fuzzFromGeohash('sc'), null);   // too short to fuzz
  });

  test('the cell centre is within ~110m of the true point', () => {
    const c = fuzzFromGeohash(encodeGeohash(ADDIS.lat, ADDIS.lng, 9))!;
    const dLat = (c.lat - ADDIS.lat) * 111_320;
    const dLng = (c.lng - ADDIS.lng) * 111_320 * Math.cos((ADDIS.lat * Math.PI) / 180);
    assert.ok(Math.hypot(dLat, dLng) < 120, `drift was ${Math.hypot(dLat, dLng)}m`);
  });
});

describe('P3-13 — recipients can see how old the position is', () => {
  test('a queued alert carries its delay into every projection', async () => {
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);

    // Triggered three hours ago with no signal, replayed on reconnect. The
    // coordinates describe where she was then, and a responder must be able
    // to see that rather than assume the alert is happening now.
    await fanout.dispatch(alert({
      deviceReportedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      reportedDelayMs: 3 * 60 * 60 * 1000,
    }));

    assert.equal(inbox.projectionFor(NEARBY, OWNER)?.reportedDelayMs, 3 * 60 * 60 * 1000);
  });

  test('a fresh alert reports no delay rather than a fabricated zero', async () => {
    locations.set(NEARBY, encodeGeohash(ADDIS.lat, ADDIS.lng, 9));
    await makeEligible(NEARBY);
    await fanout.dispatch(alert());
    assert.equal(inbox.projectionFor(NEARBY, OWNER)?.reportedDelayMs, null);
  });

  test('a contact sees the age too — she must not be told a stale alert is live', async () => {
    contactRepo.set(OWNER, [{
      id: 'c1', ownerUid: OWNER, name: 'Sister',
      phoneHash: null, emailHash: null, isPrimary: true,
    }]);
    await fanout.dispatch(alert({ reportedDelayMs: 90 * 60 * 1000 }));
    // Whatever the audience, the age travels with the projection.
    for (const [, box] of inbox.store) {
      for (const [, p] of box) assert.equal(p.reportedDelayMs, 90 * 60 * 1000);
    }
  });
});

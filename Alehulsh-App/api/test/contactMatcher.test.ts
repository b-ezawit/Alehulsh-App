import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContactMatcher } from '../src/services/ContactMatcher.js';
import { hashPhone, hashEmail } from '../src/crypto/identifier.js';
import { FakeContactRepository, FakeUserRepository, OWNER, STRANGER, PEPPER } from './fakes.js';

const SISTER_PHONE = '0911222333';
const AUNT_EMAIL = 'aunt@example.com';

let contacts: FakeContactRepository;
let users: FakeUserRepository;
let matcher: ContactMatcher;

const contact = (id: string, name: string, phone?: string, email?: string) => ({
  id, ownerUid: OWNER, name, isPrimary: false,
  phoneHash: phone ? hashPhone(phone, PEPPER) : null,
  emailHash: email ? hashEmail(email, PEPPER) : null,
});

beforeEach(() => {
  contacts = new FakeContactRepository();
  users = new FakeUserRepository();
  matcher = new ContactMatcher(contacts, users);
});

describe('ContactMatcher', () => {
  test('resolves a contact who has the app, by phone', async () => {
    contacts.set(OWNER, [contact('c1', 'Saba', SISTER_PHONE)]);
    users.register(STRANGER, hashPhone(SISTER_PHONE, PEPPER)!);
    const [r] = await matcher.resolveForOwner(OWNER);
    assert.equal(r!.uid, STRANGER);
  });

  test('matches regardless of how she typed the number', async () => {
    // She saved "+251 91 122 2333"; her sister registered with "0911222333".
    contacts.set(OWNER, [contact('c1', 'Saba', '+251 91 122 2333')]);
    users.register(STRANGER, hashPhone('0911222333', PEPPER)!);
    const [r] = await matcher.resolveForOwner(OWNER);
    assert.equal(r!.uid, STRANGER);
  });

  test('falls back to email when the phone does not match', async () => {
    contacts.set(OWNER, [contact('c1', 'Aunt', '0911999999', AUNT_EMAIL)]);
    users.register(STRANGER, hashEmail(AUNT_EMAIL, PEPPER)!);
    const [r] = await matcher.resolveForOwner(OWNER);
    assert.equal(r!.uid, STRANGER);
  });

  test('returns unreachable contacts rather than dropping them', async () => {
    // At launch this is most of them. P3-01 §6 requires showing her which.
    contacts.set(OWNER, [contact('c1', 'Mother', '0911000000')]);
    const [r] = await matcher.resolveForOwner(OWNER);
    assert.equal(r!.uid, null);
    assert.equal(r!.name, 'Mother');
  });

  test('never resolves her own account as her own contact', async () => {
    // Otherwise she is notified of her own alert and the "contacts reached"
    // count means nothing.
    contacts.set(OWNER, [contact('c1', 'Me', SISTER_PHONE)]);
    users.register(OWNER, hashPhone(SISTER_PHONE, PEPPER)!);
    const [r] = await matcher.resolveForOwner(OWNER);
    assert.equal(r!.uid, null);
  });

  test('reachableUids drops the unreachable and de-duplicates', async () => {
    const h = hashPhone(SISTER_PHONE, PEPPER)!;
    contacts.set(OWNER, [
      contact('c1', 'Saba', SISTER_PHONE),
      contact('c2', 'Saba again', SISTER_PHONE),
      contact('c3', 'Mother', '0911000000'),
    ]);
    users.register(STRANGER, h);
    assert.deepEqual(await matcher.reachableUids(OWNER), [STRANGER]);
  });

  test('a contact with no usable identifier is unreachable, not an error', async () => {
    contacts.set(OWNER, [contact('c1', 'Neighbour')]);
    const [r] = await matcher.resolveForOwner(OWNER);
    assert.equal(r!.uid, null);
  });

  test('no contacts is not an error', async () => {
    assert.deepEqual(await matcher.resolveForOwner(OWNER), []);
    assert.deepEqual(await matcher.reachableUids(OWNER), []);
  });
});

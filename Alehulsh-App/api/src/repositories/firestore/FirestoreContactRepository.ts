import type { Firestore } from 'firebase-admin/firestore';
import { hashEmail, hashPhone } from '../../crypto/identifier.js';
import type { ContactRepository, EmergencyContact } from '../types.js';

/**
 * Adapter over today's shape, presenting tomorrow's interface.
 *
 * Emergency contacts currently live as an array on the profile document —
 * P2-01 §4 designed them as rows, and P2-03 moves them, but that migration has
 * not run. Rather than block everything downstream on it, this reads the array
 * and returns rows, so callers are written against the model we are moving to
 * and the change lands in one file.
 *
 * Raw phone numbers and emails are hashed here and never leave this class.
 * They are stored in the clear on the profile today; that is P2-03's problem to
 * fix, and this must not make it worse by handing them further up the stack.
 */
interface ContactEntry {
  id?: string;
  name?: string;
  phone?: string;
  email?: string;
  isPrimary?: boolean;
}

export class FirestoreContactRepository implements ContactRepository {
  constructor(
    private readonly db: Firestore,
    private readonly pepper: string,
  ) {}

  async listByOwner(ownerUid: string): Promise<EmergencyContact[]> {
    const snap = await this.db.collection('users').doc(ownerUid).get();
    if (!snap.exists) return [];
    const raw = snap.data()?.['emergencyContacts'];
    if (!Array.isArray(raw)) return [];

    return (raw as ContactEntry[]).map((c, i) => ({
      // Positional ids until P2-03 gives them real ones. Stable enough to
      // address a contact within one read, and not presented as durable.
      id: c.id ?? `idx-${i}`,
      ownerUid,
      name: typeof c.name === 'string' ? c.name : '',
      phoneHash: typeof c.phone === 'string' ? hashPhone(c.phone, this.pepper) : null,
      emailHash: typeof c.email === 'string' ? hashEmail(c.email, this.pepper) : null,
      isPrimary: c.isPrimary === true || i === 0,
    }));
  }

  async deleteAllForOwner(ownerUid: string): Promise<number> {
    const ref = this.db.collection('users').doc(ownerUid);
    const snap = await ref.get();
    if (!snap.exists) return 0;
    const raw = snap.data()?.['emergencyContacts'];
    const count = Array.isArray(raw) ? raw.length : 0;
    if (count === 0) return 0;
    // The contacts are a field on a document that deletion removes entirely,
    // but clearing them explicitly means partial deletion still takes her
    // support network with it.
    await ref.update({ emergencyContacts: [] });
    return count;
  }
}

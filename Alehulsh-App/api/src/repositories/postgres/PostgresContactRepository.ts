import type { Queryable } from '../../db/pool.js';
import { hashPhone,hashEmail } from '../../crypto/identifier.js';
import type { ContactRepository, EmergencyContact } from '../types.js';

/**
 * ContactRepository on PostgreSQL.  (M-05)
 *
 * Her emergency contacts - the people the fan-out actually reaches. One row
 * per contact, not an array element, because only rows can be individually
 * deleted (C-16), carry consent state, and answer "can we reach this person?".
 *
 * HASHES ARE DERIVED ON READ, NOT STORED. The table holds `phone_e164` in the
 * clear, because she must be able to see and edit the contacts she chose. The
 * peppered hash that `ContactMatcher` resolves against is computed here with
 * the server's pepper, so the pepper never enters the database and a stolen
 * dump cannot be matched against account identifiers offline. Same shape as
 * the Firestore implementation, for the same reason.
 *
 * TWO DIFFERENCES FROM THE FIRESTORE MODEL, both deliberate and both worth
 * knowing before this is switched on:
 *
 *  1. Migration 0023 added contact email. Both identifiers are hashed here;
 *     neither client-entered email nor phone grants recipient ownership.
 *  2. **The table already has `contact_user_id`/`linked_at`** - a
 *     server-resolved link to an account, which 0006 revoked from the client
 *     role precisely so she cannot assert who someone IS. This repository does
 *     not read it: resolution stays in `ContactMatcher` via the hash, so there
 *     is one path to the answer rather than two that can disagree.
 */

function couldBeSubject(subject: string): boolean {
  return subject.length > 0 && !subject.includes('\u0000');
}

interface ContactRow {
  id: string;
  label: string;
  phone_e164: string;
  email:string|null;
  is_primary: boolean;
}

export class PostgresContactRepository implements ContactRepository {
  /**
   * @param pepper the server-side secret for identifier hashing. Never stored
   *   and never logged; without it a database dump cannot be matched against
   *   accounts, which is the whole point of hashing a space of ~10^8 numbers.
   */
  constructor(
    private readonly db: Queryable,
    private readonly pepper: string,
  ) {
    if (!pepper) {
      // Fail at construction. A silently empty pepper would still produce
      // hashes - deterministic, unsalted ones that any dump could reverse.
      throw new Error('PostgresContactRepository requires a pepper');
    }
  }

  /**
   * Every contact she has, reachable or not.
   *
   * The unreachable ones are returned too rather than filtered: P3-01 §6
   * requires showing her which contacts we cannot reach, and a repository that
   * dropped them would make that impossible to display.
   *
   * `is_primary DESC` first so the contact she marked primary leads the list,
   * then `created_at` for a stable order.
   */
  async listByOwner(ownerUid: string): Promise<EmergencyContact[]> {
    if (!couldBeSubject(ownerUid)) return [];

    const { rows } = await this.db.query<ContactRow>(
      `SELECT c.id::text, c.label, c.phone_e164, c.email, c.is_primary
         FROM emergency_contacts c
         JOIN identity_map m ON m.user_id = c.owner_id
        WHERE m.firebase_uid = $1
        ORDER BY c.is_primary DESC, c.created_at, c.id`,
      [ownerUid],
    );

    return rows.map((r) => ({
      id: r.id,
      ownerUid,
      name: r.label,
      // hashPhone normalises first, so the four shapes an Ethiopian number
      // arrives in all hash identically - otherwise matching silently fails
      // and her contact is never told.
      phoneHash: hashPhone(r.phone_e164, this.pepper),
      emailHash: r.email?hashEmail(r.email,this.pepper):null,
      isPrimary: r.is_primary === true,
    }));
  }

  /**
   * C-16. Returns how many rows went, so a deletion can be reported honestly
   * rather than assumed.
   *
   * Zero for an unknown subject rather than an error: erasing something that
   * is already gone is success.
   */
  async deleteAllForOwner(ownerUid: string): Promise<number> {
    if (!couldBeSubject(ownerUid)) return 0;

    const { rowCount } = await this.db.query(
      `DELETE FROM emergency_contacts
        WHERE owner_id = (SELECT m.user_id FROM identity_map m
                           WHERE m.firebase_uid = $1)`,
      [ownerUid],
    );
    return rowCount ?? 0;
  }
}

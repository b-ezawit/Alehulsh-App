import type { Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import type {VerifiedIdentifierSource} from '../../auth/VerifiedIdentifierSource.js';
import { IdentityNotMappedError, type UserRecord, type UserRepository } from '../types.js';

/**
 * UserRepository on PostgreSQL.  (M-05)
 *
 * IDENTITY NEVER LEAKS OUTWARDS. Every method takes and returns the EXTERNAL
 * subject (a Firebase uid today, an IdP subject later) and translates through
 * `identity_map` in SQL. `users.id` is an internal uuid that no caller above
 * this boundary ever sees, which is what lets the identity provider change
 * without touching a single consumer - and what stops a Firebase uid being
 * mistaken for a PostgreSQL uuid, which it is not (28 chars, not a uuid).
 *
 * COLUMN PRIVILEGES MATTER HERE. `keyword_hash` is the anti-coercion control,
 * and migration 0006 revoked table-level SELECT on `users` from the client role
 * precisely so it cannot be read. This repository runs as `alehulsh_api`, which
 * does hold it - so the hash must leave this process only as a hash, never
 * logged and never returned in anything client-facing. `UserRecord` carries it
 * because `routes/resolve.ts` must verify against it server-side.
 */

/** A subject that cannot be compared at all. */
function couldBeSubject(subject: string): boolean {
  return subject.length > 0 && !subject.includes('\u0000');
}

interface UserRow {
  keyword_hash: string | null;
  must_set_keyword: boolean;
}

export class PostgresUserRepository implements UserRepository {
  async compareAndSetSafetyKeyword(uid: string, expectedHash: string | null, hash: string): Promise<void> {
    try {
      await this.db.query('SELECT change_safety_keyword($1,$2,$3)', [uid, expectedHash, hash]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'AL001') throw new IdentityNotMappedError();
      if (code === 'AL002') throw new AppError('conflict');
      throw err;
    }
  }
  /**
   * @param db a Pool, or one transaction's client when the caller owns a
   *   transaction. Never issues BEGIN, COMMIT or ROLLBACK.
   */
  constructor(private readonly db: Queryable,private readonly identifiers?:VerifiedIdentifierSource) {}

  /**
   * Only the two fields the request path needs.
   *
   * Deliberately not `SELECT *`: the row also holds her phone, her home
   * address and her identifier hashes, and a repository that returned them all
   * would put them in reach of every caller that only wanted to know whether
   * she has set a keyword.
   */
  async findByUid(uid: string): Promise<UserRecord | null> {
    if (!couldBeSubject(uid)) return null;

    const { rows } = await this.db.query<UserRow>(
      `SELECT u.keyword_hash, u.must_set_keyword
         FROM users u
         JOIN identity_map m ON m.user_id = u.id
        WHERE m.firebase_uid = $1`,
      [uid],
    );
    const row = rows[0];
    if (!row) return null;

    return {
      uid,
      safetyKeywordHash: row.keyword_hash,
      mustSetKeyword: row.must_set_keyword === true,
    };
  }

  /**
   * Resolve a peppered identifier hash to an account.
   *
   * TWO INVARIANTS, both of which the Firestore implementation lacked until a
   * collision was found by test:
   *
   * 1. **Ambiguity is refused, not resolved.** `LIMIT 2`: nothing constrains
   *    these columns to be unique, so taking the first row would hand an
   *    arbitrary winner. An attacker who got his victim's contact's hash into
   *    his own profile could be resolved as that contact - the audience tier
   *    that receives EXACT coordinates - and because the loser is simply not
   *    returned, the real contact would never be notified. Returning null
   *    withholds the tier from the impostor.
   * 2. **A hash only counts if the identifier was VERIFIED.** The schema
   *    already enforces this for phones -
   *    `CHECK (phone_hash IS NULL OR phone_verified_at IS NOT NULL)` in
   *    0001 - so a phone_hash cannot exist unverified. The predicate is
   *    restated here so the guarantee is visible at the point of use rather
   *    than only in a constraint three files away.
   *
   * Domain separation is in the hash itself (`hashIdentifier` prefixes
   * `phone:` / `email:`), so one query over both columns cannot cross-match.
   */
  async findUidByIdentifierHash(hash: string): Promise<string | null> {
    if (hash.length === 0) return null;

    const { rows } = await this.db.query<{ firebase_uid: string }>(
      `SELECT m.firebase_uid
         FROM users u
         JOIN identity_map m ON m.user_id = u.id
        WHERE (u.phone_hash = $1 AND u.phone_verified_at IS NOT NULL)
           OR (u.email_hash = $1 AND u.email_verified_at IS NOT NULL)
        LIMIT 2`,
      [hash],
    );

    // Ambiguous: resolving to nobody is strictly safer than resolving to the
    // wrong person. It does not restore the real contact - that needs the
    // duplicate removed - so a caller seeing an unreachable contact is the
    // correct, visible outcome.
    if (rows.length > 1) return null;
    const uid=rows[0]?.firebase_uid;
    if(!uid)return null;
    return !this.identifiers||await this.identifiers.proves(uid,hash)?uid:null;
  }

  /**
   * Store a new keyword hash and clear mustSetKeyword.
   *
   * The plaintext never reaches this layer. Raises IdentityNotMappedError
   * rather than silently writing nothing: a keyword she believes she set, but
   * which was never stored, means she cannot cancel her own alert.
   */
  async setSafetyKeywordHash(uid: string, hash: string): Promise<void> {
    if (!couldBeSubject(uid)) throw new IdentityNotMappedError();
    if (hash.length === 0) throw new Error('refusing to store an empty keyword hash');

    const { rowCount } = await this.db.query(
      `UPDATE users u
          SET keyword_hash = $2, must_set_keyword = false
        WHERE u.id = (SELECT m.user_id FROM identity_map m WHERE m.firebase_uid = $1)`,
      [uid, hash],
    );
    if (rowCount === 0) throw new IdentityNotMappedError();
  }

  /**
   * C-16, her right to erasure.
   *
   * Deletes the user row; `identity_map`, alerts, inbox, acceptances, evidence
   * and contacts all cascade from it (0001). Returns 0 for an unknown subject
   * rather than throwing, because erasing something already gone is success.
   *
   * What does NOT cascade, by design: `alert_history` and `reveal_log` have no
   * foreign key, because a record of what a third party was shown protects
   * HER. Their retention is an open decision and is deliberately not made
   * here.
   */
  async deleteByUid(uid: string): Promise<number> {
    if (!couldBeSubject(uid)) return 0;

    const { rowCount } = await this.db.query(
      `DELETE FROM users
        WHERE id = (SELECT m.user_id FROM identity_map m WHERE m.firebase_uid = $1)`,
      [uid],
    );
    return rowCount ?? 0;
  }
}

import type { ContactRepository, UserRepository } from '../repositories/types.js';

/**
 * Resolves an alert owner's emergency contacts to reachable accounts.  (P2-09)
 *
 * Replaces emergency_ping_service.dart:160-179, which compared names, emails
 * and phone numbers as strings on the device — which is why every alert
 * document carried its owner's entire support network in the clear (CRIT-02).
 */
export interface ResolvedContact {
  contactId: string;
  name: string;
  isPrimary: boolean;
  /** null when the contact has no account — most of them, at launch. */
  uid: string | null;
}

export class ContactMatcher {
  constructor(
    private readonly contacts: ContactRepository,
    private readonly users: UserRepository,
  ) {}

  /**
   * Every contact is returned, reachable or not. The unreachable ones are not
   * an error to swallow — P3-01 §6 requires showing her which contacts we can
   * actually reach, and P3-04 escalates immediately rather than waiting out a
   * timer when there was never anything to wait for.
   */
  async resolveForOwner(ownerUid: string): Promise<ResolvedContact[]> {
    const rows = await this.contacts.listByOwner(ownerUid);

    return Promise.all(rows.map(async (c): Promise<ResolvedContact> => {
      // Phone first: it is the identifier people actually keep.
      const uid =
        (c.phoneHash ? await this.users.findUidByIdentifierHash(c.phoneHash) : null) ??
        (c.emailHash ? await this.users.findUidByIdentifierHash(c.emailHash) : null);

      return {
        contactId: c.id,
        name: c.name,
        isPrimary: c.isPrimary,
        // Never let her own account count as her own emergency contact — she
        // would be notified of her own alert, and it would inflate the
        // "contacts reached" count that P3-01 §3 says must mean something.
        uid: uid === ownerUid ? null : uid,
      };
    }));
  }

  /** Convenience for the fan-out: just the accounts we can actually push to. */
  async reachableUids(ownerUid: string): Promise<string[]> {
    const resolved = await this.resolveForOwner(ownerUid);
    return [...new Set(resolved.map((r) => r.uid).filter((u): u is string => u !== null))];
  }
}

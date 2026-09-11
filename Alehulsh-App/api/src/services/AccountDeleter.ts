import type { Logger } from '../logger.js';
import type { DeletableStore } from '../repositories/types.js';

/**
 * Account deletion.  (P2-20 · C-16 Art 24-32)
 *
 * For this product this is not a compliance checkbox. A woman whose partner has
 * found the app on her phone needs her data gone, and needs it gone quickly.
 * Treat latency here as a safety property, not an SLA.
 *
 * The failure mode that matters is partial deletion that reports success. She
 * is told her data is gone, it is not, and she has no way to discover that. So:
 * every store reports a count, failures are collected rather than thrown, and
 * anything short of complete is reported as incomplete.
 */
export interface DeletionReceipt {
  uid: string;
  completedAt: Date;
  /** store name -> records removed */
  purged: Record<string, number>;
  /** store name -> error. Empty means the deletion was complete. */
  failed: Record<string, string>;
  complete: boolean;
}

export class AccountDeleter {
  constructor(
    private readonly stores: readonly DeletableStore[],
    private readonly logger: Logger,
  ) {
    if (stores.length === 0) {
      // A deleter with nothing registered would silently "succeed" at deleting
      // nothing, which is the exact failure this class exists to prevent.
      throw new Error('AccountDeleter requires at least one store');
    }
  }

  async deleteAccount(uid: string): Promise<DeletionReceipt> {
    const purged: Record<string, number> = {};
    const failed: Record<string, string> = {};

    // Sequential, not parallel. Ordering matters: evidence and alerts go before
    // the account record, so a failure part-way never leaves orphaned data
    // belonging to a user who no longer exists and can no longer be found.
    for (const store of this.stores) {
      try {
        purged[store.name] = await store.purge(uid);
      } catch (err) {
        // Collected, not thrown. One failing store must not prevent the others
        // from running — less of her data left behind is strictly better.
        failed[store.name] = err instanceof Error ? err.message : String(err);
      }
    }

    const complete = Object.keys(failed).length === 0;
    const receipt: DeletionReceipt = { uid, completedAt: new Date(), purged, failed, complete };

    // uid is logged deliberately: after deletion it is the only remaining
    // handle on what happened, and it no longer identifies a living account.
    if (complete) {
      this.logger.info('account deleted', { uid, purged });
    } else {
      // Loud. Something of hers is still on our systems and she may believe
      // otherwise.
      this.logger.error('account deletion INCOMPLETE', { uid, purged, failed });
    }

    return receipt;
  }
}

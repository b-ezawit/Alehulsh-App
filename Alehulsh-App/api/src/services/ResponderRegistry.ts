import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ResponderRecord, ResponderRepository } from '../repositories/types.js';

/**
 * Responder eligibility by peer vouching.  (P4-07 · P4-08)
 *
 * Replaces "check the gender they entered", which offered a predator a box to
 * tick. A vouch offers him a person who has to be willing to answer for him.
 *
 * This is accountability, not verification. It does not prove anyone is who
 * they say they are. What it does is make admitting someone cost the admitter
 * something, and make the chain traceable afterwards — which a self-declared
 * field never did.
 */
export class ResponderRegistry {
  constructor(
    private readonly responders: ResponderRepository,
    private readonly maxVouches: number,
    private readonly logger: Logger,
  ) {}

  /**
   * THE predicate the fan-out asks (P2-05). Deliberately the narrowest possible
   * question: not "is this a user?" but "has a named person staked their own
   * account on this one?"
   */
  async isEligible(uid: string): Promise<boolean> {
    const r = await this.responders.findByUid(uid);
    return r?.status === 'active';
  }

  /**
   * The founding set. They have nobody to vouch for them, so they are named
   * explicitly rather than being whoever signed up first.
   */
  async bootstrap(uid: string): Promise<ResponderRecord> {
    const existing = await this.responders.findByUid(uid);
    if (existing) throw new AppError('conflict', `${uid} is already a responder`);
    this.logger.info('responder bootstrapped', { uid });
    return this.responders.upsert({
      uid, status: 'active', vouchedBy: null, vouchedAt: null, activatedAt: new Date(),
    });
  }

  async vouchFor(voucherUid: string, candidateUid: string): Promise<ResponderRecord> {
    if (voucherUid === candidateUid) {
      // Otherwise the whole mechanism is a self-service form.
      throw new AppError('invalid_request', 'cannot vouch for yourself');
    }

    const voucher = await this.responders.findByUid(voucherUid);
    if (voucher?.status !== 'active') {
      // A suspended or pending voucher has nothing to stake.
      throw new AppError('forbidden', `${voucherUid} is not an active responder`);
    }

    const existing = await this.responders.findByUid(candidateUid);
    if (existing && existing.status !== 'needs_revouch') {
      throw new AppError('conflict', `${candidateUid} already has responder status`);
    }

    // Uncapped, one account could grow an arbitrary network and the
    // accountability would thin to nothing.
    const used = await this.responders.countActiveVouchesBy(voucherUid);
    if (used >= this.maxVouches) {
      throw new AppError('forbidden', `${voucherUid} has reached the vouch limit`);
    }

    this.logger.info('responder vouched', { voucher: voucherUid, candidate: candidateUid });
    return this.responders.upsert({
      uid: candidateUid, status: 'pending', vouchedBy: voucherUid, vouchedAt: new Date(),
    });
  }

  /**
   * The candidate accepts. Being vouched for is not the same as agreeing to
   * receive other people's emergencies — she has to opt in herself.
   */
  async acceptVouch(candidateUid: string): Promise<ResponderRecord> {
    const r = await this.responders.findByUid(candidateUid);
    if (!r) throw new AppError('not_found', `${candidateUid} has no vouch`);
    if (r.status !== 'pending') {
      throw new AppError('conflict', `${candidateUid} is ${r.status}, not pending`);
    }
    this.logger.info('responder activated', { uid: candidateUid });
    return this.responders.upsert({ ...r, status: 'active', activatedAt: new Date() });
  }

  /**
   * Suspend for cause, and cascade.
   *
   * Cascade is ONE LEVEL, to `needs_revouch` rather than `suspended`. The
   * people this person admitted have not been accused of anything — they have
   * lost the thing that vouched for them. Cascading transitively would suspend
   * strangers several removes from the actual problem, and cascading to
   * `suspended` would record an accusation we cannot support.
   */
  async suspend(uid: string, reason: string): Promise<{ suspended: string; cascaded: string[] }> {
    const r = await this.responders.findByUid(uid);
    if (!r) throw new AppError('not_found', `${uid} is not a responder`);

    const now = new Date();
    await this.responders.upsert({
      ...r, status: 'suspended', suspendedAt: now, suspensionReason: reason,
    });

    const downstream = await this.responders.findVouchedBy(uid);
    const cascaded: string[] = [];
    for (const d of downstream) {
      if (d.status === 'suspended') continue;     // already actioned on their own account
      await this.responders.upsert({ ...d, status: 'needs_revouch' });
      cascaded.push(d.uid);
    }

    this.logger.warn('responder suspended', { uid, reason, cascadedCount: cascaded.length });
    return { suspended: uid, cascaded };
  }
}

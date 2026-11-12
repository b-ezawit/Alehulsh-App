import { AppError } from '../errors.js';

export class KeywordCapacityError extends AppError {
  constructor() { super('rate_limited'); }
}

/** One memory-heavy derivation at a time per runtime; bounded waiting only.
 * This protects isolate memory, not a global cross-replica abuse quota. */
export class KeywordAdmission {
  private active = false;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly maxWaiting = 4) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) {
      if (this.waiting.length >= this.maxWaiting) throw new KeywordCapacityError();
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else this.active = true;
    try { return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active = false;
    }
  }
}
export const keywordAdmission = new KeywordAdmission();

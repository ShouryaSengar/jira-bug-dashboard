// Workers Free allows 50 subrequests per invocation, and D1 queries count towards them.
// Every outgoing call in the monitor goes through a Budget so a run can stop cleanly before the limit
// and resume next minute, instead of failing half way.

export class BudgetExhausted extends Error {
  constructor() {
    super('Subrequest budget exhausted for this run');
  }
}

export class Budget {
  used = 0;
  constructor(public readonly size: number) {}
  get left(): number {
    return this.size - this.used;
  }
  has(n: number): boolean {
    return this.left >= n;
  }
  take(n = 1): void {
    if (this.used + n > this.size) throw new BudgetExhausted();
    this.used += n;
  }
}

/** A budget large enough that request handlers never hit it (they have their own 50-call limit). */
export const unlimited = (): Budget => new Budget(1_000);

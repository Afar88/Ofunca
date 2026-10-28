// One on-device model can only do one thing at a time. This lock decides who goes next (v1.0.16):
//  - Ask (priority 2) always goes before quiz questions (priority 1). If a quiz question is being written when a
//    question is asked, that quiz question is stopped (preempted) and written again right after the answer.
//  - Snap notes (priority 3) needs the tutor model out of memory for a moment; it waits for an answer that is being
//    written, but stops a quiz question.
// Pure TypeScript, so it is tested in node (scripts/check-quiz.ts).

export class Preempted extends Error {
  constructor() {
    super('Paused for a higher-priority request');
  }
}
export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

type Waiter = { pri: number; seq: number; resolve: () => void; reject: (e: Error) => void; preempt?: () => void };

export class PriorityLock {
  private holder: { pri: number; preempt?: () => void } | null = null;
  private waiters: Waiter[] = [];
  private seq = 0;

  get busy() {
    return !!this.holder;
  }
  get holderPriority() {
    return this.holder?.pri ?? 0;
  }
  /** True when someone with a higher priority than `pri` is waiting (a quiz checks this between questions). */
  higherWaiting(pri: number) {
    return this.waiters.some((w) => w.pri > pri);
  }

  /** Waits for the lock. `preempt` is called if a higher-priority request arrives while we hold it.
   *  Returns [release, cancelWait]. cancelWait rejects a still-waiting acquire with Cancelled. */
  acquire(pri: number, preempt?: () => void): { ready: Promise<() => void>; cancel: () => void } {
    let release!: () => void;
    let done = false;
    const mkRelease = () => () => {
      if (done) return;
      done = true;
      this.holder = null;
      this.next();
    };
    if (!this.holder && !this.waiters.length) {
      this.holder = { pri, preempt };
      release = mkRelease();
      return { ready: Promise.resolve(release), cancel: () => {} };
    }
    let me: Waiter | null = null;
    const ready = new Promise<() => void>((resolve, reject) => {
      me = {
        pri,
        seq: this.seq++,
        preempt,
        resolve: () => resolve(mkRelease()),
        reject,
      };
      this.waiters.push(me);
      this.waiters.sort((a, b) => b.pri - a.pri || a.seq - b.seq);
    });
    if (this.holder && pri > this.holder.pri) {
      try {
        this.holder.preempt?.();
      } catch {}
    }
    return {
      ready,
      cancel: () => {
        const i = me ? this.waiters.indexOf(me) : -1;
        if (i >= 0) {
          this.waiters.splice(i, 1);
          me!.reject(new Cancelled());
        }
      },
    };
  }

  private next() {
    const w = this.waiters.shift();
    if (!w) return;
    this.holder = { pri: w.pri, preempt: w.preempt };
    w.resolve();
  }

  /** Runs fn while holding the lock. */
  async run<T>(pri: number, fn: () => Promise<T>, preempt?: () => void): Promise<T> {
    const release = await this.acquire(pri, preempt).ready;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const PRI = { quiz: 1, ask: 2, exclusive: 3 } as const;

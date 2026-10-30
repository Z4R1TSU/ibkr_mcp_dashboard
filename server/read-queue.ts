interface Job { priority: boolean; run(): Promise<void> }

/** One IB operation at a time; account reads precede queued background work. */
export class ReadQueue {
  private jobs: Job[] = [];
  private active = false;
  run<T>(action: () => Promise<T>, signal: AbortSignal, priority = false): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = this.jobs.indexOf(job);
        if (index >= 0) { this.jobs.splice(index, 1); reject(signal.reason); }
      };
      const job: Job = { priority, run: async () => {
        signal.removeEventListener('abort', cancel);
        try { signal.throwIfAborted(); resolve(await action()); }
        catch (error) { reject(error); }
      } };
      this.jobs.push(job);
      signal.addEventListener('abort', cancel, { once: true });
      void this.drain();
    });
  }
  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.jobs.length) {
        const priority = this.jobs.findIndex(job => job.priority);
        const [job] = this.jobs.splice(priority < 0 ? 0 : priority, 1);
        await job.run();
      }
    } finally { this.active = false; }
  }
}

/** Cancelling one reader must not cancel a shared OAuth token rotation. */
export function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

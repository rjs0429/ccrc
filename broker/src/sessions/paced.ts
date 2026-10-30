export interface Paced {
  run(): void;
  stop(): void;
}

// Runs `job` once per call, one run at a time, and never sooner than `factor` times the last run's length after it
// ended. Calls that come meanwhile make one run when that time is up.
export function paced(job: () => unknown, factor: number, now: () => number = Date.now): Paced {
  let running = false;
  let again = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let readyAt = 0;
  const start = () => {
    timer = undefined;
    running = true;
    const began = now();
    void Promise.resolve()
      .then(job)
      .catch(() => {})
      .finally(() => {
        running = false;
        const ended = now();
        readyAt = ended + factor * (ended - began);
        if (again) {
          again = false;
          run();
        }
      });
  };
  const run = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    if (timer) return;
    const wait = readyAt - now();
    if (wait <= 0) return start();
    timer = setTimeout(start, wait);
    timer.unref();
  };
  return {
    run,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

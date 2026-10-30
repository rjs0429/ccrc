// Runs at most `size` jobs at a time in the order they came, except that a waiting job for the key `first` names goes
// ahead of the others.
export class ReadQueue {
  private size: number;
  private first: () => string | null | undefined;
  private running = 0;
  private waiting: { key: string; start: () => void }[] = [];

  constructor(size: number, first: () => string | null | undefined = () => undefined) {
    this.size = size;
    this.first = first;
  }

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        Promise.resolve()
          .then(job)
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.next();
          });
      };
      this.waiting.push({ key, start });
      this.next();
    });
  }

  private next(): void {
    while (this.running < this.size && this.waiting.length) {
      const want = this.first();
      const i = Math.max(0, this.waiting.findIndex((w) => w.key === want));
      this.waiting.splice(i, 1)[0].start();
    }
  }
}

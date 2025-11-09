/**
 * Bounded async queue with backpressure, waiter handling, and graceful close; used by multiple connector implementations.
 */
export class QueueFullError extends Error {
  constructor(message = 'Receive queue is full') {
    super(message);
    this.name = 'QueueFullError';
  }
}

export class BoundedAsyncQueue<T> {
  private readonly queue: T[] = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private closeError: unknown;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('Queue capacity must be a positive integer');
    }
  }

  enqueue(item: T): void {
    if (this.closed) {
      return;
    }

    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as {
        resolve: (value: T) => void;
        reject: (reason?: unknown) => void;
      };
      waiter.resolve(item);
      return;
    }

    if (this.queue.length >= this.capacity) {
      throw new QueueFullError();
    }

    this.queue.push(item);
  }

  async dequeue(): Promise<T> {
    if (this.closed) {
      throw this.closeError ?? new Error('Queue closed');
    }

    if (this.queue.length > 0) {
      return this.queue.shift() as T;
    }

    return await new Promise<T>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  drain(error?: unknown): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.closeError = error ?? new Error('Queue closed');

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as {
        resolve: (value: T) => void;
        reject: (reason?: unknown) => void;
      };
      waiter.reject(this.closeError);
    }

    this.queue.length = 0;
  }

  get remainingCapacity(): number {
    return Math.max(this.capacity - this.queue.length, 0);
  }
}

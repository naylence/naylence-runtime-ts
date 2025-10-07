import { TaskCancelledError } from './task-types.js';

interface Waiter {
  complete: () => void;
  abort: () => void;
}

/**
 * Lightweight async event primitive similar to Python's asyncio.Event.
 */
export class AsyncEvent {
  private _isSet = false;
  private readonly waiters = new Set<Waiter>();

  set(): void {
    if (this._isSet) {
      return;
    }
    this._isSet = true;
    const waiters = Array.from(this.waiters);
    this.waiters.clear();
    for (const waiter of waiters) {
      waiter.complete();
    }
  }

  clear(): void {
    this._isSet = false;
  }

  isSet(): boolean {
    return this._isSet;
  }

  async wait(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this._isSet) {
      return;
    }

    const { signal } = options;
    if (signal?.aborted) {
      throw new TaskCancelledError('async-event-wait-aborted');
    }

    return await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        reject(new TaskCancelledError('async-event-wait-aborted'));
      };

      const complete = () => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        this.waiters.delete(waiter);
        resolve();
      };

      const waiter: Waiter = {
        complete,
        abort: onAbort,
      };

      this.waiters.add(waiter);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (this._isSet) {
        complete();
      }
    });
  }
}

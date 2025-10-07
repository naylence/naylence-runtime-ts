export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  public async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.tail;
    this.tail = previous.then(
      () => next,
      () => next
    );

    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export async function withLock<T>(
  lock: AsyncLock,
  operation: () => Promise<T> | T
): Promise<T> {
  return await lock.runExclusive(operation);
}

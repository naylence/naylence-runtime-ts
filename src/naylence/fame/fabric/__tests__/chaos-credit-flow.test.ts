import {
  createFameEnvelope,
  formatAddress,
  serializeEnvelope,
  type DataFrame,
  type DeliveryAckFrame,
  type FameEnvelope,
} from 'naylence-core';

import { DefaultDeliveryTrackerFactory } from '../../delivery/default-delivery-tracker-factory.js';
import { InProcessFameFabric } from '../in-process-fame-fabric.js';
import { FameNode } from '../../node/node.js';
import { NODE_META_NAMESPACE, NodeMetaRecord } from '../../node/node-meta.js';
import { InMemorySinkService } from '../../service/in-memory-sink-service.js';
import { InMemoryStorageProvider } from '../../storage/in-memory-storage.js';
import type { KeyValueStore } from '../../storage/key-value-store.js';

const MAX_MESSAGES = 32;
const PUBLISH_DELAY_MS = 0;

interface ChaosOptions {
  delay?: DelayStrategy;
  drop?: DropStrategy;
  dup?: DupStrategy;
}

type DelayStrategy = (baseDelaySeconds: number) => number;
type DropStrategy = (rawEnvelope: Uint8Array) => boolean;
type DupStrategy = (rawEnvelope: Uint8Array) => number;

const defaultDelay: DelayStrategy = (base) => base + Math.random() * base * 3;
const noDrop: DropStrategy = () => false;
const noDup: DupStrategy = () => 1;

const DUP_PROBABILITY = 0.2;
const LOSSY_DROP_RATE = 0.01;

const dupWithBurst: DupStrategy = () => {
  if (Math.random() < DUP_PROBABILITY) {
    const duplicateCount = Math.floor(Math.random() * 3) + 1;
    return 1 + duplicateCount;
  }
  return 1;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeFixture() {
  const storageProvider = new InMemoryStorageProvider();
  const nodeMetaStore: KeyValueStore<NodeMetaRecord> =
    await storageProvider.getKeyValueStore(NodeMetaRecord, NODE_META_NAMESPACE);

  const deliveryTrackerFactory = new DefaultDeliveryTrackerFactory();
  const deliveryTracker = await deliveryTrackerFactory.create(null, {
    storageProvider,
  });

  const node = new FameNode({
    requestedLogicals: ['chaos.domain'],
    storageProvider,
    nodeMetaStore,
    deliveryTracker,
    eventListeners: [deliveryTracker],
  });
  await node.start();

  const fabric = new InProcessFameFabric(node);
  await fabric.start();

  const sinkService = new InMemorySinkService({
    bindingManager: node.bindingManager,
    deliver: async (envelope) => {
      await fabric.send(envelope);
    },
  });

  await fabric.serve(sinkService, 'sink');

  const sinkName = formatAddress('chaos', 'chaos.domain');
  const sinkAddress = await sinkService.createSink({
    name: sinkName.toString(),
  });

  return { node, fabric, sinkAddress, sinkService } as const;
}

function isMonotonic(sequence: string[]): boolean {
  const toNumeric = (value: string) => Number.parseInt(value.slice(1), 10);
  return sequence.every((value, index, arr) => {
    if (index === 0) {
      return true;
    }
    return toNumeric(arr[index - 1]) < toNumeric(value);
  });
}

function isNonDecreasing(sequence: string[]): boolean {
  const toNumeric = (value: string) => Number.parseInt(value.slice(1), 10);
  return sequence.every((value, index, arr) => {
    if (index === 0) {
      return true;
    }
    return toNumeric(arr[index - 1]) <= toNumeric(value);
  });
}

async function waitForLength<T>(
  buffer: T[],
  length: number,
  intervalMs = 5
): Promise<void> {
  while (buffer.length < length) {
    await sleep(intervalMs);
  }
}

async function waitForUniqueCount(
  buffer: string[],
  uniqueCount: number,
  intervalMs = 5
): Promise<void> {
  while (new Set(buffer).size < uniqueCount) {
    await sleep(intervalMs);
  }
}

async function waitForQuiescence(
  buffers: string[][],
  {
    checkIntervalMs = 25,
    idleIterations = 6,
    timeoutMs = 2000,
  }: {
    checkIntervalMs?: number;
    idleIterations?: number;
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const lengths = buffers.map((buffer) => buffer.length);
  const start = Date.now();
  let idleCount = 0;

  while (Date.now() - start < timeoutMs && idleCount < idleIterations) {
    await sleep(checkIntervalMs);

    let changed = false;
    for (let i = 0; i < buffers.length; i += 1) {
      const currentLength = buffers[i].length;
      if (currentLength !== lengths[i]) {
        lengths[i] = currentLength;
        changed = true;
      }
    }

    idleCount = changed ? 0 : idleCount + 1;
  }
}

async function withChaos<T>(
  fabric: InProcessFameFabric,
  options: ChaosOptions,
  action: () => Promise<T>
): Promise<T> {
  const restore = injectChaos(fabric, options);
  try {
    return await action();
  } finally {
    restore();
  }
}

function injectChaos(
  fabric: InProcessFameFabric,
  options: ChaosOptions
): () => void {
  const delay = options.delay ?? defaultDelay;
  const drop = options.drop ?? noDrop;
  const dup = options.dup ?? noDup;

  const originalSend = fabric.send.bind(fabric);

  const encoder = new TextEncoder();

  (fabric as unknown as { send: typeof originalSend }).send = async (
    envelope: FameEnvelope,
    timeoutMs?: number | null
  ): Promise<DeliveryAckFrame | null> => {
    const serialized = serializeEnvelope(envelope);
    const raw = encoder.encode(JSON.stringify(serialized));

    if (drop(raw)) {
      return null;
    }

    const duplicates = Math.max(dup(raw), 0);
    if (duplicates === 0) {
      return null;
    }

    let lastAck: DeliveryAckFrame | null = null;
    for (let i = 0; i < duplicates; i += 1) {
      const jitterSeconds = Math.max(delay(0.001), 0);
      if (jitterSeconds > 0) {
        await sleep(jitterSeconds * 1000);
      }
      lastAck = await originalSend(envelope, timeoutMs ?? undefined);
    }
    return lastAck;
  };

  return () => {
    (fabric as unknown as { send: typeof originalSend }).send = originalSend;
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

const SCENARIOS: Array<{ nMsgs: number; nClients: number }> = [
  { nMsgs: 1, nClients: 1 },
  { nMsgs: 4, nClients: 2 },
  { nMsgs: 8, nClients: 3 },
  { nMsgs: 16, nClients: 4 },
  { nMsgs: MAX_MESSAGES, nClients: 2 },
  { nMsgs: MAX_MESSAGES, nClients: 4 },
];

const DUPLICATE_SCENARIOS: Array<{ nMsgs: number; nClients: number }> = [
  { nMsgs: 4, nClients: 1 },
  { nMsgs: 8, nClients: 2 },
  { nMsgs: 16, nClients: 3 },
  { nMsgs: MAX_MESSAGES, nClients: 4 },
];

const LOSSY_SCENARIOS: Array<{ nMsgs: number; nClients: number }> = [
  { nMsgs: 48, nClients: 2 },
  { nMsgs: 80, nClients: 4 },
  { nMsgs: 96, nClients: 6 },
  { nMsgs: 128, nClients: 8 },
];

describe('chaos credit flow', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeAll(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleSpy.mockRestore();
  });
  describe('sink stress scenarios', () => {
    it('delivers 1k messages to 100 subscribers within deterministic timeout', async () => {
      const messageCount = 1000;
      const subscriberCount = 100;

      const { node, fabric, sinkAddress, sinkService } = await makeFixture();

      try {
        const results: string[][] = Array.from(
          { length: subscriberCount },
          () => []
        );

        for (let idx = 0; idx < subscriberCount; idx += 1) {
          const subscriberAddress = await node.listen(
            `stress-subscriber-${idx}`,
            async (envelope) => {
              const frame = envelope.frame as DataFrame | undefined;
              if (!frame || frame.type !== 'Data') {
                return null;
              }
              results[idx].push(String(frame.payload));
              return null;
            }
          );

          await sinkService.subscribe({
            sinkAddress: sinkAddress.toString(),
            subscriberAddress: subscriberAddress.toString(),
          });
        }

        const startTime = performance.now();

        for (let i = 0; i < messageCount; i += 1) {
          const frame: DataFrame = {
            type: 'Data',
            payload: `data-${i}`,
          };

          const envelope = createFameEnvelope({
            frame,
            to: sinkAddress.toString(),
          });

          await fabric.send(envelope);
        }

        const deadlineMs = 60_000;
        await withTimeout(
          (async () => {
            while (results.some((buffer) => buffer.length < messageCount)) {
              await sleep(10);
            }
          })(),
          deadlineMs
        );

        const elapsed = performance.now() - startTime;
        consoleSpy.mock.calls.push([
          `Fame sink stress finished: ${messageCount} messages × ${subscriberCount} subscribers in ${(elapsed / 1000).toFixed(2)}s`,
        ]);

        for (let idx = 0; idx < subscriberCount; idx += 1) {
          expect(results[idx].length).toBe(messageCount);
        }
      } finally {
        await sinkService.stop();
        await fabric.stop();
        await node.stop();
      }
    });
  });

  it.each(SCENARIOS)(
    'delivers $nMsgs messages to $nClients subscribers without loss, duplicates, or reordering',
    async ({ nMsgs, nClients }) => {
      const { node, fabric, sinkAddress, sinkService } = await makeFixture();

      try {
        const results: string[][] = Array.from({ length: nClients }, () => []);

        for (let idx = 0; idx < nClients; idx += 1) {
          const subscriberAddress = await node.listen(
            `sink-subscriber-${idx}`,
            async (envelope) => {
              const frame = envelope.frame as DataFrame | undefined;
              if (!frame || frame.type !== 'Data') {
                return null;
              }
              results[idx].push(String(frame.payload));
              return null;
            }
          );

          await sinkService.subscribe({
            sinkAddress: sinkAddress.toString(),
            subscriberAddress: subscriberAddress.toString(),
          });
        }

        const publisher = async () => {
          for (let i = 0; i < nMsgs; i += 1) {
            const frame: DataFrame = {
              type: 'Data',
              payload: `#${i}`,
            };

            const envelope = createFameEnvelope({
              frame,
              to: sinkAddress.toString(),
            });

            await fabric.send(envelope);

            if (PUBLISH_DELAY_MS > 0) {
              await sleep(PUBLISH_DELAY_MS);
            }
          }
        };

        await withChaos(
          fabric,
          {
            delay: defaultDelay,
            drop: noDrop,
            dup: noDup,
          },
          async () => {
            await publisher();

            const waitAll = Promise.all(
              results.map((buffer) => waitForLength(buffer, nMsgs))
            );
            const timeoutMs = 1000 + nMsgs * 20;
            await withTimeout(waitAll, timeoutMs);
          }
        );

        const expectedSequence = Array.from(
          { length: nMsgs },
          (_, i) => `#${i}`
        );

        for (const buffer of results) {
          expect(buffer).toHaveLength(nMsgs);
          expect(new Set(buffer).size).toBe(buffer.length);
          expect(buffer).toEqual(expectedSequence);
          expect(isMonotonic(buffer)).toBe(true);
        }
      } finally {
        await sinkService.stop();
        await fabric.stop();
        await node.stop();
      }
    }
  );

  it.each(DUPLICATE_SCENARIOS)(
    'delivers $nMsgs messages to $nClients subscribers while tolerating duplicate bursts',
    async ({ nMsgs, nClients }) => {
      const { node, fabric, sinkAddress, sinkService } = await makeFixture();

      try {
        const results: string[][] = Array.from({ length: nClients }, () => []);

        for (let idx = 0; idx < nClients; idx += 1) {
          const subscriberAddress = await node.listen(
            `dup-subscriber-${idx}-${nMsgs}`,
            async (envelope) => {
              const frame = envelope.frame as DataFrame | undefined;
              if (!frame || frame.type !== 'Data') {
                return null;
              }
              results[idx].push(String(frame.payload));
              return null;
            }
          );

          await sinkService.subscribe({
            sinkAddress: sinkAddress.toString(),
            subscriberAddress: subscriberAddress.toString(),
          });
        }

        const publisher = async () => {
          for (let i = 0; i < nMsgs; i += 1) {
            const frame: DataFrame = {
              type: 'Data',
              payload: `#${i}`,
            };

            const envelope = createFameEnvelope({
              frame,
              to: sinkAddress.toString(),
            });

            await fabric.send(envelope);

            if (PUBLISH_DELAY_MS > 0) {
              await sleep(PUBLISH_DELAY_MS);
            }
          }
        };

        await withChaos(
          fabric,
          {
            delay: defaultDelay,
            drop: noDrop,
            dup: dupWithBurst,
          },
          async () => {
            await publisher();

            const waitAll = Promise.all(
              results.map((buffer) => waitForUniqueCount(buffer, nMsgs))
            );
            const timeoutMs = 1500 + nMsgs * 30;
            await withTimeout(waitAll, timeoutMs);
          }
        );

        const expectedSet = new Set(
          Array.from({ length: nMsgs }, (_, i) => `#${i}`)
        );

        for (const buffer of results) {
          const payloadSet = new Set(buffer);
          expect(payloadSet).toEqual(expectedSet);
          expect(buffer.length).toBeGreaterThanOrEqual(nMsgs);
          expect(isNonDecreasing(buffer)).toBe(true);
        }
      } finally {
        await sinkService.stop();
        await fabric.stop();
        await node.stop();
      }
    }
  );

  it.each(LOSSY_SCENARIOS)(
    'delivers $nMsgs messages to $nClients subscribers within 1% loss tolerance',
    async ({ nMsgs, nClients }) => {
      const { node, fabric, sinkAddress, sinkService } = await makeFixture();

      try {
        const results: string[][] = Array.from({ length: nClients }, () => []);

        for (let idx = 0; idx < nClients; idx += 1) {
          const subscriberAddress = await node.listen(
            `lossy-subscriber-${idx}-${nMsgs}`,
            async (envelope) => {
              const frame = envelope.frame as DataFrame | undefined;
              if (!frame || frame.type !== 'Data') {
                return null;
              }
              results[idx].push(String(frame.payload));
              return null;
            }
          );

          await sinkService.subscribe({
            sinkAddress: sinkAddress.toString(),
            subscriberAddress: subscriberAddress.toString(),
          });
        }

        const publisher = async () => {
          for (let i = 0; i < nMsgs; i += 1) {
            const frame: DataFrame = {
              type: 'Data',
              payload: `#${i}`,
            };

            const envelope = createFameEnvelope({
              frame,
              to: sinkAddress.toString(),
            });

            await fabric.send(envelope);

            if (PUBLISH_DELAY_MS > 0) {
              await sleep(PUBLISH_DELAY_MS);
            }
          }
        };

        let dropCounter = 0;
        const dropPeriod = Math.max(
          1,
          Math.ceil((1 / LOSSY_DROP_RATE) * Math.max(1, nClients))
        );
        const dropStrategy: DropStrategy = () => {
          dropCounter += 1;
          return dropCounter % dropPeriod === 0;
        };

        await withChaos(
          fabric,
          {
            delay: defaultDelay,
            drop: dropStrategy,
            dup: noDup,
          },
          async () => {
            await publisher();
            await sleep(50);
          }
        );

        await waitForQuiescence(results, {
          checkIntervalMs: 25,
          idleIterations: 6,
          timeoutMs: 2000 + nMsgs * 20,
        });

        const expectedValues = Array.from({ length: nMsgs }, (_, i) => `#${i}`);
        const maxMissing = Math.ceil(nMsgs * LOSSY_DROP_RATE) + 1;

        for (const buffer of results) {
          const payloadSet = new Set(buffer);
          expect(payloadSet.size).toBe(buffer.length);

          const missingCount = expectedValues.filter(
            (value) => !payloadSet.has(value)
          ).length;
          expect(missingCount).toBeLessThanOrEqual(maxMissing);
          expect(isMonotonic(buffer)).toBe(true);
        }
      } finally {
        await sinkService.stop();
        await fabric.stop();
        await node.stop();
      }
    }
  );
});

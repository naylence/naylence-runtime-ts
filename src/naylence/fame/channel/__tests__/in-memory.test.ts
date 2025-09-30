/**
 * Tests for in-memory channel implementations
 *
 * Comprehensive tests to ensure TypeScript functionality matches Python behavior.
 */

import { FameAddress, createFameEnvelope } from "naylence-core";
import {
  InMemoryReadWriteChannel,
  InMemoryBinding,
  InMemoryFanoutBroker,
} from "../in-memory/index.js";
import { TaskTimeoutError } from "../../util/task-types.js";

describe("InMemoryReadWriteChannel", () => {
  let channel: InMemoryReadWriteChannel;

  beforeEach(() => {
    channel = new InMemoryReadWriteChannel();
  });

  afterEach(async () => {
    if (!channel.isClosed) {
      await channel.close();
    }
  });

  describe("Basic Operations", () => {
    it("should send and receive messages", async () => {
      const message = { id: "test-1", data: "Hello World" };

      await channel.send(message);
      const received = await channel.receive();

      expect(received).toEqual(message);
    });

    it("should handle multiple messages in queue", async () => {
      const messages = [
        { id: "msg-1", data: "First" },
        { id: "msg-2", data: "Second" },
        { id: "msg-3", data: "Third" },
      ];

      // Send all messages
      for (const msg of messages) {
        await channel.send(msg);
      }

      // Receive all messages
      const received = [];
      for (let i = 0; i < messages.length; i++) {
        received.push(await channel.receive());
      }

      expect(received).toEqual(messages);
    });

    it("should deliver directly to waiting readers", async () => {
      const message = { id: "direct-1", data: "Direct delivery" };

      // Start receiving before sending (no queue buffering)
      const receivePromise = channel.receive();

      // Send message - should deliver directly to waiting reader
      await channel.send(message);

      const received = await receivePromise;
      expect(received).toEqual(message);
      expect(channel.queueSize).toBe(0);
    });
  });

  describe("Timeout Behavior", () => {
    it("should timeout when no message is available", async () => {
      await expect(channel.receive(100)).rejects.toThrow(TaskTimeoutError);
    });

    it("should respect default timeout configuration", async () => {
      const channelWithTimeout = new InMemoryReadWriteChannel({
        defaultTimeoutMs: 50,
      });

      const start = Date.now();
      await expect(channelWithTimeout.receive()).rejects.toThrow(TaskTimeoutError);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some tolerance
      expect(elapsed).toBeLessThan(100);

      await channelWithTimeout.close();
    });

    it("should handle concurrent readers with timeout", async () => {
      const readers = [channel.receive(100), channel.receive(100), channel.receive(100)];

      await expect(Promise.all(readers)).rejects.toThrow(TaskTimeoutError);
    });
  });

  describe("Queue Size Limits", () => {
    it("should respect maxsize configuration", async () => {
      const limitedChannel = new InMemoryReadWriteChannel({ maxsize: 2 });

      // Fill up the queue
      await limitedChannel.send("msg1");
      await limitedChannel.send("msg2");

      // Third message should fail
      await expect(limitedChannel.send("msg3")).rejects.toThrow("Channel queue is full");

      await limitedChannel.close();
    });

    it("should allow unlimited queue when maxsize is 0", async () => {
      const unlimitedChannel = new InMemoryReadWriteChannel({ maxsize: 0 });

      // Send many messages
      for (let i = 0; i < 100; i++) {
        await unlimitedChannel.send(`msg-${i}`);
      }

      expect(unlimitedChannel.queueSize).toBe(100);

      await unlimitedChannel.close();
    });
  });

  describe("Channel State", () => {
    it("should track queue size correctly", async () => {
      expect(channel.queueSize).toBe(0);
      expect(channel.isEmpty).toBe(true);

      await channel.send("msg1");
      expect(channel.queueSize).toBe(1);
      expect(channel.isEmpty).toBe(false);

      await channel.send("msg2");
      expect(channel.queueSize).toBe(2);

      await channel.receive();
      expect(channel.queueSize).toBe(1);

      await channel.receive();
      expect(channel.queueSize).toBe(0);
      expect(channel.isEmpty).toBe(true);
    });

    it("should track waiting readers", async () => {
      expect(channel.waitingReaders).toBe(0);

      const readers = [channel.receive(), channel.receive()];

      // Wait a bit for promises to start waiting
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(channel.waitingReaders).toBe(2);

      // Send messages to wake up readers
      await channel.send("msg1");
      await channel.send("msg2");

      await Promise.all(readers);
      expect(channel.waitingReaders).toBe(0);
    });
  });

  describe("Channel Lifecycle", () => {
    it("should close and reject pending operations", async () => {
      const readers = [channel.receive(), channel.receive()];

      await channel.close();

      expect(channel.isClosed).toBe(true);
      await expect(Promise.all(readers)).rejects.toThrow("Channel is closed");
    });

    it("should reject operations on closed channel", async () => {
      await channel.close();

      await expect(channel.send("msg")).rejects.toThrow("Channel is closed");
      await expect(channel.receive()).rejects.toThrow("Channel is closed");
      await expect(channel.acknowledge("id")).rejects.toThrow("Channel is closed");
    });

    it("should handle double close gracefully", async () => {
      await channel.close();
      await expect(channel.close()).resolves.not.toThrow();
    });
  });

  describe("Acknowledgment", () => {
    it("should handle acknowledge as no-op", async () => {
      await expect(channel.acknowledge("test-id")).resolves.not.toThrow();
    });
  });
});

describe("InMemoryBinding", () => {
  let binding: InMemoryBinding;
  const testAddress = new FameAddress("test@example.com");

  beforeEach(() => {
    binding = new InMemoryBinding(testAddress);
  });

  afterEach(async () => {
    if (!binding.isClosed) {
      await binding.close();
    }
  });

  describe("Construction", () => {
    it("should create binding with FameAddress", () => {
      expect(binding.address).toBe(testAddress);
      expect(binding.channel).toBeInstanceOf(InMemoryReadWriteChannel);
    });

    it("should create binding from string address", () => {
      const stringBinding = InMemoryBinding.fromAddress("user@service.com");

      expect(stringBinding.address.toString()).toBe("user@service.com");
      expect(stringBinding.channel).toBeInstanceOf(InMemoryReadWriteChannel);

      stringBinding.close();
    });

    it("should create binding with custom channel", () => {
      const customChannel = new InMemoryReadWriteChannel({ maxsize: 10 });
      const customBinding = InMemoryBinding.withChannel(testAddress, customChannel);

      expect(customBinding.channel).toBe(customChannel);

      customBinding.close();
    });
  });

  describe("Operations", () => {
    it("should send and receive through binding", async () => {
      const envelope = createFameEnvelope({
        frame: { type: "Data", payload: "test message" },
      });

      await binding.send(envelope);
      const received = await binding.receive();

      expect(received).toEqual(envelope);
    });

    it("should handle acknowledgment", async () => {
      await expect(binding.acknowledge("test-id")).resolves.not.toThrow();
    });
  });

  describe("State", () => {
    it("should track closed state", async () => {
      expect(binding.isClosed).toBe(false);

      await binding.close();

      expect(binding.isClosed).toBe(true);
    });

    it("should provide serializable object representation", () => {
      const obj = binding.toObject();

      expect(obj).toEqual({
        address: testAddress.toString(),
        channelState: {
          queueSize: 0,
          isClosed: false,
        },
      });
    });

    it("should provide string representation", () => {
      const str = binding.toString();

      expect(str).toContain("InMemoryBinding");
      expect(str).toContain(testAddress.toString());
    });
  });
});

describe("InMemoryFanoutBroker", () => {
  let sinkChannel: InMemoryReadWriteChannel;
  let broker: InMemoryFanoutBroker;
  let subscriber1: InMemoryReadWriteChannel;
  let subscriber2: InMemoryReadWriteChannel;

  beforeEach(() => {
    sinkChannel = new InMemoryReadWriteChannel();
    broker = new InMemoryFanoutBroker(sinkChannel);
    subscriber1 = new InMemoryReadWriteChannel();
    subscriber2 = new InMemoryReadWriteChannel();
  });

  afterEach(async () => {
    if (broker.isRunning) {
      await broker.stop();
    }
    await Promise.all([sinkChannel.close(), subscriber1.close(), subscriber2.close()]);
  });

  describe("Subscriber Management", () => {
    it("should add and remove subscribers", () => {
      expect(broker.subscriberCount).toBe(0);

      broker.addSubscriber(subscriber1);
      expect(broker.subscriberCount).toBe(1);

      broker.addSubscriber(subscriber2);
      expect(broker.subscriberCount).toBe(2);

      broker.removeSubscriber(subscriber1);
      expect(broker.subscriberCount).toBe(1);

      broker.removeSubscriber(subscriber2);
      expect(broker.subscriberCount).toBe(0);
    });

    it("should handle duplicate subscriber addition", () => {
      broker.addSubscriber(subscriber1);
      broker.addSubscriber(subscriber1); // Duplicate

      expect(broker.subscriberCount).toBe(1);
    });

    it("should provide readonly subscriber access", () => {
      broker.addSubscriber(subscriber1);
      broker.addSubscriber(subscriber2);

      const subscribers = broker.subscribers;
      expect(subscribers.size).toBe(2);
      expect(subscribers.has(subscriber1)).toBe(true);
      expect(subscribers.has(subscriber2)).toBe(true);

      // Should be a copy (ReadonlySet), not the original Set
      const subscribersSameRef = broker.subscribers;
      expect(subscribers).not.toBe(subscribersSameRef); // Different instances each time
    });
  });

  describe("Broker Lifecycle", () => {
    it("should start and stop broker", async () => {
      expect(broker.isRunning).toBe(false);

      await broker.start();
      expect(broker.isRunning).toBe(true);

      await broker.stop();
      expect(broker.isRunning).toBe(false);
    });

    it("should handle multiple start calls", async () => {
      await broker.start();
      await broker.start(); // Should not throw

      expect(broker.isRunning).toBe(true);
    });
  });

  describe("Message Distribution", () => {
    beforeEach(async () => {
      broker.addSubscriber(subscriber1);
      broker.addSubscriber(subscriber2);
      await broker.start();
    });

    it("should distribute messages to all subscribers", async () => {
      const envelope = createFameEnvelope({
        frame: { type: "Data", payload: "fanout message" },
      });

      // Send message to sink
      await sinkChannel.send(envelope);

      // Give broker time to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both subscribers should receive the message
      const received1 = await subscriber1.receive(100);
      const received2 = await subscriber2.receive(100);

      expect(received1).toEqual(envelope);
      expect(received2).toEqual(envelope);
    });

    it("should remove failed subscribers", async () => {
      // Close one subscriber to simulate failure
      await subscriber1.close();

      const envelope = createFameEnvelope({
        frame: { type: "Data", payload: "test message" },
      });

      await sinkChannel.send(envelope);

      // Give broker time to process and remove failed subscriber
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Only working subscriber should remain
      expect(broker.subscriberCount).toBe(1);
      expect(broker.subscribers.has(subscriber2)).toBe(true);
      expect(broker.subscribers.has(subscriber1)).toBe(false);
    });
  });

  describe("Configuration", () => {
    it("should use custom poll timeout", () => {
      const customBroker = new InMemoryFanoutBroker(sinkChannel, {
        pollTimeoutMs: 500,
      });

      expect(customBroker.isRunning).toBe(false);

      customBroker.stop(); // Cleanup
    });
  });
});

describe("Integration Tests", () => {
  describe("Binding with Fanout Broker", () => {
    it("should work together in a complete flow", async () => {
      // Set up components
      const sinkChannel = new InMemoryReadWriteChannel();
      const broker = new InMemoryFanoutBroker(sinkChannel);

      const binding1 = InMemoryBinding.fromAddress("service1@example.com");
      const binding2 = InMemoryBinding.fromAddress("service2@example.com");

      // Connect bindings to broker
      broker.addSubscriber(binding1.channel);
      broker.addSubscriber(binding2.channel);

      await broker.start();

      try {
        // Send message through sink
        const envelope = createFameEnvelope({
          frame: { type: "Data", payload: "integration test" },
        });

        await sinkChannel.send(envelope);

        // Give broker time to distribute
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Both bindings should receive the message
        const received1 = await binding1.receive(100);
        const received2 = await binding2.receive(100);

        expect(received1).toEqual(envelope);
        expect(received2).toEqual(envelope);
      } finally {
        // Cleanup
        await broker.stop();
        await sinkChannel.close();
        await binding1.close();
        await binding2.close();
      }
    });
  });
});

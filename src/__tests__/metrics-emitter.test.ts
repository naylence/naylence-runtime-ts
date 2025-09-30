/**
 * Tests for metrics emitter utilities
 */

import {
  NoOpMetricsEmitter,
  ConsoleMetricsEmitter,
  MemoryMetricsEmitter,
} from "../naylence/fame/util/metrics-emitter";

describe("Metrics Emitter", () => {
  describe("NoOpMetricsEmitter", () => {
    let emitter: NoOpMetricsEmitter;

    beforeEach(() => {
      emitter = new NoOpMetricsEmitter();
    });

    it("should implement MetricsEmitter interface", () => {
      expect(emitter).toBeDefined();
      expect(typeof emitter.counter).toBe("function");
      expect(typeof emitter.gauge).toBe("function");
      expect(typeof emitter.histogram).toBe("function");
    });

    it("should silently discard counter metrics", () => {
      expect(() => emitter.counter("test.counter", 1)).not.toThrow();
      expect(() => emitter.counter("test.counter", 5, { tag1: "value1" })).not.toThrow();
    });

    it("should silently discard gauge metrics", () => {
      expect(() => emitter.gauge("test.gauge", 42)).not.toThrow();
      expect(() => emitter.gauge("test.gauge", 100, { env: "test" })).not.toThrow();
    });

    it("should silently discard histogram metrics", () => {
      expect(() => emitter.histogram("test.histogram", 0.5)).not.toThrow();
      expect(() => emitter.histogram("test.histogram", 1.5, { method: "GET" })).not.toThrow();
    });
  });

  describe("ConsoleMetricsEmitter", () => {
    let emitter: ConsoleMetricsEmitter;
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
      emitter = new ConsoleMetricsEmitter();
      consoleSpy = jest.spyOn(console, "log").mockImplementation();
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("should log counter metrics", () => {
      emitter.counter("test.counter", 5);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toMatch(
        /\[METRICS\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z COUNTER test\.counter=5$/
      );
    });

    it("should log gauge metrics with tags", () => {
      emitter.gauge("test.gauge", 42, { env: "production", service: "api" });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toMatch(
        /\[METRICS\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z GAUGE test\.gauge=42 tags={"env":"production","service":"api"}$/
      );
    });

    it("should log histogram metrics", () => {
      emitter.histogram("test.histogram", 1.23);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toMatch(
        /\[METRICS\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z HISTOGRAM test\.histogram=1\.23$/
      );
    });

    it("should use custom prefix", () => {
      const customEmitter = new ConsoleMetricsEmitter("[CUSTOM]");
      customEmitter.counter("test", 1);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toMatch(/^\[CUSTOM\]/);
    });
  });

  describe("MemoryMetricsEmitter", () => {
    let emitter: MemoryMetricsEmitter;

    beforeEach(() => {
      emitter = new MemoryMetricsEmitter();
    });

    it("should start with empty metrics", () => {
      expect(emitter.getMetrics()).toEqual([]);
      expect(emitter.count()).toBe(0);
    });

    it("should record counter metrics", () => {
      emitter.counter("test.counter", 5, { env: "test" });

      const metrics = emitter.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        type: "counter",
        name: "test.counter",
        value: 5,
        tags: { env: "test" },
      });
      expect(metrics[0].timestamp).toBeInstanceOf(Date);
    });

    it("should record gauge metrics without tags", () => {
      emitter.gauge("test.gauge", 42);

      const metrics = emitter.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        type: "gauge",
        name: "test.gauge",
        value: 42,
      });
      expect(metrics[0].tags).toBeUndefined();
    });

    it("should record histogram metrics", () => {
      emitter.histogram("test.histogram", 1.5, { method: "POST" });

      const metrics = emitter.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        type: "histogram",
        name: "test.histogram",
        value: 1.5,
        tags: { method: "POST" },
      });
    });

    it("should record multiple metrics", () => {
      emitter.counter("counter1", 1);
      emitter.gauge("gauge1", 10);
      emitter.histogram("histogram1", 0.5);

      expect(emitter.count()).toBe(3);
      expect(emitter.getMetrics()).toHaveLength(3);
    });

    it("should filter metrics by type", () => {
      emitter.counter("counter1", 1);
      emitter.gauge("gauge1", 10);
      emitter.counter("counter2", 2);

      expect(emitter.getMetricsByType("counter")).toHaveLength(2);
      expect(emitter.getMetricsByType("gauge")).toHaveLength(1);
      expect(emitter.getMetricsByType("histogram")).toHaveLength(0);
    });

    it("should filter metrics by name", () => {
      emitter.counter("test.metric", 1);
      emitter.gauge("test.metric", 10);
      emitter.counter("other.metric", 2);

      expect(emitter.getMetricsByName("test.metric")).toHaveLength(2);
      expect(emitter.getMetricsByName("other.metric")).toHaveLength(1);
      expect(emitter.getMetricsByName("nonexistent")).toHaveLength(0);
    });

    it("should clear all metrics", () => {
      emitter.counter("test", 1);
      emitter.gauge("test", 2);

      expect(emitter.count()).toBe(2);

      emitter.clear();

      expect(emitter.count()).toBe(0);
      expect(emitter.getMetrics()).toEqual([]);
    });
  });
});

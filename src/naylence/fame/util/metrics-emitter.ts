/**
 * Protocol and implementation for emitting metrics such as counters, gauges, and histograms.
 * Implementations should be thread-safe and non-blocking.
 */

/**
 * Optional tags for metrics as key-value pairs.
 */
export type MetricTags = Record<string, string>;

/**
 * Protocol for emitting metrics such as counters, gauges, and histograms.
 * Implementations should be thread-safe and non-blocking.
 */
export interface MetricsEmitter {
  /**
   * Emit a counter metric.
   * @param name The metric name
   * @param value The numeric value to add to the counter
   * @param tags Optional key-value tags for the metric
   */
  counter(name: string, value: number, tags?: MetricTags): void;

  /**
   * Emit a gauge metric.
   * @param name The metric name
   * @param value The current numeric value of the gauge
   * @param tags Optional key-value tags for the metric
   */
  gauge(name: string, value: number, tags?: MetricTags): void;

  /**
   * Emit a histogram metric.
   * @param name The metric name
   * @param value The numeric value to record in the histogram
   * @param tags Optional key-value tags for the metric
   */
  histogram(name: string, value: number, tags?: MetricTags): void;
}

/**
 * A no-op implementation of MetricsEmitter that discards all metrics.
 * Useful for testing or when metrics are disabled.
 */
export class NoOpMetricsEmitter implements MetricsEmitter {
  counter(_name: string, _value: number, _tags?: MetricTags): void {
    // Intentionally empty - discards all metrics
  }

  gauge(_name: string, _value: number, _tags?: MetricTags): void {
    // Intentionally empty - discards all metrics
  }

  histogram(_name: string, _value: number, _tags?: MetricTags): void {
    // Intentionally empty - discards all metrics
  }
}

/**
 * A console-based implementation of MetricsEmitter for debugging.
 * Logs all metrics to the console in a structured format.
 */
export class ConsoleMetricsEmitter implements MetricsEmitter {
  constructor(private readonly prefix: string = '[METRICS]') {}

  counter(name: string, value: number, tags?: MetricTags): void {
    this.logMetric('COUNTER', name, value, tags);
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    this.logMetric('GAUGE', name, value, tags);
  }

  histogram(name: string, value: number, tags?: MetricTags): void {
    this.logMetric('HISTOGRAM', name, value, tags);
  }

  private logMetric(
    type: string,
    name: string,
    value: number,
    tags?: MetricTags
  ): void {
    const timestamp = new Date().toISOString();
    const tagsStr = tags ? ` tags=${JSON.stringify(tags)}` : '';
    console.log(
      `${this.prefix} ${timestamp} ${type} ${name}=${value}${tagsStr}`
    );
  }
}

/**
 * A memory-based implementation of MetricsEmitter for testing.
 * Stores all emitted metrics in memory for inspection.
 */
export class MemoryMetricsEmitter implements MetricsEmitter {
  private readonly metrics: Array<{
    type: 'counter' | 'gauge' | 'histogram';
    name: string;
    value: number;
    tags?: MetricTags;
    timestamp: Date;
  }> = [];

  counter(name: string, value: number, tags?: MetricTags): void {
    this.recordMetric('counter', name, value, tags);
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    this.recordMetric('gauge', name, value, tags);
  }

  histogram(name: string, value: number, tags?: MetricTags): void {
    this.recordMetric('histogram', name, value, tags);
  }

  private recordMetric(
    type: 'counter' | 'gauge' | 'histogram',
    name: string,
    value: number,
    tags?: MetricTags
  ): void {
    this.metrics.push({
      type,
      name,
      value,
      ...(tags && { tags }),
      timestamp: new Date(),
    });
  }

  /**
   * Get all recorded metrics.
   */
  getMetrics() {
    return [...this.metrics];
  }

  /**
   * Get metrics filtered by type.
   */
  getMetricsByType(type: 'counter' | 'gauge' | 'histogram') {
    return this.metrics.filter((m) => m.type === type);
  }

  /**
   * Get metrics filtered by name.
   */
  getMetricsByName(name: string) {
    return this.metrics.filter((m) => m.name === name);
  }

  /**
   * Clear all recorded metrics.
   */
  clear(): void {
    this.metrics.length = 0;
  }

  /**
   * Get the count of recorded metrics.
   */
  count(): number {
    return this.metrics.length;
  }
}

/**
 * Tests for cross-platform logging functionality
 */

import { getLogger, basicConfig, LogLevel } from "../logging.js";
import { withEnvelopeContext } from "../envelope-context.js";

describe("Cross-platform Logging", () => {
  beforeEach(() => {
    // Reset logger configuration for each test
    basicConfig({ level: LogLevel.TRACE });
  });

  test("should create logger and log basic messages", () => {
    const logger = getLogger("test.logger");

    // Should not throw
    expect(() => {
      logger.trace("trace message");
      logger.debug("debug message");
      logger.info("info message");
      logger.warning("warning message");
      logger.error("error message");
      logger.critical("critical message");
    }).not.toThrow();
  });

  test("should support structured logging with extra fields", () => {
    const logger = getLogger("test.structured");

    expect(() => {
      logger.info("user action", { user_id: "123", action: "login" });
      logger.error("operation failed", { error_code: 500, retry_count: 3 });
    }).not.toThrow();
  });

  test("should support child loggers with bindings", () => {
    const parentLogger = getLogger("test.parent");
    const childLogger = parentLogger.child({ component: "auth", version: "1.0" });

    expect(() => {
      childLogger.info("child logger message");
    }).not.toThrow();
  });

  test("should respect log level filtering", () => {
    const logger = getLogger("test.level");
    logger.setLevel(LogLevel.WARNING);

    // These should not cause errors even if internally filtered
    expect(() => {
      logger.trace("should be filtered");
      logger.debug("should be filtered");
      logger.info("should be filtered");
      logger.warning("should appear");
      logger.error("should appear");
    }).not.toThrow();
  });

  test("should inject envelope context into logs", () => {
    const logger = getLogger("test.envelope");
    const envelope = {
      trace_id: "trace-123",
      id: "env-456",
      flow_id: "flow-789",
    };

    expect(() => {
      withEnvelopeContext(envelope, () => {
        logger.info("message with envelope context");
      });
    }).not.toThrow();
  });

  test("should format console output in structlog style for Node environments", () => {
    const fixedDate = new Date("2025-09-28T05:36:00.361Z");
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const logger = getLogger("test.structlog");
    const envelope = {
      trace_id: "trace-123",
      id: "env-456",
      flow_id: "flow-789",
    };

    try {
      withEnvelopeContext(envelope, () => {
        logger.info("message with envelope context", { custom: "value" });
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        "2025-09-28T05:36:00.361Z | INFO    | test.structlog | message with envelope context ctx_envp_id=env-456 ctx_flow_id=flow-789 custom=value trace_id=trace-123"
      );
    } finally {
      consoleSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test("should handle various argument patterns", () => {
    const logger = getLogger("test.args");

    expect(() => {
      logger.info("simple message");
      logger.info("message with object", { key: "value" });
      logger.info("message with args", "arg1", "arg2", 123);
    }).not.toThrow();
  });
});

describe("basicConfig", () => {
  test("should configure logging with different levels", () => {
    expect(() => {
      basicConfig({ level: LogLevel.INFO });
      basicConfig({ level: LogLevel.ERROR });
    }).not.toThrow();
  });

  test("should configure logging with different formats", () => {
    expect(() => {
      basicConfig({ format: "json" });
      basicConfig({ format: "pretty" });
    }).not.toThrow();
  });

  test("should emit JSON output when json format is selected", () => {
    const fixedDate = new Date("2025-09-28T05:36:00.361Z");
    jest.useFakeTimers();
    jest.setSystemTime(fixedDate);

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    basicConfig({ level: LogLevel.INFO, format: "json" });
    const logger = getLogger("test.structlog-json");

    try {
      logger.info("json log", { foo: "bar" });

      expect(consoleSpy).toHaveBeenCalledTimes(1);

      const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(payload).toMatchObject({
        event: "json log",
        foo: "bar",
        level: LogLevel.INFO,
        level_name: "INFO",
        logger: "test.structlog-json",
        timestamp: "2025-09-28T05:36:00.361Z",
      });
    } finally {
      consoleSpy.mockRestore();
      jest.useRealTimers();
      basicConfig({ level: LogLevel.TRACE });
    }
  });
});

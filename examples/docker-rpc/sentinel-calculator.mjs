import {
  RpcMixin,
  operation,
  basicConfig,
  getLogger,
  LogLevel,
  withFabric
} from "naylence-runtime";


const logger = getLogger("examples.sentinel-calculator");

class CalculatorService extends RpcMixin {
  get capabilities() {
    return ["calculator", "math"];
  }

  async add(params) {
    const { a, b } = params;
    const result = a + b;
    logger.info("calculator_add", { a, b, result });
    return result;
  }

  async multiply(params) {
    const { a, b } = params;
    const result = a * b;
    logger.info("calculator_multiply", { a, b, result });
    return result;
  }

  async divide(params) {
    const { a, b } = params;
    if (b === 0) {
      logger.error("calculator_divide_error", { a, b, message: "Division by zero" });
      throw new Error("Division by zero");
    }
    const result = a / b;
    logger.info("calculator_divide", { a, b, result });
    return result;
  }

  async *fib(params) {
    const { n } = params;
    let a = 0;
    let b = 1;

    for (let i = 0; i < n; i += 1) {
      yield a;
      [a, b] = [b, a + b];
    }
  }
}

function applyOperation(decorator, methodName) {
  const descriptor = Object.getOwnPropertyDescriptor(CalculatorService.prototype, methodName);
  if (!descriptor) {
    throw new Error(`Missing property descriptor for ${methodName}`);
  }
  decorator(CalculatorService.prototype, methodName, descriptor);
}

applyOperation(operation(), "add");
applyOperation(operation(), "multiply");
applyOperation(operation(), "divide");
applyOperation(operation({ name: "fib_stream", streaming: true }), "fib");

async function waitForSignals() {
  const signals = ["SIGINT", "SIGTERM"];

  await new Promise((resolve) => {
    const handle = (signal) => {
      logger.info("shutdown_signal_received", { signal });
      for (const sig of signals) {
        process.removeListener(sig, handle);
      }
      resolve();
    };

    for (const sig of signals) {
      process.once(sig, handle);
    }
  });
}

async function main() {
  const logLevelEnv = process.env.SENTINEL_LOG_LEVEL?.toUpperCase();
  const level = (logLevelEnv && LogLevel[logLevelEnv]) || LogLevel.INFO;
  basicConfig({ level });

  await withFabric(async (fabric) => {
    const calculator = new CalculatorService();
    const address = await fabric.serve(calculator, "calculator");

    logger.info("calculator_service_ready", { address: address.toString() });
    logger.debug("calculator_service_registered", {
      services: Array.from(fabric.getLocalServices().keys()).map((entry) => entry.toString()),
    });

    await waitForSignals();
  });
}

try {
  await main();
} catch (error) {
  logger.error("calculator_sentinel_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
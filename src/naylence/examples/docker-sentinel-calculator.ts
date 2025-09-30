import "../fame/sentinel/sentinel-factory.js";
import "../fame/node/node-factory.js";
import "../fame/node/admission/admission-profile-factory.js";
import "../fame/connector/http-listener-factory.js";
import "../fame/connector/websocket-listener-factory.js";
import "../fame/security/node-security-profile-factory.js";
import "../fame/security/default-security-manager-factory.js";
import "../fame/security/policy/no-security-policy-factory.js";
import "../fame/security/policy/default-security-policy-factory.js";
import "../fame/security/auth/noop-authorizer-factory.js";
import "../fame/storage/storage-profile-factory.js";
import "../fame/delivery/delivery-profile-factory.js";
import "../fame/delivery/at-most-once-delivery-policy-factory.js";
import "../fame/storage/in-memory-storage-provider-factory.js";
import "../fame/node/admission/noop-admission-client-factory.js";
import "../fame/security/keys/noop-key-validator-factory.js";
import "../fame/security/keys/in-memory-key-store-factory.js";
import "../fame/security/keys/default-key-manager-factory.js";
import "../fame/sentinel/load-balancing/hrw-load-balancing-strategy-factory.js";
import "../fame/sentinel/load-balancing/random-load-balancing-strategy-factory.js";
import "../fame/sentinel/load-balancing/round-robin-load-balancing-strategy-factory.js";
import "../fame/sentinel/load-balancing/sticky-load-balancing-strategy-factory.js";
import "../fame/sentinel/load-balancing/composite-load-balancing-strategy-factory.js";
import "../fame/sentinel/load-balancing/load-balancing-profile-factory.js";
import "../fame/sentinel/capability-aware-routing-policy-factory.js";
import "../fame/sentinel/composite-routing-policy-factory.js";
import "../fame/sentinel/hybrid-path-routing-policy-factory.js";
import "../fame/sentinel/routing-profile-factory.js";

import { InProcessFameFabric } from "../fame/fabric/in-process-fame-fabric.js";
import { operation, RpcMixin } from "../fame/service/rpc.js";
import { basicConfig, getLogger, LogLevel } from "../fame/util/logging.js";

const logger = getLogger("examples.docker-sentinel-calculator");

interface CalculatorParams {
  a: number;
  b: number;
}

interface FibParams {
  n: number;
}

class CalculatorService extends RpcMixin {
  get capabilities(): string[] {
    return ["calculator", "math"];
  }

  @operation()
  async add(params: CalculatorParams): Promise<number> {
    const { a, b } = params;
    const result = a + b;
    logger.info("calculator_add", { a, b, result });
    return result;
  }

  @operation()
  async multiply(params: CalculatorParams): Promise<number> {
    const { a, b } = params;
    const result = a * b;
    logger.info("calculator_multiply", { a, b, result });
    return result;
  }

  @operation()
  async divide(params: CalculatorParams): Promise<number> {
    const { a, b } = params;
    if (b === 0) {
      logger.error("calculator_divide_error", { a, b, message: "Division by zero" });
      throw new Error("Division by zero");
    }
    const result = a / b;
    logger.info("calculator_divide", { a, b, result });
    return result;
  }

  @operation({ name: "fib_stream", streaming: true })
  async *fib(params: FibParams): AsyncIterable<number> {
    const { n } = params;
    let a = 0;
    let b = 1;

    for (let i = 0; i < n; i += 1) {
      yield a;
      [a, b] = [b, a + b];
    }
  }
}

function createSentinelConfig() {
  const publicUrl = process.env.SENTINEL_PUBLIC_URL ?? "http://localhost:28000";
  const httpPort = Number.parseInt(process.env.SENTINEL_HTTP_PORT ?? "8000", 10);
  const wsPort = Number.parseInt(process.env.SENTINEL_WS_PORT ?? String(httpPort), 10);

  return {
    node: {
      type: "Sentinel",
      id: process.env.SENTINEL_ID ?? "test-sentinel",
      publicUrl,
      listeners: [
        {
          type: "HttpListener",
          host: "0.0.0.0",
          port: httpPort,
        },
        {
          type: "WebSocketListener",
          host: "0.0.0.0",
          port: wsPort,
        },
      ],
      requestedLogicals: ["fame.fabric"],
      security: {
        type: "SecurityProfile",
        profile: "open",
      },
      admission: {
        type: "AdmissionProfile",
        profile: "none",
      },
      storage: {
        type: "StorageProfile",
        profile: "memory",
      },
      delivery: {
        type: "DeliveryProfile",
        profile: "at-most-once",
      },
    },
  } satisfies Record<string, unknown>;
}

async function waitForSignals(): Promise<void> {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  await new Promise<void>((resolve) => {
    const handle = (signal: NodeJS.Signals) => {
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

async function main(): Promise<void> {
  const logLevelEnv = process.env.SENTINEL_LOG_LEVEL?.toUpperCase() as keyof typeof LogLevel | undefined;
  const level = (logLevelEnv && LogLevel[logLevelEnv]) || LogLevel.INFO;
  basicConfig({ level });

  const fabric = new InProcessFameFabric(null, createSentinelConfig());

  await fabric.enter();
  try {
    const calculator = new CalculatorService();
    const address = await fabric.serve(calculator, "calculator");

    logger.info("calculator_service_ready", { address: address.toString() });
    logger.info("sentinel_listeners_ready", {
      http: process.env.SENTINEL_HTTP_PORT ?? "8000",
      ws: process.env.SENTINEL_WS_PORT ?? process.env.SENTINEL_HTTP_PORT ?? "8000",
      publicUrl: process.env.SENTINEL_PUBLIC_URL ?? "http://localhost:28000",
    });

    await waitForSignals();
  } finally {
    await fabric.exit();
  }
}

if (process.argv[1] && process.argv[1].endsWith("docker-sentinel-calculator.js")) {
  // Running from compiled JavaScript entrypoint
  void main().catch((error) => {
    logger.error("calculator_sentinel_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}

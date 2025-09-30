/**
 * Base factory for creating FameConnector instances from either ConnectorConfig or ConnectionGrant.
 *
 * Concrete implementations must define supported grant types and provide grant-to-connector
 * conversion logic.
 */

import type { ResourceConfig, ResourceFactory as BaseResourceFactory } from "naylence-factory";
import { ConnectorConfig } from "./connector-config.js";
import { FameConnector } from "naylence-core";
import { getLogger } from "../util/logging.js";
import type { ConnectionGrant } from "../grants/index.js";
export type { ConnectionGrant } from "../grants/index.js";

const logger = getLogger("connector-factory");

/**
 * Expression evaluation policy enum
 */
export enum ExpressionEvaluationPolicy {
  ERROR = "error",
  EVALUATE = "evaluate",
  SKIP = "skip",
}

/**
 * Base interface for resource factories
 */
export type ResourceFactory<T, C extends ResourceConfig> = BaseResourceFactory<T, C>;

/**
 * Information about a registered factory
 */
export interface FactoryInfo {
  /** The factory type identifier */
  type: string;

  /** The factory constructor */
  constructor: new () => ConnectorFactory;

  /** The factory instance (cached) */
  instance?: ConnectorFactory;

  /** Factory metadata */
  metadata?: {
    isDefault?: boolean;
    priority?: number;
    description?: string;
    [key: string]: unknown;
  };
}

/**
 * Extension manager for dynamic factory discovery
 */
export class ExtensionManager {
  private static factories = new Map<string, FactoryInfo>();

  /**
   * Register a factory class
   */
  public static register(factoryClass: new () => ConnectorFactory): void {
    const instance = new factoryClass();
    this.factories.set(instance.type, {
      type: instance.type,
      constructor: factoryClass,
      instance,
    });
  }

  /**
   * Get extensions by base type
   */
  public static getExtensionsByType(): Map<string, FactoryInfo> {
    return new Map(this.factories);
  }
}

/**
 * Abstract base class for connector factories
 */
export abstract class ConnectorFactory<
  T extends FameConnector = FameConnector,
  C extends ConnectorConfig = ConnectorConfig,
> implements ResourceFactory<T, C>
{
  public abstract readonly type: string;
  public readonly isDefault?: boolean = false;
  public readonly priority?: number = 0;

  /**
   * Return list of connection grant types that this factory can handle.
   */
  public abstract supportedGrantTypes(): string[];

  /**
   * Return mapping of connection grant types to their classes.
   */
  public abstract supportedGrants(): Record<string, new () => ConnectionGrant>;

  /**
   * Create a ConnectorConfig instance from a connection grant or dictionary.
   */
  public abstract configFromGrant(
    grant: ConnectionGrant | Record<string, unknown>,
    expressionEvaluationPolicy?: ExpressionEvaluationPolicy
  ): C;

  /**
   * Create a ConnectionGrant instance from a connector config or dictionary.
   */
  public abstract grantFromConfig(
    config: C | Record<string, unknown>,
    expressionEvaluationPolicy?: ExpressionEvaluationPolicy
  ): ConnectionGrant;

  /**
   * Create a connector instance from the provided configuration.
   */
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...kwargs: unknown[]
  ): Promise<T>;

  /**
   * Evaluate a grant dictionary and return a typed ConnectionGrant instance.
   */
  public static evaluateGrant(grant: Record<string, unknown>): ConnectionGrant {
    const grantType = grant.type;
    if (!grantType || typeof grantType !== "string") {
      throw new Error("Missing 'type' field in grant");
    }

    const factories = ExtensionManager.getExtensionsByType();

    for (const [, factoryInfo] of factories) {
      try {
        const factory = factoryInfo.instance || new factoryInfo.constructor();
        const supportedGrants = factory.supportedGrants();
        const grantClass = supportedGrants[grantType];

        if (grantClass) {
          const grantPurpose = grant.purpose;
          const evaluatedConfig = factory.configFromGrant(
            grant,
            ExpressionEvaluationPolicy.EVALUATE
          );
          const evaluatedGrant = factory.grantFromConfig(evaluatedConfig);
          evaluatedGrant.purpose = grantPurpose as string;
          return evaluatedGrant;
        }
      } catch (error) {
        logger.warning(
          `Failed to evaluate grant with factory ${factoryInfo.constructor.name}: ${error}`
        );
        continue;
      }
    }

    throw new Error(`No suitable grant found for type ${grantType}`);
  }

  /**
   * Create a connector from either a ConnectorConfig or ConnectionGrant.
   *
   * This method uses the extension discovery mechanism to find an appropriate
   * factory that supports the given grant type.
   */
  public static async createConnector(
    configOrGrant: ConnectorConfig | ConnectionGrant | Record<string, unknown>,
    ...kwargs: unknown[]
  ): Promise<FameConnector> {
    // Handle ConnectionGrant first to avoid misclassifying grants as config records
    let connectorConfig: ConnectorConfig | undefined;
    let grantType: string | undefined;

    if (this.isConnectionGrant(configOrGrant)) {
      grantType = configOrGrant.type;
    } else if (this.isConnectorConfig(configOrGrant)) {
      return await this.createResource(configOrGrant, ...kwargs);
    } else if (this.isRecord(configOrGrant)) {
      // Check if this is a grant type by testing known factories
      grantType = configOrGrant.type as string;
    }

    if (!grantType) {
      throw new Error("Missing 'type' field in configuration");
    }

    const factories = ExtensionManager.getExtensionsByType();

    for (const [, factoryInfo] of factories) {
      try {
        const factory = factoryInfo.instance || new factoryInfo.constructor();
        if (factory.supportedGrantTypes().includes(grantType)) {
          // We found a factory that supports this grant type
          connectorConfig = factory.configFromGrant(configOrGrant);
          break;
        }
      } catch (error) {
        logger.warning(`Failed to create connector config from grant: ${error}`);
        continue;
      }
    }

    if (!connectorConfig) {
      throw new Error("No suitable connector configuration found");
    }

    return await this.createResource(connectorConfig, ...kwargs);
  }

  /**
   * Create a resource using the appropriate factory
   */
  private static async createResource(
    config: ConnectorConfig,
    ...kwargs: unknown[]
  ): Promise<FameConnector> {
    const factories = ExtensionManager.getExtensionsByType();

    const requestedType = config.type;
    const candidateTypes = new Set<string>([requestedType]);
    if (requestedType === "websocket") {
      candidateTypes.add("WebSocketConnector");
    } else if (requestedType === "WebSocketConnector") {
      candidateTypes.add("websocket");
    }

    for (const candidateType of candidateTypes) {
      for (const [, factoryInfo] of factories) {
        const factory = factoryInfo.instance || new factoryInfo.constructor();
        if (factory.type === candidateType) {
          const normalizedConfig =
            candidateType === requestedType
              ? config
              : ({ ...config, type: candidateType } as ConnectorConfig);
          return await factory.create(normalizedConfig as any, ...kwargs);
        }
      }
    }

    throw new Error(`No factory found for connector type: ${config.type}`);
  }

  /**
   * Type guard for ConnectorConfig
   */
  private static isConnectorConfig(obj: unknown): obj is ConnectorConfig {
    return (
      obj !== null &&
      typeof obj === "object" &&
      "type" in obj &&
      typeof (obj as any).type === "string"
    );
  }

  /**
   * Type guard for ConnectionGrant
   */
  private static isConnectionGrant(obj: unknown): obj is ConnectionGrant {
    return (
      obj !== null &&
      typeof obj === "object" &&
      "type" in obj &&
      "purpose" in obj &&
      typeof (obj as any).type === "string" &&
      typeof (obj as any).purpose === "string"
    );
  }

  /**
   * Type guard for Record<string, unknown>
   */
  private static isRecord(obj: unknown): obj is Record<string, unknown> {
    return obj !== null && typeof obj === "object" && !Array.isArray(obj);
  }
}

/**
 * Utility function to create a resource using the factory system
 */
export async function createResource<T extends FameConnector>(
  config: ConnectorConfig,
  ...kwargs: unknown[]
): Promise<T> {
  const factories = ExtensionManager.getExtensionsByType();

  const requestedType = config.type;
  const candidateTypes = new Set<string>([requestedType]);
  if (requestedType === "websocket") {
    candidateTypes.add("WebSocketConnector");
  } else if (requestedType === "WebSocketConnector") {
    candidateTypes.add("websocket");
  }

  for (const candidateType of candidateTypes) {
    for (const [, factoryInfo] of factories) {
      const factory = factoryInfo.instance || new factoryInfo.constructor();
      if (factory.type === candidateType) {
        const normalizedConfig =
          candidateType === requestedType
            ? config
            : ({ ...config, type: candidateType } as ConnectorConfig);
        return (await factory.create(normalizedConfig as any, ...kwargs)) as T;
      }
    }
  }

  throw new Error(`No factory found for connector type: ${config.type}`);
}

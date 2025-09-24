/**
 * Base class for connector settings.
 * 
 * • Never serialized to the wire
 * • Contains runtime knobs (queue sizes, timeouts, TLS flags, etc.)
 * • Used by connector factories to configure connectors in this process
 */

/**
 * Base interface for resource configurations.
 * All resource configs must have a 'type' field for polymorphic dispatch.
 */
export interface ResourceConfig {
  /** The type identifier for this resource configuration */
  type: string;
  
  /** Additional properties are allowed */
  [key: string]: unknown;
}

/**
 * Base class for connector configurations.
 * 
 * All connector configs must extend this interface and provide a type field
 * for polymorphic dispatch and factory selection.
 */
export interface ConnectorConfig extends ResourceConfig {
  /** The type identifier for this connector configuration */
  type: string;
  
  /** Whether the connector should operate in durable mode */
  durable?: boolean;
}

/**
 * Default values for connector configuration
 */
export const ConnectorConfigDefaults = {
  durable: false,
} as const;

/**
 * Type guard to check if an object is a valid ConnectorConfig
 */
export function isConnectorConfig(obj: unknown): obj is ConnectorConfig {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  
  const config = obj as Record<string, unknown>;
  return typeof config.type === 'string';
}

/**
 * Utility function to create a connector config with defaults applied
 */
export function createConnectorConfig<T extends ConnectorConfig>(config: Partial<T> & Pick<T, 'type'>): T {
  return {
    ...ConnectorConfigDefaults,
    ...config,
  } as T;
}
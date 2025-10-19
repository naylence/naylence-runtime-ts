import {
  FameEnvelopeSchema,
  createFameEnvelope,
  serializeEnvelope,
  type FameEnvelopeWith,
  type NodeHelloFrame,
  type NodeWelcomeFrame,
} from 'naylence-core';
import { getLogger } from '../../util/logging.js';
import { camelToSnakeCase, snakeToCamelCase } from '../../util/util.js';
import type { AuthInjectionStrategy } from '../../security/auth/auth-injection-strategy.js';
import type { AdmissionClient } from './admission-client.js';

const logger = getLogger('naylence.fame.node.admission.welcome_service_client');

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface WelcomeServiceClientOptions {
  readonly hasUpstream: boolean;
  readonly url: string;
  readonly supportedTransports: readonly string[];
  readonly authStrategyFactory?: () =>
    | Promise<AuthInjectionStrategy | undefined>
    | AuthInjectionStrategy
    | undefined;
  readonly fetchImpl?: FetchLike;
}

export class WelcomeServiceClient implements AdmissionClient {
  public readonly hasUpstream: boolean;

  private readonly url: string;
  private readonly supportedTransports: readonly string[];
  private readonly authStrategyFactory?: () =>
    | Promise<AuthInjectionStrategy | undefined>
    | AuthInjectionStrategy
    | undefined;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(options: WelcomeServiceClientOptions) {
    this.hasUpstream = options.hasUpstream;
    this.url = options.url;
    this.supportedTransports = options.supportedTransports;
    this.authStrategyFactory = options.authStrategyFactory;
    this.fetchImpl = options.fetchImpl;
  }

  public async hello(
    systemId: string,
    instanceId: string,
    requestedLogicals?: string[]
  ): Promise<FameEnvelopeWith<NodeWelcomeFrame>> {
    const fetchFn = this.resolveFetch();

    const helloFrame: NodeHelloFrame = {
      type: 'NodeHello',
      systemId,
      instanceId,
      logicals: requestedLogicals ?? [],
      supportedTransports: Array.from(this.supportedTransports),
    };

    const envelope = createFameEnvelope({ frame: helloFrame });
    const serialized = serializeEnvelope(envelope, { safeLog: false });

    // Convert envelope keys to snake_case, but keep frame content in camelCase
    const { frame, ...envelopeFields } = serialized;
    const payload = JSON.stringify({
      ...(convertKeysToSnakeCase(envelopeFields) as Record<string, unknown>),
      frame, // Keep frame in camelCase as per Fame protocol
    });

    const authHeaders: Record<string, string> = {};
    let authStrategy: AuthInjectionStrategy | undefined;

    try {
      if (this.authStrategyFactory) {
        authStrategy = await this.authStrategyFactory();

        if (authStrategy) {
          await authStrategy.apply(authHeaders);
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
      };

      logger.debug('welcome_service_hello_request', {
        url: this.url,
        systemId,
        instanceId,
        requestedLogicals,
        headers: Object.keys(headers),
      });

      const response = await fetchFn(this.url, {
        method: 'POST',
        headers,
        body: payload,
      });

      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(
          `WelcomeServiceClient request failed (${response.status} ${response.statusText}): ${responseText}`
        );
      }

      let data: unknown;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch (error) {
        throw new Error(
          `Failed to parse welcome service response: ${(error as Error).message}`
        );
      }

      if (!isRecord(data)) {
        throw new Error('Welcome service response is not a JSON object');
      }

      const camelData = convertKeysToCamelCase(data) as Record<string, unknown>;

      // Convert ISO timestamp string to Date object if present
      if (typeof camelData.ts === 'string') {
        camelData.ts = new Date(camelData.ts);
      }

      const parsedEnvelope = FameEnvelopeSchema.parse(
        camelData
      ) as FameEnvelopeWith<NodeWelcomeFrame>;

      if (
        !parsedEnvelope.frame ||
        parsedEnvelope.frame.type !== 'NodeWelcome'
      ) {
        throw new Error(
          `Unexpected frame type '${parsedEnvelope.frame?.type ?? 'unknown'}'`
        );
      }

      logger.debug('welcome_service_hello_success', {
        systemId: parsedEnvelope.frame.systemId,
        targetSystemId: parsedEnvelope.frame.targetSystemId,
        assignedPath: parsedEnvelope.frame.assignedPath,
        acceptedLogicals: parsedEnvelope.frame.acceptedLogicals,
      });

      return parsedEnvelope;
    } finally {
      if (authStrategy) {
        await authStrategy.cleanup();
      }
    }
  }

  public async close(): Promise<void> {
    // WelcomeServiceClient performs per-request auth setup; nothing to close.
  }

  private resolveFetch(): FetchLike {
    if (this.fetchImpl) {
      return this.fetchImpl;
    }

    if (typeof fetch === 'function') {
      return fetch.bind(globalThis) as FetchLike;
    }

    throw new Error(
      'Global fetch implementation is not available. Provide fetchImpl in options.'
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertKeysToSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(convertKeysToSnakeCase);
  }

  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const snakeKey = camelToSnakeCase(key);
    result[snakeKey] = convertKeysToSnakeCase(val);
  }
  return result;
}

function convertKeysToCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(convertKeysToCamelCase);
  }

  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const camelKey = snakeToCamelCase(key);
    result[camelKey] = convertKeysToCamelCase(val);
  }
  return result;
}

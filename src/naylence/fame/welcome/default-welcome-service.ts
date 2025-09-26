import { generateId, type NodeHelloFrame, type NodeWelcomeFrame } from 'naylence-core';

import type { NodePlacementStrategy, PlacementDecision } from '../placement/node-placement-strategy.js';
import type {
  TransportProvisionResult,
  TransportProvisioner,
} from '../transport/transport-provisioner.js';
import type { TokenIssuer } from '../security/auth/token-issuer.js';
import type { Authorizer } from '../security/auth/authorizer.js';
import { color, AnsiColor, formatTimestamp } from '../util/formatter.js';
import { jsonDumps } from '../util/util.js';
import { validateHostLogicals } from '../util/logicals.js';
import { getLogger } from '../util/logging.js';
import type { WelcomeService, WelcomeServiceMetadata } from './welcome-service.js';

const logger = getLogger('naylence.fame.welcome.DefaultWelcomeService');

const ENV_VAR_SHOW_ENVELOPES = 'FAME_SHOW_ENVELOPES';
const DEFAULT_TTL_SEC = 3600;

const showEnvelopes =
  typeof process !== 'undefined' && process.env?.[ENV_VAR_SHOW_ENVELOPES] === 'true';

function nowUtc(): Date {
  return new Date();
}

function formatTimestampForConsole(): string {
  return color(formatTimestamp(), AnsiColor.GRAY);
}

function prettyModel(value: unknown): string {
  try {
    return jsonDumps(value);
  } catch (error) {
    return String(error);
  }
}

function coercePlacementMetadataValue<T>(
  metadata: PlacementDecision['metadata'],
  camelCaseKey: string,
  snakeCaseKey: string
): T | undefined {
  if (!metadata) {
    return undefined;
  }

  const candidate = (metadata as Record<string, unknown>)[camelCaseKey];
  if (candidate !== undefined) {
    return candidate as T;
  }

  const snakeCandidate = (metadata as Record<string, unknown>)[snakeCaseKey];
  if (snakeCandidate !== undefined) {
    return snakeCandidate as T;
  }

  return undefined;
}

export interface DefaultWelcomeServiceOptions {
  placementStrategy: NodePlacementStrategy;
  transportProvisioner: TransportProvisioner;
  tokenIssuer: TokenIssuer;
  authorizer?: Authorizer | null;
  ttlSec?: number;
}

export class DefaultWelcomeService implements WelcomeService {
  public readonly authorizer?: Authorizer | null;

  private readonly placementStrategy: NodePlacementStrategy;
  private readonly transportProvisioner: TransportProvisioner;
  private readonly tokenIssuer: TokenIssuer;
  private readonly ttlSec: number;

  public constructor(options: DefaultWelcomeServiceOptions) {
    this.placementStrategy = options.placementStrategy;
    this.transportProvisioner = options.transportProvisioner;
    this.tokenIssuer = options.tokenIssuer;
    this.authorizer = options.authorizer ?? null;
    this.ttlSec = typeof options.ttlSec === 'number' && Number.isFinite(options.ttlSec)
      ? Math.max(0, options.ttlSec)
      : DEFAULT_TTL_SEC;
  }

  public async handleHello(
    hello: NodeHelloFrame,
    metadata?: WelcomeServiceMetadata
  ): Promise<NodeWelcomeFrame> {
    const fullMetadata: Record<string, unknown> = metadata ? { ...metadata } : {};

    const trimmedSystemId = typeof hello.systemId === 'string' ? hello.systemId.trim() : '';
    const systemId = trimmedSystemId.length > 0 ? trimmedSystemId : generateId();
    const wasAssigned = trimmedSystemId.length === 0;

    const normalizedHello: NodeHelloFrame = {
      ...hello,
      systemId,
    };

    if (showEnvelopes) {
      // eslint-disable-next-line no-console
      console.log(
        `\n${formatTimestampForConsole()} - ${color('Received envelope 📨', AnsiColor.BLUE)}\n${prettyModel(normalizedHello)}`
      );
    }

    logger.debug('starting_hello_frame_processing', {
      instanceId: normalizedHello.instanceId,
      systemId,
      logicals: normalizedHello.logicals,
      capabilities: normalizedHello.capabilities,
      ttlSec: this.ttlSec,
    });

    const now = nowUtc();
    const expiry = new Date(now.getTime() + this.ttlSec * 1000);

    if (fullMetadata.instanceId === undefined && normalizedHello.instanceId) {
      fullMetadata.instanceId = normalizedHello.instanceId;
    }
    if (fullMetadata.instance_id === undefined && normalizedHello.instanceId) {
      fullMetadata.instance_id = normalizedHello.instanceId;
    }

    logger.debug('system_id_assignment_completed', {
      systemId,
      wasAssigned,
    });

    if (normalizedHello.logicals?.length) {
      logger.debug('validating_logicals_for_dns_compatibility', {
        logicals: normalizedHello.logicals,
      });
      const [pathsValid, pathError] = validateHostLogicals(normalizedHello.logicals);
      if (!pathsValid) {
        logger.error('logical_validation_failed', {
          error: pathError,
          logicals: normalizedHello.logicals,
        });
        throw new Error(`Invalid logical format: ${pathError}`);
      }
      logger.debug('logicals_validation_successful');
    }

    logger.debug('requesting_node_placement', { systemId });
    const placementResult = await this.placementStrategy.place(normalizedHello);

    if (!placementResult.accept) {
      logger.error('node_placement_rejected', {
        systemId,
        reason: placementResult.reason,
      });
      throw new Error(placementResult.reason || 'Node not accepted');
    }

    const assignedPath = placementResult.assignedPath;
    logger.debug('node_placement_accepted', {
      systemId,
      assignedPath,
      targetPhysicalPath: placementResult.targetPhysicalPath ?? null,
      targetSystemId: placementResult.targetSystemId ?? null,
    });

    const acceptedCapabilities = coercePlacementMetadataValue<string[] | null>(
      placementResult.metadata,
      'acceptedCapabilities',
      'accepted_capabilities'
    ) ?? normalizedHello.capabilities ?? null;

    const acceptedLogicals = coercePlacementMetadataValue<string[] | null>(
      placementResult.metadata,
      'acceptedLogicals',
      'accepted_logicals'
    ) ?? normalizedHello.logicals ?? null;

    logger.debug('processing_placement_result_metadata', {
      acceptedCapabilities,
      acceptedLogicals,
      hasPlacementMetadata: placementResult.metadata !== undefined && placementResult.metadata !== null,
    });

    const connectionGrants: Array<TransportProvisionResult['connectionGrant']> = [];

    if (placementResult.targetSystemId) {
      logger.debug('issuing_node_attach_token', {
        systemId,
        assignedPath,
      });

      const nodeAttachToken = await this.tokenIssuer.issue({
        aud: placementResult.targetPhysicalPath,
        system_id: systemId,
        parent_path: placementResult.targetPhysicalPath,
        assigned_path: placementResult.assignedPath,
        accepted_logicals: acceptedLogicals,
        instance_id:
          (typeof fullMetadata.instanceId === 'string' && fullMetadata.instanceId) ||
          (typeof fullMetadata.instance_id === 'string' && fullMetadata.instance_id) ||
          normalizedHello.instanceId ||
          generateId(),
      });

      logger.debug('token_issued_successfully');

      logger.debug('provisioning_transport', { systemId });
      const transportInfo = await this.transportProvisioner.provision(
        placementResult,
        normalizedHello,
        fullMetadata,
        nodeAttachToken
      );

      logger.debug('transport_provisioned_successfully', {
        systemId,
        directiveType: transportInfo.connectionGrant && typeof transportInfo.connectionGrant === 'object'
          ? (transportInfo.connectionGrant as { type?: unknown }).type ?? 'Unknown'
          : 'Unknown',
      });

      connectionGrants.push(transportInfo.connectionGrant);
    }

    const welcomeFrame: NodeWelcomeFrame = {
      type: 'NodeWelcome',
      systemId,
      targetSystemId: placementResult.targetSystemId ?? undefined,
      targetPhysicalPath: placementResult.targetPhysicalPath ?? undefined,
      instanceId: normalizedHello.instanceId,
      assignedPath,
      acceptedCapabilities: acceptedCapabilities ?? undefined,
      acceptedLogicals: acceptedLogicals ?? undefined,
      rejectedLogicals: undefined,
      connectionGrants,
      metadata: Object.keys(fullMetadata).length > 0 ? fullMetadata : undefined,
      expiresAt: expiry.toISOString(),
    };

    logger.debug('hello_frame_processing_completed_successfully', {
      systemId,
      assignedPath,
      acceptedLogicals,
      acceptedCapabilities,
      expiresAt: welcomeFrame.expiresAt,
      instanceId: normalizedHello.instanceId,
    });

    if (showEnvelopes) {
      // eslint-disable-next-line no-console
      console.log(
        `\n${formatTimestampForConsole()} - ${color('Sent envelope', AnsiColor.BLUE)} 🚀\n${prettyModel(welcomeFrame)}`
      );
    }

    return welcomeFrame;
  }
}

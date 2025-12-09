import {
  createFameEnvelope,
  type FameEnvelopeWith,
  type NodeWelcomeFrame,
} from '@naylence/core';
import {
  DEFAULT_DIRECT_ADMISSION_TTL_SEC,
  TTL_NEVER_EXPIRES,
} from '../../constants/ttl-constants.js';
import { getLogger } from '../../util/logging.js';
import { validateTtlSec } from '../../util/ttl-validation.js';
import type { AdmissionClient } from './admission-client.js';
import { GrantMaterializer } from '../../grants/grant-materializer.js';
import type { NodeIdentityPolicy } from '../node-identity-policy.js';
import type { AuthIdentity } from '../../security/auth/auth-identity.js';

const logger = getLogger(
  'naylence.fame.node.admission.direct_admission_client'
);

export interface DirectAdmissionClientOptions {
  readonly connectionGrants?: Array<Record<string, unknown>>;
  readonly connection_grants?: Array<Record<string, unknown>>;
  readonly ttlSec?: number | null;
  readonly ttl_sec?: number | null;
  readonly nodeIdentityPolicy?: NodeIdentityPolicy;
}

export class DirectAdmissionClient implements AdmissionClient {
  public readonly hasUpstream = true;

  private readonly connectionGrants: Array<Record<string, unknown>>;
  private readonly ttlSec: number | null | undefined;
  private readonly nodeIdentityPolicy?: NodeIdentityPolicy;

  constructor(options: DirectAdmissionClientOptions) {
    const connectionGrantsSource =
      options.connectionGrants ?? options.connection_grants;

    if (
      !Array.isArray(connectionGrantsSource) ||
      connectionGrantsSource.length === 0
    ) {
      throw new Error(
        'DirectAdmissionClient requires at least one connection grant'
      );
    }

    this.connectionGrants = connectionGrantsSource.map((grant) =>
      cloneGrant(grant)
    );

    const ttlCandidate = options.ttlSec ?? options.ttl_sec ?? TTL_NEVER_EXPIRES;
    if (ttlCandidate != null && ttlCandidate !== TTL_NEVER_EXPIRES) {
      const validated = validateTtlSec(ttlCandidate, {
        min: 60,
        max: 86400 * 7,
        allowNeverExpires: true,
        context: 'Direct admission TTL',
      });

      this.ttlSec = typeof validated === 'number' ? validated : ttlCandidate;
    } else {
      this.ttlSec = ttlCandidate;
    }

    this.nodeIdentityPolicy = options.nodeIdentityPolicy;
  }

  public async hello(
    systemId: string,
    instanceId: string,
    requestedLogicals?: string[]
  ): Promise<FameEnvelopeWith<NodeWelcomeFrame>> {
    logger.debug('direct_admission_hello_start', {
      providedSystemId: systemId,
      instanceId,
      requestedLogicals,
    });

    const initialSystemId = systemId;

    const acceptedLogicals =
      requestedLogicals && requestedLogicals.length > 0
        ? [...requestedLogicals]
        : ['*'];

    const now = Date.now();
    const ttlSeconds = this.resolveTtlSeconds();
    const expiresAt = new Date(now + ttlSeconds * 1000);

    const materializedResults = await Promise.all(
      this.connectionGrants.map((grant) => GrantMaterializer.materialize(grant))
    );

    const materializedGrants = materializedResults.map((r) => r.grant);
    const identities = materializedResults
      .map((r) => r.identity)
      .filter((id): id is AuthIdentity => !!id);

    const effectiveSystemId = this.nodeIdentityPolicy
      ? await this.nodeIdentityPolicy.resolveAdmissionNodeId({
          currentNodeId: initialSystemId,
          identities,
        })
      : initialSystemId;

    const welcomeFrame: NodeWelcomeFrame = {
      type: 'NodeWelcome',
      systemId: effectiveSystemId,
      instanceId,
      acceptedLogicals,
      connectionGrants: materializedGrants.map((grant) =>
        cloneGrant(grant as Record<string, unknown>)
      ),
      expiresAt: expiresAt.toISOString(),
    };

    const envelope = createFameEnvelope({
      frame: welcomeFrame,
    }) as FameEnvelopeWith<NodeWelcomeFrame>;

    logger.debug('direct_admission_hello_success', {
      systemId: welcomeFrame.systemId,
      instanceId: welcomeFrame.instanceId,
      acceptedLogicals: welcomeFrame.acceptedLogicals,
      grantCount: welcomeFrame.connectionGrants?.length ?? 0,
      expiresAt: welcomeFrame.expiresAt,
    });

    return envelope;
  }

  public async close(): Promise<void> {
    // Nothing to clean up for direct admission
  }

  private resolveTtlSeconds(): number {
    if (this.ttlSec == null || this.ttlSec === TTL_NEVER_EXPIRES) {
      return DEFAULT_DIRECT_ADMISSION_TTL_SEC;
    }

    return this.ttlSec;
  }
}

function cloneGrant(grant: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(grant));
}

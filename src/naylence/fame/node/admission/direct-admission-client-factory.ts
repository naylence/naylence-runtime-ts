import { registerFactory } from 'naylence-factory';
import { ConnectorFactory } from '../../connector/connector-factory.js';
import { DirectAdmissionClient } from './direct-admission-client.js';
import { ADMISSION_CLIENT_FACTORY_BASE_TYPE, AdmissionClientFactory, type AdmissionConfig } from './admission-client-factory.js';
import type { AdmissionClient } from './admission-client.js';

export interface DirectAdmissionClientConfig extends AdmissionConfig {
  type: 'DirectAdmissionClient';
  connectionGrants: Array<Record<string, unknown>>;
  ttlSec?: number | null;
}

interface NormalizedDirectAdmissionClientConfig {
  connectionGrants: Array<Record<string, unknown>>;
  ttlSec?: number | null;
}

export class DirectAdmissionClientFactory extends AdmissionClientFactory<DirectAdmissionClientConfig> {
  public readonly type = 'DirectAdmissionClient';

  public async create(
    config?: DirectAdmissionClientConfig | Record<string, unknown> | null
  ): Promise<AdmissionClient> {
    if (!config) {
      throw new Error('DirectAdmissionClient configuration is required');
    }

    const normalized = normalizeConfig(config);

    const evaluatedGrants = normalized.connectionGrants.map((grant) => {
      const evaluated = ConnectorFactory.evaluateGrant({ ...(grant as Record<string, unknown>) });
      return JSON.parse(JSON.stringify(evaluated));
    });

    return new DirectAdmissionClient({
      connectionGrants: evaluatedGrants,
      ttlSec: normalized.ttlSec ?? null,
    });
  }
}

function normalizeConfig(
  config: DirectAdmissionClientConfig | Record<string, unknown>
): NormalizedDirectAdmissionClientConfig {
  const source = config as DirectAdmissionClientConfig & Record<string, unknown>;

  const connectionGrantsRaw = source.connectionGrants ?? source.connection_grants;
  if (!Array.isArray(connectionGrantsRaw) || connectionGrantsRaw.length === 0) {
    throw new Error('DirectAdmissionClient configuration must include at least one connection grant');
  }

  const connectionGrants = connectionGrantsRaw.map((grant, index) => {
    if (typeof grant !== 'object' || grant === null || Array.isArray(grant)) {
      throw new Error(`Connection grant at index ${index} must be an object`);
    }
    return grant as Record<string, unknown>;
  });

  const ttlCandidate =
    typeof source.ttlSec === 'number'
      ? source.ttlSec
      : typeof source.ttl_sec === 'number'
        ? source.ttl_sec
        : undefined;

  return {
    connectionGrants,
    ...(ttlCandidate !== undefined ? { ttlSec: ttlCandidate } : {}),
  };
}

registerFactory<AdmissionClient, DirectAdmissionClientConfig>(
  ADMISSION_CLIENT_FACTORY_BASE_TYPE,
  'DirectAdmissionClient',
  DirectAdmissionClientFactory
);

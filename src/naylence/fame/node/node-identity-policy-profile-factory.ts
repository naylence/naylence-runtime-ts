import {
  NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE,
  NodeIdentityPolicyFactory,
  type NodeIdentityPolicyConfig,
} from './node-identity-policy-factory.js';
import type { NodeIdentityPolicy } from './node-identity-policy.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger(
  'naylence.fame.node.node_identity_policy_profile_factory'
);

export interface NodeIdentityPolicyProfileConfig
  extends NodeIdentityPolicyConfig {
  type: 'NodeIdentityPolicyProfile';
  profile?: string | null;
}

const PROFILE_NAME_DEFAULT = 'default';
const PROFILE_NAME_TOKEN_SUBJECT = 'token-subject';
const PROFILE_NAME_TOKEN_SUBJECT_ALIAS = 'token_subject';

const DEFAULT_PROFILE: NodeIdentityPolicyConfig = {
  type: 'DefaultNodeIdentityPolicy',
};

const TOKEN_SUBJECT_PROFILE: NodeIdentityPolicyConfig = {
  type: 'TokenSubjectNodeIdentityPolicy',
};

const PROFILE_MAP: Record<string, NodeIdentityPolicyConfig> = {
  [PROFILE_NAME_DEFAULT]: DEFAULT_PROFILE,
  [PROFILE_NAME_TOKEN_SUBJECT]: TOKEN_SUBJECT_PROFILE,
  [PROFILE_NAME_TOKEN_SUBJECT_ALIAS]: TOKEN_SUBJECT_PROFILE,
};

export const FACTORY_META = {
  base: NODE_IDENTITY_POLICY_FACTORY_BASE_TYPE,
  key: 'NodeIdentityPolicyProfile',
} as const;

export class NodeIdentityPolicyProfileFactory extends NodeIdentityPolicyFactory<NodeIdentityPolicyProfileConfig> {
  public readonly type = 'NodeIdentityPolicyProfile';

  public async create(
    config?: NodeIdentityPolicyProfileConfig | Record<string, unknown> | null
  ): Promise<NodeIdentityPolicy> {
    const normalized = normalizeConfig(config);
    const profileConfig = resolveProfileConfig(normalized.profile);

    logger.debug('enabling_node_identity_policy_profile', {
      profile: normalized.profile,
    });

    return NodeIdentityPolicyFactory.createNodeIdentityPolicy(profileConfig);
  }
}

interface NormalizedNodeIdentityPolicyProfileConfig {
  profile: string;
}

function normalizeConfig(
  config:
    | NodeIdentityPolicyProfileConfig
    | Record<string, unknown>
    | null
    | undefined
): NormalizedNodeIdentityPolicyProfileConfig {
  if (!config) {
    return { profile: PROFILE_NAME_DEFAULT };
  }

  const candidate = config as NodeIdentityPolicyProfileConfig &
    Record<string, unknown>;
  const profileValue =
    typeof candidate.profile === 'string' && candidate.profile.trim().length > 0
      ? candidate.profile
      : typeof candidate.profile_name === 'string' &&
          candidate.profile_name.trim().length > 0
        ? candidate.profile_name
        : typeof candidate.profileName === 'string' &&
            candidate.profileName.trim().length > 0
          ? candidate.profileName
          : PROFILE_NAME_DEFAULT;

  const normalizedProfile = profileValue.trim().toLowerCase();

  return { profile: normalizedProfile };
}

function resolveProfileConfig(profileName: string): NodeIdentityPolicyConfig {
  const profile = PROFILE_MAP[profileName];
  if (!profile) {
    throw new Error(`Unknown node identity policy profile: ${profileName}`);
  }

  return deepClone(profile);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export default NodeIdentityPolicyProfileFactory;

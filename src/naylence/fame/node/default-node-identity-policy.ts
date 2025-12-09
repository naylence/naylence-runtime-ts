import { generateIdAsync } from '@naylence/core';
import type {
  InitialIdentityContext,
  NodeIdentityPolicy,
  NodeIdentityPolicyContext,
} from './node-identity-policy.js';
import { TokenProviderFactory } from '../security/auth/token-provider-factory.js';
import { isIdentityExposingTokenProvider } from '../security/auth/token-provider.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.node.default_node_identity_policy');

export class DefaultNodeIdentityPolicy implements NodeIdentityPolicy {
  public async resolveInitialNodeId(
    context: InitialIdentityContext
  ): Promise<string> {
    if (context.configuredId) {
      return context.configuredId;
    }

    if (context.persistedId) {
      return context.persistedId;
    }

    return await generateIdAsync({ mode: 'fingerprint' });
  }

  public async resolveAdmissionNodeId(
    context: NodeIdentityPolicyContext
  ): Promise<string> {
    // Try to extract identity from grants first
    if (context.grants && context.grants.length > 0) {
      for (const grant of context.grants) {
        try {
          const auth = grant.auth as Record<string, unknown> | undefined;
          if (!auth) {
            continue;
          }

          const tokenProviderConfig = (auth.tokenProvider ??
            auth.token_provider) as Record<string, unknown>;

          if (
            !tokenProviderConfig ||
            typeof tokenProviderConfig.type !== 'string'
          ) {
            continue;
          }

          const provider = await TokenProviderFactory.createTokenProvider(
            tokenProviderConfig
          );

          if (isIdentityExposingTokenProvider(provider)) {
            const identity = await provider.getIdentity();
            if (identity && identity.subject) {
              logger.debug('identity_extracted_from_grant', {
                identity_id: identity.subject,
                grant_type: grant.type,
              });
              return identity.subject;
            }
          }
        } catch (error) {
          logger.warning('identity_extraction_failed', {
            error: error instanceof Error ? error.message : String(error),
            grant_type: grant.type,
          });
        }
      }
    }

    if (!context.currentNodeId) {
      return await generateIdAsync({ mode: 'fingerprint' });
    }
    return context.currentNodeId;
  }
}

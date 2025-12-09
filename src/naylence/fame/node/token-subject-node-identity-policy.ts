import { generateIdAsync } from '@naylence/core';
import type {
  InitialIdentityContext,
  NodeIdentityPolicy,
  NodeIdentityPolicyContext,
} from './node-identity-policy.js';
import { TokenProviderFactory } from '../security/auth/token-provider-factory.js';
import { isIdentityExposingTokenProvider } from '../security/auth/token-provider.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.node.token_subject_node_identity_policy');

export class TokenSubjectNodeIdentityPolicy implements NodeIdentityPolicy {
  async resolveInitialNodeId(context: InitialIdentityContext): Promise<string> {
    if (context.configuredId) {
      return context.configuredId;
    }
    if (context.persistedId) {
      return context.persistedId;
    }
    return generateIdAsync();
  }

  async resolveAdmissionNodeId(
    context: NodeIdentityPolicyContext
  ): Promise<string> {
    logger.debug('resolve_admission_node_id_start', {
      grantsCount: context.grants?.length ?? 0,
      currentNodeId: context.currentNodeId,
    });

    if (context.grants && context.grants.length > 0) {
      for (const grant of context.grants) {
        try {
          const auth = grant.auth as Record<string, unknown> | undefined;
          if (!auth) {
            logger.debug('skipping_grant_no_auth', { grantType: grant.type });
            continue;
          }

          const tokenProviderConfig = (auth.tokenProvider ??
            auth.token_provider) as Record<string, unknown>;

          if (
            !tokenProviderConfig ||
            typeof tokenProviderConfig.type !== 'string'
          ) {
            logger.debug('skipping_grant_invalid_token_provider_config', {
              grantType: grant.type,
              config: tokenProviderConfig,
            });
            continue;
          }

          logger.debug('creating_token_provider', {
            type: tokenProviderConfig.type,
          });

          const provider = await TokenProviderFactory.createTokenProvider(
            tokenProviderConfig
          );

          const isExposing = isIdentityExposingTokenProvider(provider);
          logger.debug('token_provider_created', {
            type: tokenProviderConfig.type,
            isIdentityExposing: isExposing,
          });

          if (isExposing) {
            const identity = await provider.getIdentity();
            logger.debug('retrieved_identity', { identity });

            if (identity && identity.subject) {
              const hashedSubject = await generateIdAsync({
                mode: 'fingerprint',
                material: identity.subject,
                length: 8,
              });

              const newNodeId = `${hashedSubject}-${context.currentNodeId}`;

              logger.info('resolved_identity_from_token', {
                subject: identity.subject,
                hashedSubject,
                newNodeId,
              });
              return newNodeId;
            } else {
              logger.debug('identity_missing_subject', { identity });
            }
          }
        } catch (err) {
          logger.warning('failed_to_extract_identity_from_grant', { error: err });
        }
      }
    } else {
      logger.debug('no_grants_available');
    }

    return context.currentNodeId;
  }
}

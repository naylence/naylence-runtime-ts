import { TokenProviderFactory } from '../security/auth/token-provider-factory.js';
import { isMaterializableTokenProvider } from '../security/auth/materializable-token-provider.js';
import { isIdentityExposingTokenProvider } from '../security/auth/token-provider.js';
import type { AuthIdentity } from '../security/auth/auth-identity.js';
import type { ConnectionGrantLike } from './connection-grant.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.grants.grant_materializer');

export interface GrantMaterializationResult {
  grant: ConnectionGrantLike;
  identity?: AuthIdentity;
}

export class GrantMaterializer {

  public static async materialize(
    grant: ConnectionGrantLike
  ): Promise<GrantMaterializationResult> {
    const candidate = grant as Record<string, unknown>;
    const auth = candidate.auth as Record<string, unknown> | undefined;

    if (!auth) {
      return { grant };
    }

    const tokenProviderConfig = (auth.tokenProvider ??
      auth.token_provider) as Record<string, unknown>;

    if (!tokenProviderConfig || typeof tokenProviderConfig.type !== 'string') {
      return { grant };
    }

    try {
      const provider = await TokenProviderFactory.createTokenProvider(
        tokenProviderConfig
      );

      let identity: AuthIdentity | undefined;
      if (isIdentityExposingTokenProvider(provider)) {
        identity = await provider.getIdentity();
      }

      if (isMaterializableTokenProvider(provider)) {
        const materializedConfig = await provider.materialize();
        if (materializedConfig) {
          logger.debug('grant_materialized', {
            grantType: candidate.type,
            providerType: tokenProviderConfig.type,
            hasIdentity: !!identity,
          });

          const newAuth = { ...auth };
          if ('tokenProvider' in newAuth) {
            newAuth.tokenProvider = materializedConfig;
          }
          if ('token_provider' in newAuth) {
            newAuth.token_provider = materializedConfig;
          }

          return {
            grant: {
              ...grant,
              auth: newAuth,
            },
            identity,
          };
        }
      }
      
      // If not materializable but has identity, we should still return identity?
      // The original code only returned modified grant if materialization happened.
      // But if we want identity from a static provider, we should return it.
      if (identity) {
         return { grant, identity };
      }

    } catch (error) {
      logger.warning('grant_materialization_failed', {
        error: error instanceof Error ? error.message : String(error),
        grantType: candidate.type,
      });

      if (
        error &&
        (error as { name?: string }).name === 'OAuth2PkceRedirectInitiatedError'
      ) {
        throw error;
      }
    }

    return { grant };
  }
}

import { TokenProviderFactory } from '../security/auth/token-provider-factory.js';
import { isMaterializableTokenProvider } from '../security/auth/materializable-token-provider.js';
import type { ConnectionGrantLike } from './connection-grant.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.grants.grant_materializer');

export class GrantMaterializer {

  public static async materialize(
    grant: ConnectionGrantLike
  ): Promise<ConnectionGrantLike> {
    const candidate = grant as Record<string, unknown>;
    const auth = candidate.auth as Record<string, unknown> | undefined;

    if (!auth) {
      return grant;
    }

    const tokenProviderConfig = (auth.tokenProvider ??
      auth.token_provider) as Record<string, unknown>;

    if (!tokenProviderConfig || typeof tokenProviderConfig.type !== 'string') {
      return grant;
    }

    try {
      const provider = await TokenProviderFactory.createTokenProvider(
        tokenProviderConfig
      );

      if (isMaterializableTokenProvider(provider)) {
        const materializedConfig = await provider.materialize();
        if (materializedConfig) {
          logger.debug('grant_materialized', {
            grantType: candidate.type,
            providerType: tokenProviderConfig.type,
          });

          const newAuth = { ...auth };
          if ('tokenProvider' in newAuth) {
            newAuth.tokenProvider = materializedConfig;
          }
          if ('token_provider' in newAuth) {
            newAuth.token_provider = materializedConfig;
          }

          return {
            ...grant,
            auth: newAuth,
          };
        }
      }
    } catch (error) {
      if (
        error &&
        (error as { name?: string }).name === 'OAuth2PkceRedirectInitiatedError'
      ) {
        logger.info('grant_materialization_redirecting', {
          grantType: candidate.type,
        });
        throw error;
      }

      logger.warning('grant_materialization_failed', {
        error: error instanceof Error ? error.message : String(error),
        grantType: candidate.type,
      });
    }

    return grant;
  }
}

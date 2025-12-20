import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
  NodeAttachFrame,
} from '@naylence/core';
import { createAuthorizationContext, generateIdAsync } from '@naylence/core';
import { DEFAULT_REVERSE_AUTH_TTL_SEC } from '../../constants/ttl-constants.js';
import { getLogger } from '../../util/logging.js';
import type { NodeLike } from '../../node/node-like.js';
import type { NodeEventListener } from '../../node/node-event-listener.js';
import type { TokenIssuer } from './token-issuer.js';
import type { TokenVerifier } from './token-verifier.js';
import type { TokenVerifierProvider } from './token-verifier-provider.js';
import type { Authorizer } from './authorizer.js';

const logger = getLogger('naylence.fame.security.auth.oauth2_authorizer');

type StaticTokenProviderConfig = {
  type: 'StaticTokenProvider';
  token: string;
  expiresAt: Date;
} & Record<string, unknown>;

type BearerTokenHeaderAuthInjectionStrategyConfig = {
  type: 'BearerTokenHeaderAuthInjectionStrategy';
  tokenProvider: StaticTokenProviderConfig;
} & Record<string, unknown>;

export interface OAuth2AuthorizerOptions {
  tokenVerifier: TokenVerifier;
  tokenIssuer?: TokenIssuer;
  audience?: string;
  requiredScopes?: string[];
  requireScope?: boolean;
  defaultTtlSec?: number;
  maxTtlSec?: number;
  reverseAuthTtlSec?: number;
  enforceTokenSubjectNodeIdentity?: boolean;
}

type SnakeCaseOAuth2AuthorizerOptions = Partial<
  Record<
    | 'token_verifier'
    | 'token_issuer'
    | 'aud'
    | 'audience'
    | 'required_scopes'
    | 'require_scope'
    | 'default_ttl_sec'
    | 'max_ttl_sec'
    | 'reverse_auth_ttl_sec'
    | 'enforce_token_subject_node_identity',
    unknown
  >
>;

function normalizeOptions(
  raw: OAuth2AuthorizerOptions | Record<string, unknown>
): OAuth2AuthorizerOptions {
  const camel = raw as OAuth2AuthorizerOptions;
  const snake = raw as SnakeCaseOAuth2AuthorizerOptions;

  const tokenVerifier =
    camel.tokenVerifier ?? (snake.token_verifier as TokenVerifier | undefined);

  if (!tokenVerifier) {
    throw new Error('OAuth2Authorizer requires a tokenVerifier');
  }

  const tokenIssuer =
    camel.tokenIssuer ?? (snake.token_issuer as TokenIssuer | undefined);
  const requiredScopes =
    camel.requiredScopes ??
    (Array.isArray(snake.required_scopes)
      ? (snake.required_scopes as string[])
      : undefined);
  const requireScope =
    camel.requireScope ??
    (typeof snake.require_scope === 'boolean'
      ? snake.require_scope
      : undefined);

  const reverseAuthTtlSec =
    camel.reverseAuthTtlSec ??
    (typeof snake.reverse_auth_ttl_sec === 'number'
      ? snake.reverse_auth_ttl_sec
      : undefined);

  const defaultTtlSec =
    camel.defaultTtlSec ??
    (typeof snake.default_ttl_sec === 'number'
      ? snake.default_ttl_sec
      : undefined);

  const maxTtlSec =
    camel.maxTtlSec ??
    (typeof snake.max_ttl_sec === 'number' ? snake.max_ttl_sec : undefined);

  const audience =
    camel.audience ??
    (typeof snake.audience === 'string'
      ? snake.audience
      : typeof snake.aud === 'string'
        ? snake.aud
        : undefined);

  const enforceTokenSubjectNodeIdentity =
    camel.enforceTokenSubjectNodeIdentity ??
    (typeof snake.enforce_token_subject_node_identity === 'boolean'
      ? snake.enforce_token_subject_node_identity
      : undefined);

  return {
    tokenVerifier,
    tokenIssuer,
    audience,
    requiredScopes,
    requireScope,
    defaultTtlSec,
    maxTtlSec,
    reverseAuthTtlSec,
    enforceTokenSubjectNodeIdentity,
  };
}

export class OAuth2Authorizer
  implements Authorizer, TokenVerifierProvider, NodeEventListener
{
  public readonly priority = 1000;

  private readonly tokenVerifierImpl: TokenVerifier;
  private readonly tokenIssuer: TokenIssuer | undefined;
  private readonly audience: string | undefined;
  private readonly requiredScopes: Set<string>;
  private readonly requireScope: boolean;
  private readonly reverseAuthTtlSec: number;
  private readonly enforceTokenSubjectNodeIdentity: boolean;
  private node?: NodeLike;

  constructor(rawOptions: OAuth2AuthorizerOptions | Record<string, unknown>) {
    const options = normalizeOptions(rawOptions);

    this.tokenVerifierImpl = options.tokenVerifier;
    this.tokenIssuer = options.tokenIssuer ?? undefined;
    this.audience = options.audience ?? undefined;
    this.requiredScopes = new Set(
      (options.requiredScopes ?? []).filter((scope) => scope.trim().length > 0)
    );
    this.requireScope = options.requireScope ?? true;
    this.reverseAuthTtlSec =
      options.reverseAuthTtlSec ?? DEFAULT_REVERSE_AUTH_TTL_SEC;
    this.enforceTokenSubjectNodeIdentity =
      options.enforceTokenSubjectNodeIdentity ?? false;
  }

  get tokenVerifier(): TokenVerifier {
    return this.tokenVerifierImpl;
  }

  async onNodeStarted(node: NodeLike): Promise<void> {
    this.node = node;
  }

  async authenticate(
    credentials: string | Uint8Array
  ): Promise<AuthorizationContext | undefined> {
    const token = this.normalizeBearerToken(credentials);
    if (!token) {
      logger.debug('oauth2_authenticate_missing_token');
      return undefined;
    }

    try {
      const expectedAudience = this.audience ?? this.node?.physicalPath;
      logger.debug('oauth2_authenticate_start', {
        expected_audience: expectedAudience,
      });
      const context =
        expectedAudience !== undefined
          ? await this.tokenVerifierImpl.verify(token, { expectedAudience })
          : await this.tokenVerifierImpl.verify(token);

      const claims = { ...(context.claims ?? {}) } as Record<string, unknown>;
      const scopes = this.extractScopes(claims);
      const grantedScopes = this.mergeScopes(
        context.grantedScopes ?? [],
        scopes
      );

      if (
        this.requireScope &&
        this.requiredScopes.size > 0 &&
        !this.hasRequiredScope(grantedScopes)
      ) {
        logger.warning('oauth2_token_missing_required_scope', {
          required_scopes: Array.from(this.requiredScopes),
          token_scopes: Array.from(scopes),
        });
        return undefined;
      }

      const normalized = createAuthorizationContext({
        ...context,
        authenticated: true,
        authorized: context.authorized ?? true,
        claims,
        grantedScopes,
        authMethod: context.authMethod ?? 'oauth2_jwt',
      });

      logger.debug('oauth2_authenticate_success', {
        granted_scopes: Array.from(grantedScopes),
      });

      return normalized;
    } catch (error) {
      logger.warning('oauth2_token_verification_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async authorize(
    _node: NodeLike,
    _envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<AuthorizationContext | undefined> {
    const security = context?.security;
    const authorization = security?.authorization;
    if (!authorization) {
      return undefined;
    }

    // Early return if already authorized (matches Python behavior)
    // This skips scope checking for reverse auth contexts
    if (authorization.authorized) {
      return authorization;
    }

    const grantedScopes = new Set<string>(authorization.grantedScopes ?? []);

    if (
      this.requireScope &&
      this.requiredScopes.size > 0 &&
      !this.hasRequiredScope(grantedScopes)
    ) {
      return undefined;
    }

    return createAuthorizationContext({
      ...authorization,
      authorized: true,
    });
  }

  async createReverseAuthorizationConfig(
    node: NodeLike
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.tokenIssuer) {
      return undefined;
    }

    const expiresAt = new Date(Date.now() + this.reverseAuthTtlSec * 1000);

    try {
      const token = await this.tokenIssuer.issue({
        iss: this.tokenIssuer.issuer,
        aud: this.audience ?? node.physicalPath,
        exp: Math.floor(expiresAt.getTime() / 1000),
        sub: `reverse-auth-${node.id}`,
        instance_id:
          (node as unknown as { instanceId?: string }).instanceId ?? null,
        capabilities: Array.from(this.requiredScopes),
      });

      logger.debug('reverse_authorization_token_generated', {
        node_id: node.id,
        expires_at: expiresAt.toISOString(),
        capabilities: Array.from(this.requiredScopes),
      });

      const staticTokenConfig: StaticTokenProviderConfig = {
        type: 'StaticTokenProvider',
        token,
        expiresAt,
      };

      const result: BearerTokenHeaderAuthInjectionStrategyConfig = {
        type: 'BearerTokenHeaderAuthInjectionStrategy',
        tokenProvider: staticTokenConfig,
      };
      return result;
    } catch (error) {
      logger.warning('failed_to_generate_reverse_auth_token', {
        node_id: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async validateNodeAttachRequest(
    node: NodeLike,
    frame: NodeAttachFrame,
    authContext?: AuthorizationContext
  ): Promise<AuthorizationContext | undefined> {
    if (!authContext || !authContext.authenticated) {
      return undefined;
    }

    const claims = { ...(authContext.claims ?? {}) } as Record<string, unknown>;
    const scopes = this.extractScopes(claims);
    const grantedScopes = this.mergeScopes(
      authContext.grantedScopes ?? [],
      scopes
    );

    if (
      this.requireScope &&
      this.requiredScopes.size > 0 &&
      !this.hasRequiredScope(grantedScopes)
    ) {
      logger.warning('oauth2_attach_missing_required_scope', {
        required_scopes: Array.from(this.requiredScopes),
        token_scopes: Array.from(scopes),
      });
      return undefined;
    }

    // Enforce token subject node identity if enabled
    if (this.enforceTokenSubjectNodeIdentity) {
      const validationResult = await this.validateTokenSubjectNodeIdentity(
        frame.systemId,
        claims
      );
      if (!validationResult) {
        return undefined;
      }
    }

    claims.instance_id = claims.instance_id ?? frame.instanceId;
    claims.assigned_path = claims.assigned_path ?? frame.assignedPath;
    claims.accepted_capabilities =
      frame.capabilities ?? claims.accepted_capabilities;
    claims.accepted_logicals =
      frame.acceptedLogicals ?? claims.accepted_logicals;
    claims.aud = node.id;
    claims.scopes = Array.from(scopes);

    return createAuthorizationContext({
      ...authContext,
      claims,
      principal:
        authContext.principal ??
        (typeof claims.sub === 'string'
          ? (claims.sub as string)
          : frame.systemId),
      grantedScopes,
      authorized: true,
      authMethod: authContext.authMethod ?? 'oauth2_jwt',
    });
  }

  private normalizeBearerToken(
    credentials: string | Uint8Array
  ): string | undefined {
    if (typeof credentials === 'string') {
      const trimmed = credentials.trim();
      if (trimmed.toLowerCase().startsWith('bearer ')) {
        return trimmed.slice(7).trim();
      }
      return trimmed.length > 0 ? trimmed : undefined;
    }

    const decoded = new TextDecoder().decode(credentials);
    return this.normalizeBearerToken(decoded);
  }

  private extractScopes(claims: Record<string, unknown>): Set<string> {
    const scopes = new Set<string>();

    const add = (value: unknown): void => {
      if (typeof value === 'string') {
        value
          .split(/[\s,]+/)
          .filter(Boolean)
          .forEach((scope) => scopes.add(scope));
      } else if (Array.isArray(value)) {
        value
          .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
          .filter(Boolean)
          .forEach((scope) => scopes.add(scope));
      }
    };

    add(claims.scope);
    add(claims.scopes);

    const capabilities = claims.capabilities;
    if (Array.isArray(capabilities)) {
      capabilities
        .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
        .filter(Boolean)
        .forEach((scope) => scopes.add(scope));
    }

    return scopes;
  }

  private mergeScopes(existing: string[], scopes: Set<string>): string[] {
    const merged = new Set<string>(
      existing.filter((scope) => typeof scope === 'string')
    );
    for (const scope of scopes) {
      merged.add(scope);
    }
    return Array.from(merged);
  }

  private hasRequiredScope(scopes: Set<string> | string[]): boolean {
    const candidate = scopes instanceof Set ? scopes : new Set(scopes);
    if (this.requiredScopes.size === 0) {
      return true;
    }
    for (const scope of this.requiredScopes) {
      if (candidate.has(scope)) {
        return true;
      }
    }
    return false;
  }

  private async validateTokenSubjectNodeIdentity(
    systemId: string,
    claims: Record<string, unknown>
  ): Promise<boolean> {
    const sub = claims.sub;

    if (typeof sub !== 'string' || sub.trim().length === 0) {
      logger.warning('oauth2_attach_missing_subject_claim', {
        system_id: systemId,
      });
      return false;
    }

    const expectedPrefix = await generateIdAsync({
      mode: 'fingerprint',
      material: sub,
      length: 8,
    });

    if (!systemId.startsWith(`${expectedPrefix}-`)) {
      logger.warning('oauth2_attach_node_identity_mismatch', {
        system_id: systemId,
        expected_prefix: expectedPrefix,
        subject: sub,
      });
      return false;
    }

    logger.debug('oauth2_attach_node_identity_verified', {
      system_id: systemId,
      expected_prefix: expectedPrefix,
    });

    return true;
  }
}

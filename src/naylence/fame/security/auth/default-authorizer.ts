import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
  NodeAttachFrame,
} from 'naylence-core';
import { createAuthorizationContext, DeliveryOriginType } from 'naylence-core';

import { getLogger } from '../../util/logging.js';
import type { NodeEventListener } from '../../node/node-event-listener.js';
import type { NodeLike } from '../../node/node-like.js';
import type { Authorizer } from './authorizer.js';
import type { TokenVerifier } from './token-verifier.js';
import type { TokenVerifierProvider } from './token-verifier-provider.js';

const logger = getLogger('default-authorizer');

function decodeCredentials(credentials: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(credentials);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(credentials).toString('utf-8');
  }

  throw new Error('Unable to decode credential bytes without TextDecoder support');
}

function normalizeToken(credentials: string | Uint8Array): string | undefined {
  const raw = typeof credentials === 'string' ? credentials : decodeCredentials(credentials);
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.toLowerCase().startsWith('bearer ')) {
    const candidate = trimmed.slice(7).trim();
    return candidate.length > 0 ? candidate : undefined;
  }

  return trimmed;
}

function isNodeAttachFrame(frame: FameEnvelope['frame']): frame is NodeAttachFrame {
  return Boolean(frame && typeof frame === 'object' && (frame as { type?: unknown }).type === 'NodeAttach');
}

interface NodeAuthorizationClaims {
  subject: string;
  instanceId: string;
  audience: string;
  assignedPath?: string;
  acceptedLogicals?: string[];
  acceptedCapabilities?: string[];
}

function extractNodeClaims(context: AuthorizationContext): NodeAuthorizationClaims | undefined {
  const claims = context.claims;
  if (!claims || typeof claims !== 'object') {
    return undefined;
  }

  const record = claims as Record<string, unknown>;

  const subject = typeof context.principal === 'string'
    ? context.principal
    : typeof record.sub === 'string'
      ? (record.sub as string)
      : undefined;

  const instanceId = typeof record.instance_id === 'string' ? (record.instance_id as string) : undefined;
  const audience = typeof record.aud === 'string' ? (record.aud as string) : undefined;

  if (!subject || !instanceId || !audience) {
    return undefined;
  }

  const assignedPath = typeof record.assigned_path === 'string' ? (record.assigned_path as string) : undefined;

  const acceptedLogicals = Array.isArray(record.accepted_logicals)
    ? (record.accepted_logicals as unknown[]).filter((item): item is string => typeof item === 'string')
    : undefined;

  const acceptedCapabilities = Array.isArray(record.accepted_capabilities)
    ? (record.accepted_capabilities as unknown[]).filter((item): item is string => typeof item === 'string')
    : undefined;

  const nodeClaims: NodeAuthorizationClaims = {
    subject,
    instanceId,
    audience,
  };

  if (assignedPath) {
    nodeClaims.assignedPath = assignedPath;
  }

  if (acceptedLogicals && acceptedLogicals.length > 0) {
    nodeClaims.acceptedLogicals = acceptedLogicals;
  }

  if (acceptedCapabilities && acceptedCapabilities.length > 0) {
    nodeClaims.acceptedCapabilities = acceptedCapabilities;
  }

  return nodeClaims;
}

function ensureSubset(tokenValues: string[] | undefined, requested: string[], errorMessage: string): void {
  if (!tokenValues || tokenValues.length === 0) {
    throw new Error(errorMessage);
  }

  const allowed = new Set(tokenValues);
  for (const value of requested) {
    if (!allowed.has(value)) {
      throw new Error(errorMessage);
    }
  }
}

export interface DefaultAuthorizerOptions {
  tokenVerifier?: TokenVerifier;
}

export class DefaultAuthorizer
  implements Authorizer, TokenVerifierProvider, NodeEventListener
{
  public readonly priority = 1000;

  private tokenVerifierImpl?: TokenVerifier;
  private node?: NodeLike;

  constructor(options: DefaultAuthorizerOptions = {}) {
    if (options.tokenVerifier) {
      this.tokenVerifierImpl = options.tokenVerifier;
    }
  }

  public get tokenVerifier(): TokenVerifier {
    if (!this.tokenVerifierImpl) {
      throw new Error('DefaultAuthorizer is not initialized properly, missing tokenVerifier');
    }

    return this.tokenVerifierImpl;
  }

  public set tokenVerifier(verifier: TokenVerifier) {
    this.tokenVerifierImpl = verifier;
  }

  public async onNodeStarted(node: NodeLike): Promise<void> {
    this.node = node;
  }

  public async authenticate(credentials: string | Uint8Array): Promise<AuthorizationContext | undefined> {
    const token = normalizeToken(credentials);
    if (!token) {
      return undefined;
    }

    try {
      const verifier = this.tokenVerifier;
      const expectedAudience = this.node?.physicalPath;
      const context = expectedAudience
        ? await verifier.verify(token, { expectedAudience })
        : await verifier.verify(token);

      return createAuthorizationContext({
        ...context,
        authenticated: true,
        authorized: context.authorized ?? true,
        authMethod: context.authMethod ?? 'jwt_fame_claims',
      });
    } catch (error) {
      logger.warning('token_verification_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  public async authorize(
    node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<AuthorizationContext | undefined> {
    const authorization = context?.security?.authorization;
    if (!authorization || !authorization.authenticated) {
      return undefined;
    }

    if (authorization.authorized) {
      return authorization;
    }

    if (
      isNodeAttachFrame(envelope.frame) &&
      context?.originType !== DeliveryOriginType.LOCAL
    ) {
      this.validateNodeAttach(node, envelope.frame, authorization);
    }

    return createAuthorizationContext({
      ...authorization,
      authorized: true,
      authMethod: authorization.authMethod ?? 'jwt_fame_claims',
    });
  }

  public async validateNodeAttachRequest(
    node: NodeLike,
    frame: NodeAttachFrame,
    authContext?: AuthorizationContext
  ): Promise<AuthorizationContext | undefined> {
    if (!authContext || !authContext.authenticated) {
      return undefined;
    }

    const claims = { ...(authContext.claims ?? {}) } as Record<string, unknown>;

    if (typeof claims.sub !== 'string') {
      claims.sub = authContext.principal ?? frame.systemId;
    }

    claims.instance_id = typeof claims.instance_id === 'string' ? claims.instance_id : frame.instanceId;
    claims.aud = typeof claims.aud === 'string' ? claims.aud : node.id;

    if (frame.assignedPath) {
      claims.assigned_path = frame.assignedPath;
    }

    if (Array.isArray(frame.capabilities)) {
      claims.accepted_capabilities = [...frame.capabilities];
    }

    if (Array.isArray(frame.acceptedLogicals)) {
      claims.accepted_logicals = [...frame.acceptedLogicals];
    }

    return createAuthorizationContext({
      ...authContext,
      claims,
      principal: authContext.principal ?? (typeof claims.sub === 'string' ? (claims.sub as string) : frame.systemId),
      authorized: true,
      authMethod: authContext.authMethod ?? 'jwt_fame_claims',
    });
  }

  private validateNodeAttach(node: NodeLike, frame: NodeAttachFrame, context: AuthorizationContext): void {
    const nodeClaims = extractNodeClaims(context);
    if (!nodeClaims) {
      return;
    }

    if (nodeClaims.subject !== frame.systemId) {
      throw new Error("Token sub doesn't match system id");
    }

    if (nodeClaims.instanceId !== frame.instanceId) {
      throw new Error('Token instance ID mismatch');
    }

    if (nodeClaims.audience !== node.id) {
      throw new Error("Token audience doesn't match target node");
    }

    if (frame.assignedPath && nodeClaims.assignedPath && frame.assignedPath !== nodeClaims.assignedPath) {
      throw new Error('Assigned path is not authorized by token');
    }

    if (Array.isArray(frame.acceptedLogicals) && frame.acceptedLogicals.length > 0) {
      ensureSubset(nodeClaims.acceptedLogicals, frame.acceptedLogicals, 'Logicals not authorized by token');
    }

    if (Array.isArray(frame.capabilities) && frame.capabilities.length > 0) {
      ensureSubset(nodeClaims.acceptedCapabilities, frame.capabilities, 'Capabilities not authorized by token');
    }
  }
}

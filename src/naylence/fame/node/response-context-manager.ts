import {
  DeliveryOriginType,
  FameDeliveryContext,
  FameEnvelope,
  FameResponseType,
  SecurityContext,
} from 'naylence-core';
import { getLogger } from '../util/logging.js';

const logger = getLogger('response-context-manager');

type MaybeSecurityContext = SecurityContext | null | undefined;

type OptionalContext = FameDeliveryContext | null | undefined;

function cloneSecurityContext(
  source: MaybeSecurityContext
): SecurityContext | undefined {
  if (!source) {
    return undefined;
  }

  const clone: SecurityContext = {
    inboundCryptoLevel: source.inboundCryptoLevel,
    inboundWasSigned: source.inboundWasSigned,
    cryptoChannelId: source.cryptoChannelId,
  };

  if (source.authorization) {
    clone.authorization = source.authorization;
  }

  return clone;
}

export class ResponseContextManager {
  constructor(private readonly getId: () => string) {}

  createResponseContext(
    requestEnvelope: FameEnvelope,
    requestContext?: OptionalContext
  ): FameDeliveryContext {
    const requestSecurity = requestContext?.security;
    const responseSecurity = cloneSecurityContext(requestSecurity);

    const responseContext: FameDeliveryContext = {
      originType: DeliveryOriginType.LOCAL,
      fromSystemId: this.getId(),
      security: responseSecurity,
      expectedResponseType:
        requestContext?.expectedResponseType ?? FameResponseType.NONE,
    };

    logger.debug('created_response_context', {
      request_id: requestEnvelope.id,
      inherited_crypto_level: responseSecurity?.inboundCryptoLevel ?? null,
      channel_id: responseSecurity?.cryptoChannelId ?? null,
    });

    return responseContext;
  }

  ensureResponseMetadata(
    responseEnvelope: FameEnvelope,
    requestEnvelope: FameEnvelope,
    responseContext?: OptionalContext
  ): void {
    if (responseContext) {
      if (!responseContext.meta) {
        responseContext.meta = {};
      }

      responseContext.meta['message-type'] = 'response';
      if (requestEnvelope.id) {
        responseContext.meta['response-to-id'] = requestEnvelope.id;
      }

      responseContext.originType = DeliveryOriginType.LOCAL;
      responseContext.fromSystemId = this.getId();
    }

    // Envelope-level metadata is intentionally omitted to defer to context usage.
    logger.debug('ensured_response_metadata', {
      response_id: responseEnvelope.id,
      request_id: requestEnvelope.id,
    });
  }
}

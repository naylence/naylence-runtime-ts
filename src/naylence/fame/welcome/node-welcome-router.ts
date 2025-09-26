import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { createFameEnvelope, FameEnvelopeSchema } from 'naylence-core';

import type { FameEnvelopeWith, NodeHelloFrame, NodeWelcomeFrame } from 'naylence-core';
import type { WelcomeService } from './welcome-service.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.welcome.NodeWelcomeRouter');

const PROTO_MAJOR = 1;
const DEFAULT_PREFIX = `/fame/v${PROTO_MAJOR}/welcome` as const;

export interface NodeWelcomeRouterOptions {
  welcomeService: WelcomeService;
  prefix?: string;
}

type HelloRequest = FastifyRequest<{ Body: unknown }>;

class HelloValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HelloValidationError';
  }
}

export const nodeWelcomeRouter: FastifyPluginAsync<NodeWelcomeRouterOptions> = async (
  fastify: FastifyInstance,
  options: NodeWelcomeRouterOptions
) => {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const welcomeService = options.welcomeService;

  if (!welcomeService) {
    throw new Error('Node welcome router requires a welcome service instance');
  }

  fastify.post(
    `${prefix}/hello`,
    async (request: HelloRequest, reply) => {
  const rawAuth = request.headers['authorization'];
  const authHeader = Array.isArray(rawAuth) ? rawAuth[0] ?? '' : rawAuth ?? '';

      if (welcomeService.authorizer) {
        const authResult = await welcomeService.authorizer.authenticate(authHeader);
        if (!authResult) {
          logger.warning('client_authentication_failed', {
            authorizerType: welcomeService.authorizer.constructor?.name ?? 'UnknownAuthorizer',
          });
          return reply.status(401).send({ detail: 'Authentication failed' });
        }
      }

      let envelope: FameEnvelopeWith<NodeHelloFrame>;
      try {
        const candidateBody = typeof request.body === 'object' && request.body !== null
          ? { ...(request.body as Record<string, unknown>) }
          : request.body;

        if (candidateBody && typeof candidateBody === 'object' && 'ts' in candidateBody) {
          const tsValue = (candidateBody as Record<string, unknown>).ts;
          if (typeof tsValue === 'string') {
            (candidateBody as Record<string, unknown>).ts = new Date(tsValue);
          }
        }

        const parsed = FameEnvelopeSchema.parse(candidateBody);
        if (parsed.frame?.type !== 'NodeHello') {
          throw new HelloValidationError('Envelope must contain a NodeHello frame');
        }
        envelope = parsed as FameEnvelopeWith<NodeHelloFrame>;
      } catch (error) {
        if (error instanceof ZodError) {
          logger.error('hello_envelope_validation_failed', {
            issues: error.issues,
          });
          return reply.status(422).send({ detail: error.message });
        }

        if (error instanceof HelloValidationError) {
          logger.error('hello_envelope_validation_failed', {
            detail: error.message,
          });
          return reply.status(422).send({ detail: error.message });
        }

        logger.error('hello_envelope_deserialization_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return reply.status(422).send({ detail: 'Invalid hello envelope' });
      }

      const helloFrame: NodeHelloFrame = envelope.frame;

      try {
        const welcomeFrame: NodeWelcomeFrame = await welcomeService.handleHello(helloFrame);
        const responseEnvelope = createFameEnvelope({ frame: welcomeFrame });
        return reply.send(responseEnvelope);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal error';
        logger.error('hello_handling_failed', {
          error: message,
        });
        return reply.status(500).send({ detail: message });
      }
    }
  );
};

export const nodeWelcomeRouterPlugin = nodeWelcomeRouter;
import { z } from 'zod';
import {
  AuthorizationContextSchema,
  type AuthorizationContext,
  FameDeliveryContextSchema,
  type FameDeliveryContext,
  SecurityContextSchema,
} from '@naylence/core';

export const FameNodeAuthorizationContextSchema: z.ZodTypeAny =
  AuthorizationContextSchema.and(
    z.object({
      sub: z.string().optional(),
      aud: z.string().optional(),
      assignedPath: z.string().optional(),
      acceptedCapabilities: z.array(z.string()).optional(),
      acceptedLogicals: z.array(z.string()).optional(),
      instanceId: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      attachExpiresAt: z.coerce.date().optional(),
    })
  );

export type FameNodeAuthorizationContext = AuthorizationContext &
  z.infer<typeof FameNodeAuthorizationContextSchema>;

export const FameAuthorizedDeliveryContextSchema: z.ZodTypeAny =
  FameDeliveryContextSchema.extend({
    security: SecurityContextSchema.extend({
      authorization: FameNodeAuthorizationContextSchema.optional(),
    }).optional(),
  });

export type FameAuthorizedDeliveryContext = FameDeliveryContext &
  z.infer<typeof FameAuthorizedDeliveryContextSchema>;

export interface CreateNodeDeliveryContextOptions
  extends Omit<
    z.input<typeof FameAuthorizedDeliveryContextSchema>,
    'security'
  > {
  security?: z.input<typeof SecurityContextSchema> | null;
  authorization?: z.input<typeof FameNodeAuthorizationContextSchema> | null;
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.keys(value as Record<string, unknown>).length
  );
}

export function createNodeDeliveryContext(
  options: CreateNodeDeliveryContextOptions = {}
): FameAuthorizedDeliveryContext {
  const { security, authorization, ...rest } = options;

  const securityPayload: Record<string, unknown> | undefined = (() => {
    if (!security && !authorization) {
      return undefined;
    }

    const baseSecurity = security ? SecurityContextSchema.parse(security) : {};

    if (authorization) {
      return {
        ...baseSecurity,
        authorization: FameNodeAuthorizationContextSchema.parse(authorization),
      };
    }

    return isNonEmptyObject(baseSecurity) ? baseSecurity : undefined;
  })();

  return FameAuthorizedDeliveryContextSchema.parse({
    ...rest,
    security: securityPayload,
  }) as FameAuthorizedDeliveryContext;
}

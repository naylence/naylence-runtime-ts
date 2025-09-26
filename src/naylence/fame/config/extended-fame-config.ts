import { z } from 'zod';
import { FameConfigSchema, type FameConfig } from 'naylence-core';

export const ExtendedFameConfigSchema = FameConfigSchema.extend({
  node: z.unknown().optional(),
  welcome: z.unknown().optional(),
}).passthrough();

export type ExtendedFameConfig = z.infer<typeof ExtendedFameConfigSchema>;

export function normalizeExtendedFameConfig(
  config: FameConfig | Record<string, unknown>
): ExtendedFameConfig {
  return ExtendedFameConfigSchema.parse(config);
}

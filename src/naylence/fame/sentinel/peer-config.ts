import { z } from "zod";

import type { AdmissionConfig } from "../node/admission/admission-client-factory.js";

export interface PeerConfig {
  directUrl: string | null;
  admission: AdmissionConfig | Record<string, unknown> | null;
}

const PeerConfigSchema = z
  .object({
    directUrl: z.string().trim().min(1).optional().nullable(),
    admission: z.unknown().optional().nullable(),
  })
  .passthrough();

export function normalizePeerConfigs(input: unknown): PeerConfig[] {
  if (!input) {
    return [];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  const peers: PeerConfig[] = [];

  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const parsed = PeerConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }

    const { directUrl = null, admission = null } = parsed.data;

    peers.push({
      directUrl: typeof directUrl === "string" ? directUrl : null,
      admission: (admission ?? null) as AdmissionConfig | Record<string, unknown> | null,
    });
  }

  return peers;
}

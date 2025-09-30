import {
  createFameEnvelope,
  generateIdAsync,
  type FameEnvelopeWith,
  type NodeWelcomeFrame,
} from "naylence-core";
import {
  DEFAULT_DIRECT_ADMISSION_TTL_SEC,
  TTL_NEVER_EXPIRES,
} from "../../constants/ttl-constants.js";
import { getLogger } from "../../util/logging.js";
import { validateTtlSec } from "../../util/ttl-validation.js";
import type { AdmissionClient } from "./admission-client.js";

const logger = getLogger("direct-admission-client");

export interface DirectAdmissionClientOptions {
  readonly connectionGrants: Array<Record<string, unknown>>;
  readonly ttlSec?: number | null;
}

export class DirectAdmissionClient implements AdmissionClient {
  public readonly hasUpstream = true;

  private readonly connectionGrants: Array<Record<string, unknown>>;
  private readonly ttlSec: number | null | undefined;

  constructor(options: DirectAdmissionClientOptions) {
    if (!Array.isArray(options.connectionGrants) || options.connectionGrants.length === 0) {
      throw new Error("DirectAdmissionClient requires at least one connection grant");
    }

    this.connectionGrants = options.connectionGrants.map((grant) => cloneGrant(grant));

    const ttlCandidate = options.ttlSec ?? TTL_NEVER_EXPIRES;
    if (ttlCandidate != null && ttlCandidate !== TTL_NEVER_EXPIRES) {
      const validated = validateTtlSec(ttlCandidate, {
        min: 60,
        max: 86400 * 7,
        allowNeverExpires: true,
        context: "Direct admission TTL",
      });

      this.ttlSec = typeof validated === "number" ? validated : ttlCandidate;
    } else {
      this.ttlSec = ttlCandidate;
    }
  }

  public async hello(
    systemId: string,
    instanceId: string,
    requestedLogicals?: string[]
  ): Promise<FameEnvelopeWith<NodeWelcomeFrame>> {
    logger.debug("direct_admission_hello_start", {
      providedSystemId: systemId,
      instanceId,
      requestedLogicals,
    });

    const effectiveSystemId =
      systemId && systemId.trim().length > 0
        ? systemId
        : await generateIdAsync({ mode: "fingerprint" }).catch(async () => {
            logger.debug("direct_admission_fingerprint_generation_failed", {
              reason: "falling back to random id",
            });
            return generateIdAsync({ mode: "random" });
          });

    const acceptedLogicals =
      requestedLogicals && requestedLogicals.length > 0 ? [...requestedLogicals] : ["*"];

    const now = Date.now();
    const ttlSeconds = this.resolveTtlSeconds();
    const expiresAt = new Date(now + ttlSeconds * 1000);

    const welcomeFrame: NodeWelcomeFrame = {
      type: "NodeWelcome",
      systemId: effectiveSystemId,
      instanceId,
      acceptedLogicals,
      connectionGrants: this.connectionGrants.map((grant) => cloneGrant(grant)),
      expiresAt: expiresAt.toISOString(),
    };

    const envelope = createFameEnvelope({
      frame: welcomeFrame,
    }) as FameEnvelopeWith<NodeWelcomeFrame>;

    logger.debug("direct_admission_hello_success", {
      systemId: welcomeFrame.systemId,
      instanceId: welcomeFrame.instanceId,
      acceptedLogicals: welcomeFrame.acceptedLogicals,
      grantCount: welcomeFrame.connectionGrants?.length ?? 0,
      expiresAt: welcomeFrame.expiresAt,
    });

    return envelope;
  }

  public async close(): Promise<void> {
    // Nothing to clean up for direct admission
  }

  private resolveTtlSeconds(): number {
    if (this.ttlSec == null || this.ttlSec === TTL_NEVER_EXPIRES) {
      return DEFAULT_DIRECT_ADMISSION_TTL_SEC;
    }

    return this.ttlSec;
  }
}

function cloneGrant(grant: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(grant));
}

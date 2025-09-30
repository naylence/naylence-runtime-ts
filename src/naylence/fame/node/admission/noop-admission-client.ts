import { createFameEnvelope, type FameEnvelopeWith, type NodeWelcomeFrame } from "naylence-core";
import { getLogger } from "../../util/logging.js";
import type { AdmissionClient } from "./admission-client.js";

const logger = getLogger("noop-admission-client");

export interface NoopAdmissionClientOptions {
  readonly systemId?: string;
  readonly autoAcceptLogicals?: boolean;
}

export class NoopAdmissionClient implements AdmissionClient {
  public readonly hasUpstream = false;

  private readonly defaultSystemId: string;
  private readonly autoAcceptLogicals: boolean;

  constructor(options: NoopAdmissionClientOptions = {}) {
    this.defaultSystemId = options.systemId ?? "noop-system";
    this.autoAcceptLogicals = options.autoAcceptLogicals ?? true;
  }

  public async hello(
    systemId: string,
    instanceId: string,
    requestedLogicals?: string[]
  ): Promise<FameEnvelopeWith<NodeWelcomeFrame>> {
    const effectiveSystemId =
      systemId && systemId.trim().length > 0 ? systemId : this.defaultSystemId;
    const acceptedLogicals = this.autoAcceptLogicals ? [...(requestedLogicals ?? [])] : [];

    logger.debug("noop_admission_hello", {
      systemId: effectiveSystemId,
      instanceId,
      requestedLogicals,
      acceptedLogicals,
    });

    const welcomeFrame: NodeWelcomeFrame = {
      type: "NodeWelcome",
      systemId: effectiveSystemId,
      instanceId,
      acceptedLogicals,
      connectionGrants: [],
    };

    return createFameEnvelope({ frame: welcomeFrame }) as FameEnvelopeWith<NodeWelcomeFrame>;
  }

  public async close(): Promise<void> {
    logger.debug("noop_admission_close");
  }
}

import type { FameDeliveryContext, FameEnvelope } from "naylence-core";

import type { NodeEventListener } from "../node/node-event-listener.js";
import type { NodeLike } from "../node/node-like.js";
import type { Authorizer } from "./auth/authorizer.js";
import type { CertificateManager } from "./cert/certificate-manager.js";
import type { EncryptionManager } from "./encryption/encryption-manager.js";
import type { KeyManager } from "./keys/key-manager.js";
import type { SecurityPolicy } from "./policy/security-policy.js";
import type { EnvelopeSigner } from "./signing/envelope-signer.js";
import type { EnvelopeVerifier } from "./signing/envelope-verifier.js";
import type { EnvelopeSecurityHandler } from "../node/envelope-security-handler.js";
import type { SecureChannelFrameHandler } from "../node/secure-channel-frame-handler.js";

// export interface EnvelopeSecurityHandler {
//   handleOutboundSecurity(envelope: FameEnvelope, context: FameDeliveryContext): Promise<boolean>;
//   handleEnvelopeSecurity(
//     envelope: FameEnvelope,
//     context?: FameDeliveryContext
//   ): Promise<[FameEnvelope, boolean]>;
// }

// export interface SecureChannelFrameHandler {
//   onSecureChannelEstablished?(channelId: string, destination: string): Promise<void> | void;
//   onSecureChannelFailed?(channelId: string, destination: string, reason?: string): Promise<void> | void;
// }

export interface SecurityManager extends NodeEventListener {
  readonly policy: SecurityPolicy;
  readonly envelopeSigner: EnvelopeSigner | null;
  readonly envelopeVerifier: EnvelopeVerifier | null;
  readonly encryption: EncryptionManager | null;
  readonly keyManager: KeyManager | null;
  readonly supportsOverlaySecurity: boolean;
  readonly authorizer: Authorizer | null;
  readonly certificateManager: CertificateManager | null;
  readonly envelopeSecurityHandler: EnvelopeSecurityHandler | null;
  readonly secureChannelFrameHandler: SecureChannelFrameHandler | null;

  getEncryptionKeyId(): string | undefined;

  getShareableKeys(): Record<string, unknown> | Array<Record<string, unknown>> | undefined;

  onNodeStarted?(node: NodeLike): Promise<void>;
  onNodeStopped?(node: NodeLike): Promise<void>;
  onDeliver?(
    node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null>;
}

import type { NodeWelcomeFrame } from '@naylence/core';

import type { NodeEventListener } from '../../node/node-event-listener.js';

export interface CertificateManager extends NodeEventListener {
  ensureCertificate(
    welcomeFrame: NodeWelcomeFrame,
    options?: { caServiceUrl?: string }
  ): Promise<boolean>;
}

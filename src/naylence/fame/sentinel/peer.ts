import type { AdmissionClient } from '../node/admission/admission-client.js';

export interface PeerOptions {
  admissionClient: AdmissionClient;
}

export class Peer {
  public readonly admissionClient: AdmissionClient;

  constructor(options: PeerOptions) {
    this.admissionClient = options.admissionClient;
  }
}

import { SigningMaterial } from 'naylence-core';

export interface SigningConfigOptions {
  signingMaterial?: SigningMaterial;
  validateCertNameConstraints?: boolean;
  requireCertSidMatch?: boolean;
  requireCertLogicalMatch?: boolean;
}

export class SigningConfig {
  public readonly signingMaterial: SigningMaterial;
  public readonly validateCertNameConstraints: boolean;
  public readonly requireCertSidMatch: boolean;
  public readonly requireCertLogicalMatch: boolean;

  public constructor(options: SigningConfigOptions = {}) {
    this.signingMaterial = options.signingMaterial ?? SigningMaterial.RAW_KEY;
    this.validateCertNameConstraints =
      options.validateCertNameConstraints ?? true;
    this.requireCertSidMatch = options.requireCertSidMatch ?? false;
    this.requireCertLogicalMatch = options.requireCertLogicalMatch ?? false;
  }

  public static forDevelopment(): SigningConfig {
    return new SigningConfig({
      signingMaterial: SigningMaterial.RAW_KEY,
      validateCertNameConstraints: true,
      requireCertSidMatch: false,
      requireCertLogicalMatch: false,
    });
  }
}

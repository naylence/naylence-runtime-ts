import { SigningMaterial } from '@naylence/core';
import { resolveAlias } from '../policy/policy-alias-normalizer.js';

export interface SigningConfigOptions {
  signingMaterial?: SigningMaterial;
  validateCertNameConstraints?: boolean;
  requireCertSidMatch?: boolean;
  requireCertLogicalMatch?: boolean;
}

type SigningConfigInput =
  | SigningConfigOptions
  | Record<string, unknown>
  | null
  | undefined;

function normalizeSigningConfigOptions(
  options?: SigningConfigInput
): SigningConfigOptions {
  if (!options || typeof options !== 'object') {
    return {};
  }

  const candidate = options as Record<string, unknown>;
  const result: SigningConfigOptions = {
    ...(options as SigningConfigOptions),
  };

  const signingMaterialValue = resolveAlias<SigningMaterial | string | null | undefined>(
    candidate,
    ['signingMaterial', 'signing_material']
  );
  if (typeof signingMaterialValue === 'string') {
    if (
      signingMaterialValue === SigningMaterial.RAW_KEY ||
      signingMaterialValue === SigningMaterial.X509_CHAIN
    ) {
      result.signingMaterial = signingMaterialValue;
    }
  }

  const validateCertNameConstraintsValue = resolveAlias<unknown>(candidate, [
    'validateCertNameConstraints',
    'validate_cert_name_constraints',
  ]);
  if (typeof validateCertNameConstraintsValue === 'boolean') {
    result.validateCertNameConstraints = validateCertNameConstraintsValue;
  }

  const requireCertSidMatchValue = resolveAlias<unknown>(candidate, [
    'requireCertSidMatch',
    'require_cert_sid_match',
  ]);
  if (typeof requireCertSidMatchValue === 'boolean') {
    result.requireCertSidMatch = requireCertSidMatchValue;
  }

  const requireCertLogicalMatchValue = resolveAlias<unknown>(candidate, [
    'requireCertLogicalMatch',
    'require_cert_logical_match',
  ]);
  if (typeof requireCertLogicalMatchValue === 'boolean') {
    result.requireCertLogicalMatch = requireCertLogicalMatchValue;
  }

  return result;
}

export class SigningConfig {
  public readonly signingMaterial: SigningMaterial;
  public readonly validateCertNameConstraints: boolean;
  public readonly requireCertSidMatch: boolean;
  public readonly requireCertLogicalMatch: boolean;

  public constructor(options: SigningConfigInput = {}) {
    const normalized = normalizeSigningConfigOptions(options);

    this.signingMaterial =
      normalized.signingMaterial ?? SigningMaterial.RAW_KEY;
    this.validateCertNameConstraints =
      normalized.validateCertNameConstraints ?? true;
    this.requireCertSidMatch = normalized.requireCertSidMatch ?? false;
    this.requireCertLogicalMatch =
      normalized.requireCertLogicalMatch ?? false;
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

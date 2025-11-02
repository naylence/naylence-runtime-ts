const LEGACY_ERROR_CODES: Record<string, string> = {
  crypto_level_violation: 'cryptoLevelViolation',
  signature_required: 'signatureRequired',
  signature_verification_failed: 'signatureVerificationFailed',
};

export function formatDeliveryErrorMessage(
  code?: string,
  reason?: string
): string {
  const normalizedCode = normalizeErrorCode(code);

  if (normalizedCode === 'cryptoLevelViolation') {
    return 'Message rejected due to insufficient encryption.';
  }
  if (normalizedCode === 'signatureRequired') {
    return 'Message rejected because it lacks a required digital signature.';
  }
  if (normalizedCode === 'signatureVerificationFailed') {
    return 'Message rejected because its digital signature could not be verified.';
  }

  const suffix = reason ? `: ${reason}` : '';
  return `Message delivery failed with code '${normalizedCode ?? 'unknown'}'${suffix}`;
}

function normalizeErrorCode(code?: string): string | undefined {
  if (!code) {
    return code;
  }
  if (LEGACY_ERROR_CODES[code]) {
    return LEGACY_ERROR_CODES[code];
  }
  return code;
}

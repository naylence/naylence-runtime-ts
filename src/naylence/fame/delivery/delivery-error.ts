export function formatDeliveryErrorMessage(
  code?: string,
  reason?: string
): string {
  if (code === 'crypto_level_violation') {
    return 'Message rejected due to insufficient encryption.';
  }
  if (code === 'signature_required') {
    return 'Message rejected because it lacks a required digital signature.';
  }
  if (code === 'signature_verification_failed') {
    return 'Message rejected because its digital signature could not be verified.';
  }

  const suffix = reason ? `: ${reason}` : '';
  return `Message delivery failed with code '${code ?? 'unknown'}'${suffix}`;
}

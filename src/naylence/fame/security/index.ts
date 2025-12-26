export * from './auth/authorizer.js';
export * from './auth/auth-identity.js';
export * from './auth/policy-authorizer.js';
export {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
} from './auth/authorizer-factory.js';
export type * from './auth/authorizer-factory.js';
export {
  AuthorizationProfileFactory,
  PROFILE_NAME_DEFAULT as AUTH_PROFILE_NAME_DEFAULT,
  PROFILE_NAME_OAUTH2 as AUTH_PROFILE_NAME_OAUTH2,
  PROFILE_NAME_OAUTH2_GATED as AUTH_PROFILE_NAME_OAUTH2_GATED,
  PROFILE_NAME_OAUTH2_CALLBACK as AUTH_PROFILE_NAME_OAUTH2_CALLBACK,
  PROFILE_NAME_NOOP as AUTH_PROFILE_NAME_NOOP,
  ENV_VAR_JWT_TRUSTED_ISSUER as AUTH_PROFILE_ENV_VAR_JWT_TRUSTED_ISSUER,
  ENV_VAR_JWT_ALGORITHM as AUTH_PROFILE_ENV_VAR_JWT_ALGORITHM,
  ENV_VAR_JWT_AUDIENCE as AUTH_PROFILE_ENV_VAR_JWT_AUDIENCE,
  ENV_VAR_JWKS_URL as AUTH_PROFILE_ENV_VAR_JWKS_URL,
  ENV_VAR_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY as AUTH_PROFILE_ENV_VAR_ENFORCE_TOKEN_SUBJECT_NODE_IDENTITY,
  ENV_VAR_TRUSTED_CLIENT_SCOPE as AUTH_PROFILE_ENV_VAR_TRUSTED_CLIENT_SCOPE,
  ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER as AUTH_PROFILE_ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER,
  ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE as AUTH_PROFILE_ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE,
  ENV_VAR_HMAC_SECRET as AUTH_PROFILE_ENV_VAR_HMAC_SECRET,
} from './auth/authorization-profile-factory.js';
export type { AuthorizationProfileConfig } from './auth/authorization-profile-factory.js';
export * from './auth/auth-injection-strategy.js';

// Authorization policy exports
export * from './auth/policy/index.js';
export {
  AUTH_INJECTION_STRATEGY_FACTORY_BASE_TYPE,
  AuthInjectionStrategyFactory,
} from './auth/auth-injection-strategy-factory.js';
export type * from './auth/auth-injection-strategy-factory.js';
export * from './auth/token-issuer.js';
export {
  TOKEN_ISSUER_FACTORY_BASE_TYPE,
  TokenIssuerFactory,
} from './auth/token-issuer-factory.js';
export type * from './auth/token-issuer-factory.js';
export {
  TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  TokenVerifierFactory,
} from './auth/token-verifier-factory.js';
export type * from './auth/token-verifier-factory.js';
export * from './auth/token-verifier-provider.js';
export * from './auth/token-verifier.js';
export * from './auth/token-provider.js';
export {
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  TokenProviderFactory,
} from './auth/token-provider-factory.js';
export type * from './auth/token-provider-factory.js';
export * from './auth/token.js';
export * from './cert/certificate-manager.js';
export {
  CERTIFICATE_MANAGER_FACTORY_BASE_TYPE,
  CertificateManagerFactory,
} from './cert/certificate-manager-factory.js';
export type * from './cert/certificate-manager-factory.js';
export * from './trust-store/trust-store-provider.js';
export {
  TRUST_STORE_PROVIDER_FACTORY_BASE_TYPE,
  TrustStoreProviderFactory,
  NoopTrustStoreProvider,
} from './trust-store/trust-store-provider-factory.js';
export type * from './trust-store/trust-store-provider-factory.js';
export * from './encryption/encryption-manager.js';
export { ENCRYPTION_MANAGER_FACTORY_BASE_TYPE } from './encryption/encryption-manager-factory.js';
export * from './encryption/encryption-manager-factory.js';
export * from './encryption/noop-encryption-manager.js';
export * from './encryption/secure-channel-manager.js';
export {
  SECURE_CHANNEL_MANAGER_FACTORY_BASE_TYPE,
  SecureChannelManagerFactory,
  SecureChannelManagerConfig,
} from './encryption/secure-channel-manager-factory.js';
export * from './keys/key-manager.js';
export { KEY_MANAGER_FACTORY_BASE_TYPE } from './keys/key-manager-factory.js';
export * from './keys/key-manager-factory.js';
export * from './keys/default-key-manager.js';
export * from './keys/attachment-key-validator.js';
export { ATTACHMENT_KEY_VALIDATOR_FACTORY_BASE_TYPE } from './keys/attachment-key-validator-factory.js';
export type * from './keys/attachment-key-validator-factory.js';
export * from './keys/noop-key-validator.js';
export * from './keys/key-management-handler.js';
export * from './keys/key-provider.js';
export * from './keys/key-store.js';
export { KEY_STORE_FACTORY_BASE_TYPE } from './keys/key-store-factory.js';
export * from './keys/key-store-factory.js';
export * from './crypto/jwk-validation.js';
export * from './crypto/key-factories/index.js';
export * from './crypto/sealed-envelope.js';
export * from './policy/security-policy.js';
export { SECURITY_POLICY_FACTORY_BASE_TYPE } from './policy/security-policy-factory.js';
export type * from './policy/security-policy-factory.js';
export * from './policy/default-security-policy.js';
export * from './default-security-manager.js';
export * from './policy/no-security-policy.js';
export * from './security-manager.js';
export * from './security-manager-config.js';
export { SECURITY_MANAGER_FACTORY_BASE_TYPE } from './security-manager-factory.js';
export type * from './security-manager-factory.js';
export * from './signing/envelope-signer.js';
export * from './signing/envelope-verifier.js';
export {
  SigningConfig as SigningConfigClass,
  type SigningConfigOptions,
} from './signing/signing-config.js';
export {
  canonicalJson,
  decodeBase64Url,
  frameDigest,
  immutableHeaders,
} from './signing/eddsa-signer-verifier.js';
export { encodeUtf8 } from './signing/eddsa-utils.js';
export {
  EdDSAEnvelopeSigner,
  type EdDSAEnvelopeSignerOptions,
} from './signing/eddsa-envelope-signer.js';
export * from './crypto/providers/crypto-provider.js';
export * from './crypto/providers/default-crypto-provider.js';
export * from './credential/credential-provider.js';
export * from './crypto/crypto-dependencies.js';
export { CREDENTIAL_PROVIDER_FACTORY_BASE_TYPE } from './credential/credential-provider-factory.js';
export type * from './credential/credential-provider-factory.js';
export * from './credential/env-credential-provider.js';
export * from './credential/none-credential-provider.js';
export * from './credential/prompt-credential-provider.js';
export * from './credential/secret-source.js';
export * from './credential/secret-store-credential-provider.js';
export * from './credential/static-credential-provider.js';
export * from './credential/browser-auto-key-credential-provider.js';
export * from './credential/browser-wrapped-key-credential-provider.js';
export * from './credential/session-key-credential-provider.js';
export * from './credential/dev-fixed-key-credential-provider.js';
export {
  ENV_VAR_JWT_TRUSTED_ISSUER,
  ENV_VAR_JWT_ALGORITHM,
  ENV_VAR_JWT_AUDIENCE,
  ENV_VAR_JWKS_URL,
  ENV_VAR_DEFAULT_ENCRYPTION_LEVEL,
  ENV_VAR_HMAC_SECRET,
  ENV_VAR_JWT_REVERSE_AUTH_TRUSTED_ISSUER,
  ENV_VAR_JWT_REVERSE_AUTH_AUDIENCE,
  ENV_VAR_AUTHORIZATION_PROFILE,
  PROFILE_NAME_OVERLAY,
  PROFILE_NAME_OVERLAY_CALLBACK,
  PROFILE_NAME_GATED,
  PROFILE_NAME_GATED_CALLBACK,
  PROFILE_NAME_OPEN,
} from './node-security-profile-factory.js';

import type { FameDeliveryContext, FameEnvelope } from 'naylence-core';

import type { NodeLike } from '../../node/node-like.js';
import type { EncryptionOptions } from '../encryption/encryption-manager.js';
import {
	CryptoLevel,
	SecurityAction,
	SecurityRequirements,
	type SecurityPolicy,
} from './security-policy.js';

export class NoSecurityPolicy implements SecurityPolicy {
	public async shouldSignEnvelope(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null,
		_nodeLike?: NodeLike | null
	): Promise<boolean> {
		return false;
	}

	public async shouldEncryptEnvelope(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null,
		_nodeLike?: NodeLike | null
	): Promise<boolean> {
		return false;
	}

	public async getEncryptionOptions(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null,
		_nodeLike?: NodeLike | null
	): Promise<EncryptionOptions | undefined> {
		return undefined;
	}

	public async shouldVerifySignature(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null
	): Promise<boolean> {
		return false;
	}

	public async shouldDecryptEnvelope(
		{ sec }: FameEnvelope,
		_context?: FameDeliveryContext | null,
		_nodeLike?: NodeLike | null
	): Promise<boolean> {
		return Boolean(sec?.enc);
	}

	public classifyMessageCryptoLevel(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null
	): CryptoLevel {
		return CryptoLevel.PLAINTEXT;
	}

	public isInboundCryptoLevelAllowed(
		_cryptoLevel: CryptoLevel,
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null
	): boolean {
		return true;
	}

	public getInboundViolationAction(
		_cryptoLevel: CryptoLevel,
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null
	): SecurityAction {
		return SecurityAction.ALLOW;
	}

	public async decideResponseCryptoLevel(
		_requestCryptoLevel: CryptoLevel,
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null
	): Promise<CryptoLevel> {
		return CryptoLevel.PLAINTEXT;
	}

	public async decideOutboundCryptoLevel(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null,
		_nodeLike?: NodeLike | null
	): Promise<CryptoLevel> {
		return CryptoLevel.PLAINTEXT;
	}

	public isSignatureRequired(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null
	): boolean {
		return false;
	}

	public getUnsignedViolationAction(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null
	): SecurityAction {
		return SecurityAction.ALLOW;
	}

	public getInvalidSignatureViolationAction(
		_envelope: FameEnvelope,
		_context?: FameDeliveryContext | null
	): SecurityAction {
		return SecurityAction.ALLOW;
	}

	public requirements(): SecurityRequirements {
		return new SecurityRequirements({
			signingRequired: false,
			verificationRequired: false,
			encryptionRequired: false,
			decryptionRequired: false,
			minimumCryptoLevel: CryptoLevel.PLAINTEXT,
			supportedSigningAlgorithms: new Set(),
			supportedEncryptionAlgorithms: new Set(),
			preferredSigningAlgorithms: [],
			preferredEncryptionAlgorithms: [],
			preferredSigningAlgorithm: null,
			preferredEncryptionAlgorithm: null,
		});
	}
}

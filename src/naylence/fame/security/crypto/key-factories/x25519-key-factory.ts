import { requireCryptoSupport } from "../crypto-dependencies.js";
import { requireJose } from "../../auth/jose-loader.js";
import { DevKeyPair } from "./dev-key-pair.js";

export async function createX25519Keypair(kid = "dev-x25519"): Promise<DevKeyPair> {
  requireCryptoSupport();
  const jose = await requireJose();
  void kid;
  const keyPair = await jose.generateKeyPair("ECDH-ES", { extractable: true, crv: "X25519" });
  const privatePem = await jose.exportPKCS8(keyPair.privateKey);
  const publicPem = await jose.exportSPKI(keyPair.publicKey);

  return {
    privatePem,
    publicPem,
    jwks: { keys: [] },
  };
}

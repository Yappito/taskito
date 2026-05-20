import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";

export function encryptAiSecret(secret: string) {
  return encryptSecret(secret);
}

export function decryptAiSecret(encryptedSecret: string) {
  return decryptSecret(encryptedSecret);
}

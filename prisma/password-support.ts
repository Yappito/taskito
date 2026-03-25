const PASSWORD_MIN_LENGTH = 12;
const ARGON2_ID_ALGORITHM = 2;

const ARGON2_OPTIONS = {
  memoryCost: 19 * 1024,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

export { PASSWORD_MIN_LENGTH };

export async function hashPassword(password: string) {
  const importedModule = await import("@node-rs/argon2");
  const argon2 = ("default" in importedModule ? importedModule.default : importedModule) as typeof import("@node-rs/argon2");

  return argon2.hash(password, {
    ...ARGON2_OPTIONS,
    algorithm: ARGON2_ID_ALGORITHM,
  });
}
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/password-policy";

const ARGON2_ID_ALGORITHM = 2;

const ARGON2_OPTIONS = {
  memoryCost: 19 * 1024,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

const ARGON2_PREFIX = "$argon2id$";
const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"];
const ARGON2_PARAMETER_PATTERN = /\$m=(\d+),t=(\d+),p=(\d+)\$/;

async function getArgon2Module() {
  const importedModule = await import("@node-rs/argon2");
  return (("default" in importedModule ? importedModule.default : importedModule) as typeof import("@node-rs/argon2"));
}

async function getBcryptModule() {
  const importedModule = await import("bcryptjs");
  return ("default" in importedModule ? importedModule.default : importedModule) as typeof import("bcryptjs");
}

function isBcryptHash(value: string) {
  return BCRYPT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function readArgon2Parameters(value: string) {
  const match = value.match(ARGON2_PARAMETER_PATTERN);
  if (!match) {
    return null;
  }

  return {
    memoryCost: Number(match[1]),
    timeCost: Number(match[2]),
    parallelism: Number(match[3]),
  };
}

function needsArgon2Upgrade(value: string) {
  if (!value.startsWith(ARGON2_PREFIX)) {
    return true;
  }

  const parameters = readArgon2Parameters(value);
  if (!parameters) {
    return true;
  }

  return (
    parameters.memoryCost < ARGON2_OPTIONS.memoryCost ||
    parameters.timeCost < ARGON2_OPTIONS.timeCost ||
    parameters.parallelism < ARGON2_OPTIONS.parallelism
  );
}

export function isPasswordLengthValid(password: string) {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

export async function hashPassword(password: string) {
  const argon2 = await getArgon2Module();
  return argon2.hash(password, {
    ...ARGON2_OPTIONS,
    algorithm: ARGON2_ID_ALGORITHM,
  });
}

export async function verifyPassword(password: string, storedHash: string) {
  if (isBcryptHash(storedHash)) {
    const bcrypt = await getBcryptModule();
    const valid = await bcrypt.compare(password, storedHash);
    return {
      valid,
      needsRehash: valid,
    };
  }

  if (!storedHash.startsWith(ARGON2_PREFIX)) {
    return {
      valid: false,
      needsRehash: false,
    };
  }

  try {
    const argon2 = await getArgon2Module();
    const valid = await argon2.verify(storedHash, password);
    return {
      valid,
      needsRehash: valid && needsArgon2Upgrade(storedHash),
    };
  } catch {
    return {
      valid: false,
      needsRehash: false,
    };
  }
}
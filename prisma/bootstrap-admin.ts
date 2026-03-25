import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { hashPassword } from "../src/lib/password";
import { PASSWORD_MIN_LENGTH } from "../src/lib/password-policy";

const prisma = new PrismaClient();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function main() {
  const email = z.string().email().parse(requireEnv("BOOTSTRAP_ADMIN_EMAIL").toLowerCase());
  const requestedName = optionalEnv("BOOTSTRAP_ADMIN_NAME");
  const providedPassword = optionalEnv("BOOTSTRAP_ADMIN_PASSWORD");
  const password = providedPassword ?? randomBytes(18).toString("base64url");

  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`BOOTSTRAP_ADMIN_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters long`);
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  const hashedPassword = await hashPassword(password);
  const defaultName = existingUser?.name ?? "Administrator";

  const user = existingUser
    ? await prisma.user.update({
        where: { email },
        data: {
          role: "admin",
          password: hashedPassword,
          name: requestedName ?? defaultName,
        },
      })
    : await prisma.user.create({
        data: {
          email,
          name: requestedName ?? "Administrator",
          password: hashedPassword,
          role: "admin",
        },
      });

  const adminCount = await prisma.user.count({
    where: { role: "admin" },
  });

  console.log(existingUser ? "✅ Updated existing user as admin" : "✅ Created admin user");
  console.log(`Email: ${user.email}`);
  console.log(`Name: ${user.name ?? "(none)"}`);
  console.log(`Admin users in database: ${adminCount}`);
  if (providedPassword) {
    console.log("Password: supplied via BOOTSTRAP_ADMIN_PASSWORD");
  } else {
    console.log(`Generated password: ${password}`);
  }
  console.log("Next step: sign in, then create your first project from Settings if needed.");
}

main()
  .catch((error) => {
    console.error("❌ Admin bootstrap failed:", error);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });

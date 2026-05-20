CREATE TABLE "OidcProviderConnection" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "encryptedClientSecret" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'openid email profile',
  "groupsClaim" TEXT NOT NULL DEFAULT 'groups',
  "defaultRole" TEXT NOT NULL DEFAULT 'member',
  "allowSignup" BOOLEAN NOT NULL DEFAULT true,
  "allowEmailAccountLinking" BOOLEAN NOT NULL DEFAULT false,
  "requireEmailVerified" BOOLEAN NOT NULL DEFAULT false,
  "adminEmails" JSONB NOT NULL DEFAULT '[]',
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OidcProviderConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OidcProviderConnection_providerId_key" ON "OidcProviderConnection"("providerId");
CREATE INDEX "OidcProviderConnection_isEnabled_idx" ON "OidcProviderConnection"("isEnabled");

import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: "admin" | "member";
    };
    /** "cookie" for interactive sessions; "token" when established via a personal API token. */
    authMethod?: "cookie" | "token";
  }

  interface User {
    role?: "admin" | "member";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: "admin" | "member";
  }
}
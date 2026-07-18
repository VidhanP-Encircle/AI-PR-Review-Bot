import NextAuth from "next-auth";

declare module "next-auth" {
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `SessionProvider` React Context
   */
  interface Session {
    user: {
      id: string;
      email: string;
      role: string;
      organizationId: string;
      name?: string | null;
      image?: string | null;
    }
  }

  interface User {
    id: string;
    email: string;
    role: string;
    organizationId: string;
  }
}

declare module "next-auth/jwt" {
  /** Returned by the `jwt` callback and `getToken`, when using JWT sessions */
  interface JWT {
    userId: string;
    email: string;
    role: string;
    organizationId: string;
  }
}

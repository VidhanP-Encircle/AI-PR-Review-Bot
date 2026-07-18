/**
 * @module api/middleware/auth
 * JWT Authentication Middleware for Fastify.
 *
 * Verifies JWT tokens on protected dashboard API routes and injects
 * the decoded user payload into the request object.
 */

import { decode } from 'next-auth/jwt';
import type { FastifyRequest, FastifyReply } from 'fastify';

/** Expected payload structure from the JWT */
export interface UserJwtPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
}

// Extend FastifyRequest to include the authenticated user
declare module 'fastify' {
  interface FastifyRequest {
    user?: UserJwtPayload;
  }
}

/**
 * Fastify preHandler hook to verify the JWT token from the Authorization header.
 *
 * @param request - The Fastify request object.
 * @param reply - The Fastify reply object.
 */
export async function verifyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const secret = process.env.NEXTAUTH_SECRET || 'fallback-secret-for-development';
  
  try {
    const tokenString = request.cookies['next-auth.session-token'] || request.cookies['__Secure-next-auth.session-token'];
    
    if (!tokenString) {
      return reply.status(401).send({ error: 'Missing authentication cookie' });
    }

    const token = await decode({ 
      token: tokenString, 
      secret,
    });
    
    if (!token) {
      return reply.status(401).send({ error: 'Invalid authentication token' });
    }

    request.user = {
      userId: token.userId as string,
      email: token.email as string,
      role: token.role as string,
      organizationId: token.organizationId as string,
    };
  } catch (err) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

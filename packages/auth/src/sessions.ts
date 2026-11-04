/**
 * Sessions and sign-in.
 *
 * Opaque random tokens in an HttpOnly cookie, with the token's *hash* stored
 * server side. Not JWTs: a CMS needs revocation to be immediate (suspending a
 * user, or signing out a shared machine) and a stateless token cannot be
 * revoked without adding the very session table it was meant to avoid. Since
 * every CMS request already touches the database, the lookup is free.
 */
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import { type Db, schema } from "@uxd/database";
import {
  type Logger,
  AppError,
  ErrorCode,
  addMs,
  hours,
  minutes,
  sha256Hex,
  unauthenticated,
} from "@uxd/shared";
import type { Role } from "@uxd/types";
import type { Actor } from "./permissions.js";
import { needsRehash, hashPassword, verifyPassword } from "./password.js";

const { sessions, users } = schema;

export const SESSION_COOKIE_NAME = "uxd_session";
/** Refresh the session's expiry at most this often, to avoid a write per request. */
const SESSION_REFRESH_INTERVAL_MS = minutes(15);

/** Failed attempts before an account is temporarily locked. */
export const MAX_FAILED_LOGINS = 8;
export const LOCKOUT_DURATION_MS = minutes(15);

export interface SessionConfig {
  readonly ttlMs: number;
  readonly cookieSecure: boolean;
  readonly logger?: Logger;
}

export interface AuthenticatedSession {
  readonly actor: Actor;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

/**
 * Cookie attributes.
 *
 * `SameSite=Lax` rather than `Strict`: Strict would break returning to the CMS
 * from an external link (an email, a shared job URL) by dropping the cookie on
 * the top-level navigation. Lax still refuses to send the cookie on
 * cross-site POSTs, which is the CSRF vector that matters. State-changing
 * requests carry an additional origin check — see `assertSameOrigin`.
 */
export function sessionCookieOptions(config: SessionConfig): {
  name: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: Math.floor(config.ttlMs / 1000),
  };
}

function newToken(): { token: string; id: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, id: sha256Hex(token) };
}

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface SignInResult {
  readonly token: string;
  readonly actor: Actor;
  readonly expiresAt: Date;
}

/**
 * Authenticate and open a session.
 *
 * Failure is deliberately uniform: a wrong password, an unknown address, a
 * suspended account and an invited-but-unset password all return the same
 * message. Distinguishing them would turn the sign-in form into an account
 * enumeration oracle. The real reason goes to the audit log and the structured
 * log, where an operator can see it.
 */
export async function signIn(
  db: Db,
  config: SessionConfig,
  input: SignInInput,
): Promise<SignInResult> {
  const email = input.email.trim().toLowerCase();
  const genericFailure = () =>
    new AppError(ErrorCode.UNAUTHENTICATED, "That email and password combination is not recognised.");

  const [user] = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
    .limit(1);

  if (!user) {
    // Spend comparable time to a real verification so response timing does not
    // reveal whether the address exists.
    await verifyPassword(input.password, null);
    config.logger?.warn("Sign-in failed: unknown email", { email, ip: input.ip });
    throw genericFailure();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    config.logger?.warn("Sign-in refused: account locked", { userId: user.id, until: user.lockedUntil });
    throw new AppError(
      ErrorCode.RATE_LIMITED,
      "Too many failed attempts. Try again in a few minutes.",
    );
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    const failedLoginCount = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount,
        lockedUntil:
          failedLoginCount >= MAX_FAILED_LOGINS ? addMs(new Date(), LOCKOUT_DURATION_MS) : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    config.logger?.warn("Sign-in failed: bad password", {
      userId: user.id,
      failedLoginCount,
      ip: input.ip,
    });
    throw genericFailure();
  }

  if (user.status !== "active") {
    config.logger?.warn("Sign-in refused: inactive account", { userId: user.id, status: user.status });
    throw genericFailure();
  }

  // Opportunistic upgrade if the hash predates a parameter increase.
  const rehash = needsRehash(user.passwordHash) ? await hashPassword(input.password) : null;

  const { token, id } = newToken();
  const expiresAt = addMs(new Date(), config.ttlMs);

  await db.insert(sessions).values({
    id,
    userId: user.id,
    expiresAt,
    ip: input.ip ?? null,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
  });

  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
      ...(rehash ? { passwordHash: rehash, passwordChangedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return {
    token,
    expiresAt,
    actor: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
}

/**
 * Resolve a session cookie to an actor.
 *
 * Returns null rather than throwing, because "not signed in" is a normal state
 * for a request to the sign-in page. Callers that require a session use
 * `requireSession`.
 */
export async function resolveSession(
  db: Db,
  config: SessionConfig,
  token: string | undefined | null,
): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const id = sha256Hex(token);

  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      deletedAt: users.deletedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;
  // A suspended or deleted user's existing cookie stops working immediately —
  // the reason sessions are stateful.
  if (row.status !== "active" || row.deletedAt !== null) return null;

  // Rolling expiry, throttled so a busy operator does not generate a write per
  // request.
  const now = new Date();
  if (now.getTime() - row.lastUsedAt.getTime() > SESSION_REFRESH_INTERVAL_MS) {
    const expiresAt = addMs(now, config.ttlMs);
    await db
      .update(sessions)
      .set({ lastUsedAt: now, expiresAt })
      .where(eq(sessions.id, row.sessionId));
    return {
      sessionId: row.sessionId,
      expiresAt,
      actor: { id: row.userId, email: row.email, name: row.name, role: row.role as Role },
    };
  }

  return {
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    actor: { id: row.userId, email: row.email, name: row.name, role: row.role as Role },
  };
}

export function requireSession(session: AuthenticatedSession | null): AuthenticatedSession {
  if (!session) throw unauthenticated();
  return session;
}

export async function signOut(db: Db, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, sha256Hex(token)));
}

/**
 * Revoke every session for a user. Used on password change and suspension.
 *
 * `exceptSessionId` keeps one alive — the browser that just changed the
 * password should not be signed out by its own action, but every other one
 * should, since a password change is often a response to a suspected leak.
 */
export async function revokeAllSessions(
  db: Db,
  userId: string,
  options: { readonly exceptSessionId?: string } = {},
): Promise<number> {
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        options.exceptSessionId ? ne(sessions.id, options.exceptSessionId) : undefined,
      ),
    )
    .returning({ id: sessions.id });
  return result.length;
}

/** Delete expired and long-revoked rows. Called by the maintenance task. */
export async function pruneSessions(db: Db): Promise<number> {
  const cutoff = addMs(new Date(), -hours(24));
  const result = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, new Date()), lt(sessions.revokedAt, cutoff)))
    .returning({ id: sessions.id });
  return result.length;
}

/**
 * Origin check for state-changing requests.
 *
 * Defence in depth alongside `SameSite=Lax`. A cross-site form POST would not
 * carry the cookie under Lax, but this also covers a same-site subdomain
 * takeover and any future relaxation of the cookie policy. Requests with no
 * Origin header (same-origin navigations in some browsers, server-side calls)
 * are allowed through; those cannot be driven by an attacker's page.
 */
export function assertSameOrigin(origin: string | null, allowedOrigins: readonly string[]): void {
  if (!origin) return;
  if (!allowedOrigins.includes(origin)) {
    throw new AppError(ErrorCode.FORBIDDEN, "Request blocked: unexpected origin.", {
      detail: `origin ${origin} is not allowed`,
      context: { origin },
    });
  }
}

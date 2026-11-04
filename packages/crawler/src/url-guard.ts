/**
 * The URL guard — SSRF defence for everything the worker fetches.
 *
 * Every URL that reaches the network passes through `guardUrl`, whether it was
 * pasted by an operator, discovered as a link on a page, or handed to us by a
 * redirect. There is no path around it.
 *
 * Five layers, in order, each cheaper than the next:
 *
 *   1. Syntax and policy (`validateUrl` in @uxd/shared) — protocol allowlist,
 *      no credentials, allowed ports, no control characters.
 *   2. Hostname rules (`classifyHostname`) — refuse names that can only be
 *      internal, before spending a DNS query on them.
 *   3. Operator blocklist/allowlist — domains a team has decided about.
 *   4. DNS resolution, then classification of *every* returned address. A host
 *      with one public and one private address is refused, because we cannot
 *      control which one the connection picks.
 *   5. Address pinning — the validated addresses are returned so the
 *      connection is made to one of them, not to a fresh lookup.
 *
 * Layer 5 is what closes DNS rebinding. Without it there is a window between
 * "we resolved and approved 93.184.216.34" and "the HTTP client resolves again
 * and gets 127.0.0.1", and a hostile DNS server with a one-second TTL will use
 * it. `createGuardedDispatcher` and `guardedConnectOptions` below hand the
 * pinned address to undici and Playwright respectively, and both re-run
 * `classifyIp` at connect time as a final assertion.
 */
import { lookup as dnsLookup, Resolver } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { Agent, type Dispatcher } from "undici";
import {
  type Logger,
  type ParsedUrl,
  type Result,
  ErrorCode,
  err,
  hostMatchesScope,
  ok,
  validateUrl,
} from "@uxd/shared";
import { BLOCKED_HOST_SUFFIXES, classifyHostname, classifyIp } from "./ip.js";

export const GUARD_FAILURE_KINDS = {
  INVALID_URL: "INVALID_URL",
  BLOCKED_HOSTNAME: "BLOCKED_HOSTNAME",
  BLOCKED_BY_POLICY: "BLOCKED_BY_POLICY",
  NOT_IN_ALLOWLIST: "NOT_IN_ALLOWLIST",
  DNS_FAILED: "DNS_FAILED",
  PRIVATE_ADDRESS: "PRIVATE_ADDRESS",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
} as const;
export type GuardFailureKind = (typeof GUARD_FAILURE_KINDS)[keyof typeof GUARD_FAILURE_KINDS];

/**
 * Does this failure mean "not allowed", or "could not tell"?
 *
 * The guard fails for two categorically different reasons and the difference
 * decides whether a URL is discarded or retried:
 *
 *   - A *policy refusal* is an answer. The host is private, the protocol is
 *     not http(s), the port is not permitted, the domain is on the blocklist.
 *     Retrying cannot change any of that, so the item is terminal and belongs
 *     in the operator's "blocked" bucket.
 *
 *   - `DNS_FAILED` is the *absence* of an answer. We could not establish
 *     whether the host is allowed, so we refused to connect — which is the
 *     right call, because failing open here is an SSRF. But it says nothing
 *     about the URL, and a resolver that is briefly unavailable is the single
 *     most common way for it to happen.
 *
 * A crawl experiment made the cost of conflating them concrete: a local DNS
 * hiccup during one run produced 31 items marked `blocked` and non-retryable —
 * figma.com, gitlab.com, fonts.google.com among them. All were permanently
 * discarded, and all were reported to the operator with the same label as a
 * robots.txt refusal, so there was nothing to suggest they were worth a second
 * look.
 *
 * This lives here, next to the kinds, because the two call sites that consume
 * it had already drifted: the HTTP fetch path treated a DNS failure as
 * retryable while the pre-flight guard did not, so the same failure got two
 * different verdicts depending on which check happened to see it first.
 */
export function isGuardPolicyRefusal(kind: GuardFailureKind): boolean {
  return kind !== GUARD_FAILURE_KINDS.DNS_FAILED;
}

export interface GuardFailure {
  readonly kind: GuardFailureKind;
  /** Maps onto the AppError code recorded on the job item. */
  readonly errorCode: ErrorCode;
  /** Sentence shown to the operator in the CMS. */
  readonly message: string;
  /** Which rule fired, for the audit trail. */
  readonly rule: string | null;
  readonly url: string;
}

export interface GuardedUrl {
  readonly parsed: ParsedUrl;
  /** Validated addresses. The connection must use one of these. */
  readonly addresses: readonly { address: string; family: 4 | 6 }[];
  /** True when the host resolved to a single address (the common case). */
  readonly pinned: boolean;
}

export interface GuardPolicy {
  /** Hostnames or domains an operator has blocked outright. */
  readonly blockedDomains?: readonly string[];
  /**
   * When set, ONLY these hosts may be fetched. Empty or absent means "any
   * public host", which is the normal mode for a research crawler.
   */
  readonly allowedDomains?: readonly string[];
  /** Restrict to a crawl's own scope, for discovered links. */
  readonly scope?: { hosts: readonly string[]; includeSubdomains: boolean };
  /** Permit literal IP hosts. Off by default. */
  readonly allowIpLiteral?: boolean;
  /**
   * Skip DNS resolution. ONLY for unit tests that assert the pure layers; a
   * production guard must resolve, because the address is the thing being
   * checked.
   */
  readonly skipDnsForTesting?: boolean;
  /** DNS servers to use. Defaults to the system resolver. */
  readonly dnsServers?: readonly string[];
  readonly dnsTimeoutMs?: number;
  readonly logger?: Logger;
}

const DEFAULT_DNS_TIMEOUT_MS = 5_000;

function fail(
  kind: GuardFailureKind,
  errorCode: ErrorCode,
  message: string,
  url: string,
  rule: string | null = null,
): Result<never, GuardFailure> {
  return err({ kind, errorCode, message, rule, url });
}

/** Does `host` match a blocklist/allowlist entry (exact host or subdomain)? */
function matchesDomainList(host: string, list: readonly string[]): string | null {
  for (const raw of list) {
    const entry = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (entry.length === 0) continue;
    if (host === entry || host.endsWith(`.${entry}`)) return entry;
  }
  return null;
}

async function resolveWithTimeout(
  hostname: string,
  policy: GuardPolicy,
): Promise<LookupAddress[]> {
  const timeoutMs = policy.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;

  const lookup = async (): Promise<LookupAddress[]> => {
    if (policy.dnsServers && policy.dnsServers.length > 0) {
      // A dedicated resolver, so the worker can be pointed at a DNS server
      // that does not serve internal zones at all — belt and braces alongside
      // the address checks.
      const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
      resolver.setServers([...policy.dnsServers]);
      const [v4, v6] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      const out: LookupAddress[] = [];
      if (v4.status === "fulfilled") out.push(...v4.value.map((a) => ({ address: a, family: 4 })));
      if (v6.status === "fulfilled") out.push(...v6.value.map((a) => ({ address: a, family: 6 })));
      if (out.length === 0) throw new Error(`No addresses for ${hostname}`);
      return out;
    }
    // `all: true` is essential: resolving only the first address would let a
    // host hide a private address behind a public one.
    return dnsLookup(hostname, { all: true, verbatim: true });
  };

  return Promise.race([
    lookup(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`DNS lookup for ${hostname} timed out`)), timeoutMs).unref?.(),
    ),
  ]);
}

/**
 * Validate a URL for fetching.
 *
 * Returns the parsed URL plus the addresses it is allowed to be connected to.
 * A failure carries a sentence written for the operator who will read it in the
 * crawl log, not a stack trace.
 */
export async function guardUrl(
  input: string,
  policy: GuardPolicy = {},
): Promise<Result<GuardedUrl, GuardFailure>> {
  // --- Layer 1: syntax and policy ---------------------------------------
  const validated = validateUrl(input, { allowIpLiteral: policy.allowIpLiteral ?? false });
  if (!validated.ok) {
    return fail(
      GUARD_FAILURE_KINDS.INVALID_URL,
      ErrorCode.URL_INVALID,
      validated.error.message,
      input,
      validated.error.reason,
    );
  }
  const parsed = validated.value;
  const host = parsed.host;

  // --- Layer 2: hostname rules ------------------------------------------
  if (!parsed.isIpLiteral) {
    const byName = classifyHostname(host);
    if (!byName.allowed) {
      return fail(
        GUARD_FAILURE_KINDS.BLOCKED_HOSTNAME,
        ErrorCode.SSRF_BLOCKED,
        byName.reason ?? "This hostname is not allowed.",
        parsed.normalized,
        "hostname",
      );
    }
  }

  // --- Layer 3: operator policy -----------------------------------------
  if (policy.blockedDomains && policy.blockedDomains.length > 0) {
    const matched = matchesDomainList(host, policy.blockedDomains);
    if (matched) {
      return fail(
        GUARD_FAILURE_KINDS.BLOCKED_BY_POLICY,
        ErrorCode.URL_BLOCKED,
        `${matched} is on the blocked-domains list.`,
        parsed.normalized,
        `blocklist:${matched}`,
      );
    }
  }
  if (policy.allowedDomains && policy.allowedDomains.length > 0) {
    if (!matchesDomainList(host, policy.allowedDomains)) {
      return fail(
        GUARD_FAILURE_KINDS.NOT_IN_ALLOWLIST,
        ErrorCode.URL_BLOCKED,
        `${host} is not on the allowed-domains list.`,
        parsed.normalized,
        "allowlist",
      );
    }
  }
  if (policy.scope && !hostMatchesScope(host, policy.scope)) {
    return fail(
      GUARD_FAILURE_KINDS.OUT_OF_SCOPE,
      ErrorCode.URL_BLOCKED,
      `${host} is outside this job's crawl scope.`,
      parsed.normalized,
      "scope",
    );
  }

  // A literal IP host that got this far was explicitly permitted; classify it
  // directly rather than resolving it.
  if (parsed.isIpLiteral) {
    const bare = host.startsWith("[") ? host.slice(1, -1) : host;
    const classification = classifyIp(bare);
    if (!classification.allowed) {
      return fail(
        GUARD_FAILURE_KINDS.PRIVATE_ADDRESS,
        ErrorCode.SSRF_BLOCKED,
        classification.reason ?? "That address is not publicly routable.",
        parsed.normalized,
        classification.blockedBy,
      );
    }
    return ok({
      parsed,
      addresses: [{ address: bare, family: classification.family }],
      pinned: true,
    });
  }

  // --- Layers 4 and 5: resolve, classify every answer, pin --------------
  if (policy.skipDnsForTesting) {
    return ok({ parsed, addresses: [], pinned: false });
  }

  let resolved: LookupAddress[];
  try {
    resolved = await resolveWithTimeout(host, policy);
  } catch (error) {
    return fail(
      GUARD_FAILURE_KINDS.DNS_FAILED,
      ErrorCode.NAVIGATION_FAILED,
      `Could not look up ${host}. The domain may not exist, or DNS is unavailable.`,
      parsed.normalized,
      error instanceof Error ? error.message.slice(0, 200) : "dns error",
    );
  }

  if (resolved.length === 0) {
    return fail(
      GUARD_FAILURE_KINDS.DNS_FAILED,
      ErrorCode.NAVIGATION_FAILED,
      `${host} did not resolve to any address.`,
      parsed.normalized,
      "empty-dns",
    );
  }

  // Every address must pass. A host answering with both a public and a private
  // address is refused outright: we cannot choose which one the OS would
  // connect to, and "mostly public" is not a security property.
  const addresses: { address: string; family: 4 | 6 }[] = [];
  for (const entry of resolved) {
    const classification = classifyIp(entry.address);
    if (!classification.allowed) {
      policy.logger?.warn("SSRF guard refused a resolved address", {
        host,
        address: entry.address,
        rule: classification.blockedBy,
      });
      return fail(
        GUARD_FAILURE_KINDS.PRIVATE_ADDRESS,
        ErrorCode.SSRF_BLOCKED,
        `${host} resolves to ${entry.address}, which is not publicly routable. ${classification.reason ?? ""}`.trim(),
        parsed.normalized,
        classification.blockedBy,
      );
    }
    addresses.push({ address: entry.address, family: classification.family });
  }

  return ok({ parsed, addresses, pinned: addresses.length > 0 });
}

/**
 * Re-validate a redirect target.
 *
 * A redirect is an attacker-controlled URL, so it gets the identical treatment
 * as the original — the single most commonly missed step in SSRF defence, since
 * HTTP clients follow redirects by default and the guard never sees the hop.
 * Both the HTTP fetcher and the browser capture disable automatic redirects and
 * call this per hop.
 *
 * `scope` is deliberately dropped for redirects: a site legitimately
 * redirecting `example.com` to `www.example.com` should not fail the crawl, and
 * the address checks still apply in full. Scope is a crawl-breadth rule, not a
 * safety rule.
 */
export async function guardRedirect(
  location: string,
  fromUrl: string,
  policy: GuardPolicy = {},
): Promise<Result<GuardedUrl, GuardFailure>> {
  let absolute: string;
  try {
    absolute = new URL(location, fromUrl).toString();
  } catch {
    return fail(
      GUARD_FAILURE_KINDS.INVALID_URL,
      ErrorCode.URL_INVALID,
      "The site redirected to an address we could not parse.",
      location,
      "redirect-parse",
    );
  }
  const { scope: _scope, ...rest } = policy;
  return guardUrl(absolute, rest);
}

/**
 * An undici dispatcher that only connects to pre-validated addresses.
 *
 * Two things happen here. The socket is opened directly to a pinned address, so
 * no second DNS lookup can substitute a different one. And the custom `lookup`
 * re-classifies whatever it is given, so even if the pinning were bypassed the
 * connection is refused at the last possible moment.
 */
export function createGuardedDispatcher(guarded: GuardedUrl, options?: {
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}): Dispatcher {
  const allowed = new Set(guarded.addresses.map((a) => a.address));

  return new Agent({
    connect: {
      timeout: options?.connectTimeoutMs ?? 10_000,
      lookup: (hostname, _opts, callback) => {
        const pinned = guarded.addresses[0];
        if (!pinned) {
          callback(new Error(`No validated address for ${hostname}`), []);
          return;
        }
        // Final assertion: classify again at connect time.
        const classification = classifyIp(pinned.address);
        if (!classification.allowed || !allowed.has(pinned.address)) {
          callback(
            new Error(`Refusing to connect to ${pinned.address}: ${classification.reason ?? "not allowed"}`),
            [],
          );
          return;
        }
        callback(null, [{ address: pinned.address, family: pinned.family }]);
      },
    },
    headersTimeout: options?.headersTimeoutMs ?? 15_000,
    bodyTimeout: options?.bodyTimeoutMs ?? 30_000,
    // No connection reuse across requests: each fetch gets a socket opened to
    // its own validated address, so a pooled connection cannot be inherited by
    // a request to a different (unvalidated) host on the same origin.
    pipelining: 0,
    // Redirects are NOT followed by the dispatcher. Every hop goes back through
    // `guardRedirect` — see the `maxRedirections: 0` passed at each call site.
  });
}

/**
 * Chromium command-line flags that pin DNS for a browser capture.
 *
 * Playwright cannot be given a custom resolver, so the browser is told to map
 * the host to its validated address via `--host-resolver-rules`. Combined with
 * request interception (see `browser-capture.ts`), which re-guards every
 * navigation and blocks non-document requests to unvalidated hosts, this gives
 * the browser path the same address guarantee as the HTTP path.
 */
export function hostResolverRules(guarded: GuardedUrl): string | null {
  const first = guarded.addresses[0];
  if (!first) return null;
  const host = guarded.parsed.host;
  return [
    `MAP ${host} ${first.address}`,
    // Refuse everything else that is not explicitly mapped, so a page cannot
    // make the browser resolve an internal name.
    ...BLOCKED_HOST_SUFFIXES.map((suffix) => `EXCLUDE *${suffix}`),
  ].join(",");
}

/**
 * Does this hostname resolve entirely to public addresses?
 *
 * The main document gets the full five-layer treatment: resolve, classify
 * every answer, pin the winner. A page's *subresources* could not, because the
 * request screen in `browser-capture` is called hundreds of times per page and
 * was therefore written to be synchronous — which left it matching hostname
 * patterns (`.local`, `.internal`) and never asking where a name actually
 * points.
 *
 * That is a real hole rather than a theoretical one. `evil.example.com` with
 * an A record of `10.0.0.5` passes a suffix check cleanly, and the browser
 * then connects to an internal host from inside our network on behalf of a
 * page we do not control. Cloud metadata endpoints are reachable the same way.
 *
 * So the screen has to resolve after all, and the cost is managed by caching
 * per host for the life of a capture instead of by skipping the check. A busy
 * page pulls from a handful of distinct hosts, not hundreds.
 *
 * Fails closed: a name that cannot be resolved is not loaded.
 */
export async function hostResolvesToPublicAddress(
  hostname: string,
  policy: GuardPolicy = {},
): Promise<{ allowed: boolean; reason: string | null }> {
  const host = hostname.replace(/\.$/, "").toLowerCase();

  // The cheap checks first; most refusals never need a query.
  const byName = classifyHostname(host);
  if (!byName.allowed) return { allowed: false, reason: byName.reason ?? "hostname refused" };

  if (policy.skipDnsForTesting) return { allowed: true, reason: null };

  let resolved: LookupAddress[];
  try {
    resolved = await resolveWithTimeout(host, policy);
  } catch {
    return { allowed: false, reason: `could not resolve ${host}` };
  }
  if (resolved.length === 0) return { allowed: false, reason: `${host} resolved to nothing` };

  // Every answer must pass, for the same reason the main document requires it:
  // we cannot choose which address the browser will pick.
  for (const entry of resolved) {
    const verdict = classifyIp(entry.address);
    if (!verdict.allowed) {
      return { allowed: false, reason: `${host} resolves to ${entry.address} (${verdict.reason ?? "refused"})` };
    }
  }
  return { allowed: true, reason: null };
}

/** Human summary of a guard failure, for the crawl log. */
export function describeGuardFailure(failure: GuardFailure): string {
  return failure.rule ? `${failure.message} (rule: ${failure.rule})` : failure.message;
}

/**
 * URL parsing, normalisation and scope matching.
 *
 * This module is intentionally pure — no DNS, no sockets — so it can run in the
 * CMS (to validate what an operator pasted), in the worker (to validate every
 * discovered link and every redirect hop), and in tests, with identical
 * results. The network half of SSRF defence (DNS resolution and private-range
 * checks) lives in `@uxd/crawler/url-guard`, which calls into this first.
 *
 * Normalisation exists for deduplication (§11). Two inputs that name the same
 * page must produce the same `normalized` string and therefore the same
 * `hash`, which is the dedupe key stored on `url_registry`, `crawl_job_items`
 * and `page_details`.
 */
import { sha256Hex } from "./hash.js";
import { type Result, err, ok } from "./result.js";

/** The only two protocols this system will ever fetch. */
export const ALLOWED_PROTOCOLS = ["http:", "https:"] as const;
export type AllowedProtocol = (typeof ALLOWED_PROTOCOLS)[number];

export const URL_MAX_LENGTH = 2048;

/**
 * Query parameters removed during normalisation.
 *
 * These are analytics/campaign parameters that never change the page a user
 * sees, so keeping them would create a duplicate record per inbound campaign.
 * This is the *default* list; the CMS stores an operator-editable override in
 * `settings` under `ingestion.trackingParams`, and callers pass it through
 * `NormalizeOptions.trackingParams`. Nothing here is hardcoded into logic.
 */
export const DEFAULT_TRACKING_PARAMS: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "twclid",
  "ttclid",
  "igshid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "hsa_acc",
  "hsa_cam",
  "vero_id",
  "vero_conv",
  "yclid",
  "ref_src",
  "ref_url",
  "s_kwcid",
  "spm",
  "scm",
];

export const URL_INVALID_REASONS = {
  EMPTY: "EMPTY",
  TOO_LONG: "TOO_LONG",
  UNPARSEABLE: "UNPARSEABLE",
  DISALLOWED_PROTOCOL: "DISALLOWED_PROTOCOL",
  HAS_CREDENTIALS: "HAS_CREDENTIALS",
  NO_HOSTNAME: "NO_HOSTNAME",
  /**
   * Has a dot but is not a valid domain name — `foo.123`, `site.-bar`.
   *
   * Deliberately narrow. A hostname with *no* dot is ambiguous: `db`,
   * `intranet` and `wiki` are real hosts on a corporate network, and
   * `not-a-url-at-all` is a typo, and nothing in the string distinguishes
   * them. The security-correct reading of an ambiguous single label is that it
   * may be an internal host, so those stay `HOSTNAME_NOT_PUBLIC` and bucket as
   * `blocked` — bucketing a genuine internal hostname as a typo is the worse
   * of the two errors. A numeric or malformed TLD has no such ambiguity: no
   * network names a host `foo.123`.
   */
  NOT_A_DOMAIN: "NOT_A_DOMAIN",
  HOSTNAME_NOT_PUBLIC: "HOSTNAME_NOT_PUBLIC",
  DISALLOWED_PORT: "DISALLOWED_PORT",
} as const;
export type UrlInvalidReason = (typeof URL_INVALID_REASONS)[keyof typeof URL_INVALID_REASONS];

export const URL_INVALID_MESSAGES: Record<UrlInvalidReason, string> = {
  EMPTY: "The address is empty.",
  TOO_LONG: `The address is longer than ${URL_MAX_LENGTH} characters.`,
  UNPARSEABLE: "This is not a URL we can parse.",
  DISALLOWED_PROTOCOL: "Only http:// and https:// addresses can be ingested.",
  HAS_CREDENTIALS: "The address contains an embedded username or password.",
  NO_HOSTNAME: "The address has no hostname.",
  NOT_A_DOMAIN: "This is not a valid domain name.",
  HOSTNAME_NOT_PUBLIC:
    "Not a public domain name. Single-word names like this refer to hosts on a local network, which cannot be captured.",
  DISALLOWED_PORT: "Only the standard web ports (80, 443, 8080, 8443) are allowed.",
};

/**
 * Which bucket a refusal belongs in, from the operator's point of view.
 *
 * The distinction is the one that decides what somebody does next, and it is
 * not the same as which code path produced the failure:
 *
 *   `invalid` — this is not a web address. Fix the input.
 *   `blocked` — this *is* a web address, and policy refuses to fetch it.
 *               Fix the policy, or accept the refusal.
 *
 * Deriving it from the reason rather than from the call site is what stops
 * these drifting apart. An audit run found the previous behaviour had them
 * inverted in both directions: `localhost` and `10.0.0.1` were reported as
 * `invalid` (as though mistyped) because the syntax pass happened to catch
 * them, while a reserved TLD was reported as `blocked`.
 */
export const URL_REFUSAL_BUCKET: Record<UrlInvalidReason, "invalid" | "blocked"> = {
  EMPTY: "invalid",
  TOO_LONG: "invalid",
  UNPARSEABLE: "invalid",
  NO_HOSTNAME: "invalid",
  NOT_A_DOMAIN: "invalid",
  // Well-formed, and not a web address — a `file://` path in a pasted list is
  // almost always a mistake, so it reads as input to fix.
  DISALLOWED_PROTOCOL: "invalid",
  HAS_CREDENTIALS: "invalid",
  // A real, reachable address that policy refuses. These are the two that
  // were being mislabelled.
  HOSTNAME_NOT_PUBLIC: "blocked",
  DISALLOWED_PORT: "blocked",
};

/** Ports we are willing to connect to. Keeps ingestion off internal services
 * that happen to be reachable on odd ports. */
export const ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443];

export interface NormalizeOptions {
  /** Override the tracking-parameter list (from CMS settings). */
  readonly trackingParams?: readonly string[];
  /** Keep the URL fragment. Off by default: fragments do not identify a
   * distinct server-rendered page. Turn on for SPA routes that use hash
   * routing, where the fragment *is* the route. */
  readonly keepFragment?: boolean;
  /** Keep the query string entirely as-is (no dropping, no sorting). */
  readonly keepQueryOrder?: boolean;
  /** Assume https:// when the input has no scheme (e.g. "example.com/pricing"). */
  readonly assumeHttps?: boolean;
}

export interface ParsedUrl {
  /** Exactly what the caller supplied, trimmed. Preserved for the audit trail. */
  readonly original: string;
  /**
   * Canonical form. The dedupe **identity** of this URL, and nothing else.
   *
   * Lossy on purpose: tracking parameters removed, query order sorted,
   * duplicate slashes collapsed, trailing slash dropped. Those make `/a//b/`
   * and `/a/b?utm_source=x` resolve to one record, which is what dedupe needs.
   *
   * **Never fetch this.** See `fetchUrl`.
   */
  readonly normalized: string;
  /**
   * What to actually request.
   *
   * Differs from `normalized` in one respect that matters enormously: the
   * trailing slash is preserved. `/3` and `/3/` are *different resources* to a
   * server, and a great many sites — documentation especially — 301 the
   * slashless form to the slashed one.
   *
   * An audit run found the consequence of conflating the two. Requesting the
   * normalised form meant fetching `/3`, receiving a 301 to `/3/`,
   * re-normalising that back to `/3`, and requesting it again — an infinite
   * redirect loop, reported to the operator as "the page redirected more than
   * 5 times". It silently rejected `docs.python.org`, `svgwg.org` and
   * `flask.palletsprojects.com`, and burned six requests against each of them
   * on the way. Any site with directory-style URLs was affected.
   *
   * Tracking parameters are still stripped here — that is a genuine cleanup
   * rather than a change of resource, and following a link with someone's
   * campaign tags attached is worse than not.
   */
  readonly fetchUrl: string;
  /** sha256 of `normalized`. The dedupe key stored in the database. */
  readonly hash: string;
  readonly protocol: AllowedProtocol;
  /** Lowercased, punycode (IDNA) hostname. No trailing dot. */
  readonly host: string;
  /** Explicit non-default port, else null. */
  readonly port: number | null;
  readonly path: string;
  readonly search: string;
  readonly fragment: string;
  /** Best-effort registrable domain, for grouping and display only. */
  readonly registrableDomain: string;
  /** True when the host is a literal IP rather than a domain name. */
  readonly isIpLiteral: boolean;
}

/**
 * Multi-label public suffixes common enough to matter for display grouping.
 *
 * This is deliberately NOT a full Public Suffix List. It is only used to
 * compute `registrableDomain` for grouping and labels. No security decision
 * depends on it: crawl scope uses `hostMatchesScope`, which compares exact
 * hosts and dot-boundary subdomains and needs no suffix knowledge.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "co.kr", "or.kr",
  "com.br", "net.br", "org.br", "gov.br", "com.mx", "com.ar", "com.co",
  "co.in", "net.in", "org.in", "gen.in", "firm.in",
  "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "com.tw", "com.sg",
  "co.za", "org.za", "com.tr", "com.ua", "com.pl", "com.ru", "co.il",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "web.app", "firebaseapp.com", "herokuapp.com", "azurewebsites.net",
]);

/** Best-effort eTLD+1. Display and grouping only — never a security check. */
export function registrableDomain(host: string): string {
  const labels = host.split(".").filter((l) => l.length > 0);
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastThree)) return labels.slice(-4).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return lastThree;
  return lastTwo;
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// A hostname is "public-looking" if it has a dot and a plausible TLD.
const PUBLIC_HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;


/**
 * Is this parsed hostname a literal IP address rather than a domain name?
 *
 * This must be given a hostname that has already been through `new URL()`,
 * because the WHATWG URL parser is what makes the check reliable: it
 * canonicalises every IPv4 obfuscation form used to smuggle past naive
 * filters — decimal integer (`2130706433`), octal (`0177.0.0.1`), hex
 * (`0x7f000001`) and short form (`127.1`) all become `127.0.0.1` — and it
 * always returns IPv6 literals bracketed (`[::1]`).
 *
 * So dotted-quad plus a leading bracket is complete coverage. Do not add a
 * bare-hex heuristic here: hostnames spelled entirely from hex letters
 * (`db`, `cafe`, `feed`) are ordinary names, not addresses.
 */
export function isIpLiteralHost(host: string): boolean {
  return IPV4_RE.test(host) || host.startsWith("[");
}

/**
 * Parse and normalise a URL.
 *
 * Rejects rather than repairs anything that is ambiguous or unsafe: non-web
 * protocols (file:, ftp:, gopher:, data:, javascript:, blob:), embedded
 * credentials (which would leak into logs and referrers), and non-standard
 * ports. IP-literal hosts are parsed successfully here but are rejected by
 * default at the `validateUrl` layer, since ingesting a bare IP is almost
 * always either a mistake or an SSRF probe.
 */
export function parseUrl(
  input: string,
  options: NormalizeOptions = {},
): Result<ParsedUrl, UrlInvalidReason> {
  const original = input.trim();
  if (original.length === 0) return err(URL_INVALID_REASONS.EMPTY);
  if (original.length > URL_MAX_LENGTH) return err(URL_INVALID_REASONS.TOO_LONG);

  // Reject control characters and whitespace outright: the URL parser would
  // silently strip some of them, which is how two different inputs end up
  // resolving to the same request and bypassing an allowlist check.
  if (/[\u0000-\u0020\u007f-\u009f]/.test(original)) return err(URL_INVALID_REASONS.UNPARSEABLE);

  const candidate =
    options.assumeHttps && !/^[a-z][a-z0-9+.-]*:/i.test(original) ? `https://${original}` : original;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return err(URL_INVALID_REASONS.UNPARSEABLE);
  }

  if (!(ALLOWED_PROTOCOLS as readonly string[]).includes(url.protocol)) {
    return err(URL_INVALID_REASONS.DISALLOWED_PROTOCOL);
  }
  if (url.username !== "" || url.password !== "") {
    return err(URL_INVALID_REASONS.HAS_CREDENTIALS);
  }

  // `new URL()` lowercases and IDNA-encodes the hostname for us. Strip the
  // optional FQDN trailing dot, which is equivalent but hashes differently.
  const host = url.hostname.replace(/\.$/, "");
  if (host.length === 0) return err(URL_INVALID_REASONS.NO_HOSTNAME);

  const isIpLiteral = isIpLiteralHost(host);
  if (!isIpLiteral && !PUBLIC_HOSTNAME_RE.test(host)) {
    // Both are refused; the operator still needs to know which.
    //
    // No dot at all is *ambiguous* — `db`, `intranet` and `wiki` are real
    // hosts on a corporate network, `not-a-url-at-all` is a typo, and the
    // string does not say which. Treated as a possible internal host, because
    // mislabelling a real internal address as a typo is the worse error. Its
    // message covers both readings.
    //
    // A dot with a malformed TLD (`foo.123`) has no such ambiguity: nothing
    // names a host that, so it is input to fix.
    return err(
      host.includes(".")
        ? URL_INVALID_REASONS.NOT_A_DOMAIN
        : URL_INVALID_REASONS.HOSTNAME_NOT_PUBLIC,
    );
  }

  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const port = url.port === "" ? null : Number(url.port);
  if (port !== null && !ALLOWED_PORTS.includes(port)) {
    return err(URL_INVALID_REASONS.DISALLOWED_PORT);
  }

  // --- Path ---------------------------------------------------------------
  // `new URL()` has already resolved ./ and ../ and normalised percent
  // encoding. Two forms are produced from here on.
  //
  // `fetchPath` keeps the path the server was given, minus only duplicate
  // slashes — which no server distinguishes and which are always a mistake.
  // The trailing slash stays, because it identifies a different resource.
  //
  // `path` additionally drops the trailing slash, so "/a/b/" and "/a/b" are
  // one dedupe record. That is right for identity and wrong for fetching.
  const fetchPath = url.pathname.replace(/\/{2,}/g, "/") || "/";
  let path = fetchPath;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path.length === 0) path = "/";

  // --- Query --------------------------------------------------------------
  let search = "";
  if (url.search.length > 1) {
    if (options.keepQueryOrder) {
      search = url.search;
    } else {
      const drop = new Set(
        (options.trackingParams ?? DEFAULT_TRACKING_PARAMS).map((p) => p.toLowerCase()),
      );
      const kept: [string, string][] = [];
      for (const [key, value] of url.searchParams) {
        if (drop.has(key.toLowerCase())) continue;
        kept.push([key, value]);
      }
      // Sort so parameter order does not create duplicates. Sort by key, then
      // value, so repeated keys (?tag=a&tag=b) stay deterministic.
      kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
      if (kept.length > 0) {
        const params = new URLSearchParams();
        for (const [k, v] of kept) params.append(k, v);
        search = `?${params.toString()}`;
      }
    }
  }

  const fragment = options.keepFragment ? url.hash : "";

  const portPart = port !== null && port !== defaultPort ? `:${port}` : "";
  const normalized = `${url.protocol}//${host}${portPart}${path}${search}${fragment}`;

  // The fetch target differs only in keeping the trailing slash, and in never
  // carrying a fragment — a fragment is not sent to a server anyway, so
  // including it would be noise.
  const fetchUrl = `${url.protocol}//${host}${portPart}${fetchPath}${search}`;

  return ok({
    original,
    normalized,
    fetchUrl,
    hash: sha256Hex(normalized),
    protocol: url.protocol as AllowedProtocol,
    host,
    port,
    path,
    search,
    fragment,
    registrableDomain: isIpLiteral ? host : registrableDomain(host),
    isIpLiteral,
  });
}

export interface ValidateUrlOptions extends NormalizeOptions {
  /** Permit bare IP addresses as hosts. Off by default. */
  readonly allowIpLiteral?: boolean;
}

/**
 * `parseUrl` plus the policy checks that apply to anything we would actually
 * fetch. This is the function the CMS validation step and the worker's guard
 * both call.
 */
export function validateUrl(
  input: string,
  options: ValidateUrlOptions = {},
): Result<ParsedUrl, { reason: UrlInvalidReason; message: string }> {
  const parsed = parseUrl(input, options);
  if (!parsed.ok) {
    return err({ reason: parsed.error, message: URL_INVALID_MESSAGES[parsed.error] });
  }
  if (parsed.value.isIpLiteral && !options.allowIpLiteral) {
    // A policy refusal, not malformed input: the address parses and may well
    // be reachable. `HOSTNAME_NOT_PUBLIC` buckets as `blocked`, which is the
    // honest label — an operator who pasted `http://10.0.0.1/` did not make a
    // typo, they asked for something we will not do.
    return err({
      reason: URL_INVALID_REASONS.HOSTNAME_NOT_PUBLIC,
      message: "Bare IP addresses cannot be ingested; use a domain name.",
    });
  }
  return ok(parsed.value);
}

/** Convenience: normalised string only, or null when invalid. */
export function normalizeUrl(input: string, options: NormalizeOptions = {}): string | null {
  const parsed = parseUrl(input, options);
  return parsed.ok ? parsed.value.normalized : null;
}

/** Convenience: dedupe hash only, or null when invalid. */
export function urlHash(input: string, options: NormalizeOptions = {}): string | null {
  const parsed = parseUrl(input, options);
  return parsed.ok ? parsed.value.hash : null;
}

// --- Crawl scope ----------------------------------------------------------

export interface CrawlScope {
  /** Hosts the crawl is allowed to touch, already lowercased. */
  readonly hosts: readonly string[];
  /** Whether `sub.example.com` counts as in-scope for host `example.com`. */
  readonly includeSubdomains: boolean;
}

/**
 * Is `host` inside the crawl scope?
 *
 * Security-relevant, so it compares exact hosts and only treats a host as a
 * subdomain when the boundary is a real dot. `notexample.com` does not match
 * `example.com`, and `example.com.evil.test` does not match either — both are
 * classic suffix-check bypasses.
 */
export function hostMatchesScope(host: string, scope: CrawlScope): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const raw of scope.hosts) {
    const allowed = raw.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (h === allowed) return true;
    if (scope.includeSubdomains && h.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/** Resolve a possibly-relative href found on a page against its base URL. */
export function resolveDiscoveredHref(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  // Skip in-page and non-navigational hrefs before touching the URL parser.
  if (/^(#|mailto:|tel:|sms:|javascript:|data:|blob:|about:|file:|ftp:)/i.test(trimmed)) return null;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (!(ALLOWED_PROTOCOLS as readonly string[]).includes(resolved.protocol)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Group a list of parsed URLs by host, for the bulk-ingestion review screen
 * ("42 URLs across 6 domains") and for per-domain page caps.
 */
export function groupByHost(urls: readonly ParsedUrl[]): Map<string, ParsedUrl[]> {
  const out = new Map<string, ParsedUrl[]>();
  for (const u of urls) {
    const bucket = out.get(u.host);
    if (bucket) bucket.push(u);
    else out.set(u.host, [u]);
  }
  return out;
}

/** Shorten a URL for dense table cells without losing the meaningful end. */
export function displayUrl(input: string, maxLength = 60): string {
  const stripped = input.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (stripped.length <= maxLength) return stripped;
  const keepEnd = Math.floor(maxLength / 3);
  return `${stripped.slice(0, maxLength - keepEnd - 1)}…${stripped.slice(-keepEnd)}`;
}

/**
 * IP address classification.
 *
 * The blocklists below are the network half of SSRF defence. They are written
 * out in full, with each range's reason, because "block private IPs" is not one
 * rule — it is roughly thirty ranges across two address families, and the ones
 * that get forgotten (carrier-grade NAT, IPv4-mapped IPv6, NAT64, 6to4, the
 * cloud metadata addresses) are exactly the ones an attacker reaches for.
 *
 * Everything here is pure and synchronous. DNS resolution happens in
 * `url-guard.ts`; this module only answers "given this address, may we connect
 * to it?".
 */

export interface IpClassification {
  readonly address: string;
  readonly family: 4 | 6;
  /** Safe to connect to: a public, routable address. */
  readonly allowed: boolean;
  /** Which rule refused it. Null when allowed. */
  readonly blockedBy: string | null;
  /** Operator-facing explanation. */
  readonly reason: string | null;
}

// --- IPv4 -----------------------------------------------------------------

interface Cidr4 {
  readonly base: number;
  readonly mask: number;
  /**
   * The range as written, e.g. `192.0.2.0/24`.
   *
   * Kept rather than discarded after parsing, because it is the only
   * *unique* and operator-meaningful identifier a range has. The label is a
   * short category and three IPv4 ranges legitimately share one
   * ("documentation" covers TEST-NET-1, -2 and -3), so anything keyed or
   * displayed by label alone is ambiguous — and on a screen whose job is to
   * document the policy, "192.0.2.0/24" says more than "documentation".
   */
  readonly cidr: string;
  readonly label: string;
  readonly reason: string;
}

function cidr4(notation: string, label: string, reason: string): Cidr4 {
  const [addr, bitsRaw] = notation.split("/");
  const bits = Number(bitsRaw ?? 32);
  const base = ipv4ToInt(addr!);
  if (base === null) throw new Error(`Bad CIDR in blocklist: ${notation}`);
  // A /0 mask must be 0, which `-1 << 32` does not produce in JS (shift counts
  // are taken mod 32), so special-case it.
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, cidr: notation, label, reason };
}

export function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // Reject empty, non-numeric, leading-zero and out-of-range octets. Leading
    // zeros matter: "010" is octal in some resolvers, decimal in others, and
    // disagreement between our parser and the connecting library is a bypass.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * IPv4 ranges we refuse to connect to.
 *
 * Ordered roughly by how often each is used in an SSRF attempt, so the most
 * likely match short-circuits first.
 */
const BLOCKED_IPV4: readonly Cidr4[] = [
  cidr4("127.0.0.0/8", "loopback", "Loopback — this would reach a service on the worker itself."),
  cidr4(
    "169.254.0.0/16",
    "link-local",
    "Link-local. Includes the cloud instance metadata address 169.254.169.254, which holds credentials.",
  ),
  cidr4("10.0.0.0/8", "private-a", "Private network (RFC 1918) — internal infrastructure."),
  cidr4("172.16.0.0/12", "private-b", "Private network (RFC 1918) — internal infrastructure."),
  cidr4("192.168.0.0/16", "private-c", "Private network (RFC 1918) — internal infrastructure."),
  cidr4("0.0.0.0/8", "this-network", "\"This network\" — 0.0.0.0 resolves to localhost on many stacks."),
  cidr4(
    "100.64.0.0/10",
    "cgnat",
    "Carrier-grade NAT (RFC 6598). Reaches other tenants on shared infrastructure.",
  ),
  cidr4(
    "192.0.0.0/24",
    "ietf-protocol",
    "IETF protocol assignments. Not routable on the public internet.",
  ),
  cidr4(
    "192.0.2.0/24",
    "documentation",
    "Reserved for documentation (TEST-NET-1). Never a real destination.",
  ),
  cidr4(
    "198.51.100.0/24",
    "documentation",
    "Reserved for documentation (TEST-NET-2). Never a real destination.",
  ),
  cidr4(
    "203.0.113.0/24",
    "documentation",
    "Reserved for documentation (TEST-NET-3). Never a real destination.",
  ),
  cidr4(
    "192.88.99.0/24",
    "6to4-relay",
    "Deprecated 6to4 relay anycast, which forwards to arbitrary IPv6 destinations.",
  ),
  cidr4(
    "198.18.0.0/15",
    "benchmark",
    "Network benchmark testing (RFC 2544). Routed only inside test harnesses.",
  ),
  cidr4(
    "224.0.0.0/4",
    "multicast",
    "Multicast. Not a single host, and can be used to probe local network segments.",
  ),
  cidr4(
    "240.0.0.0/4",
    "reserved",
    "Reserved for future use. Includes 255.255.255.255, the limited broadcast address.",
  ),
  cidr4(
    "255.255.255.255/32",
    "broadcast",
    "Limited broadcast — reaches every host on the local segment at once.",
  ),
];

// --- IPv6 -----------------------------------------------------------------

interface Cidr6 {
  readonly base: bigint;
  readonly mask: bigint;
  /** The range as written. See `Cidr4.cidr`. */
  readonly cidr: string;
  readonly label: string;
  readonly reason: string;
}

const IPV6_BITS = 128n;

function cidr6(notation: string, label: string, reason: string): Cidr6 {
  const [addr, bitsRaw] = notation.split("/");
  const bits = BigInt(bitsRaw ?? "128");
  const base = ipv6ToBigInt(addr!);
  if (base === null) throw new Error(`Bad CIDR in blocklist: ${notation}`);
  const mask = bits === 0n ? 0n : ((1n << bits) - 1n) << (IPV6_BITS - bits);
  return { base: base & mask, mask, cidr: notation, label, reason };
}

/**
 * Parse an IPv6 address to a 128-bit integer.
 *
 * Handles `::` compression and a trailing embedded IPv4 (`::ffff:127.0.0.1`),
 * which is the form that matters most here: an IPv4-mapped IPv6 address is a
 * way to express 127.0.0.1 that a naive IPv6-only check would wave through.
 */
export function ipv6ToBigInt(address: string): bigint | null {
  let addr = address.trim();
  // Strip URL brackets and any zone index (%eth0).
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  if (addr.length === 0) return null;

  // An embedded IPv4 tail becomes two hextets.
  const lastColon = addr.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const high = (v4 >>> 16) & 0xffff;
    const low = v4 & 0xffff;
    addr = `${addr.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColon = addr.indexOf("::");
  let head: string[];
  let rear: string[];
  if (doubleColon === -1) {
    head = addr.split(":");
    rear = [];
    if (head.length !== 8) return null;
  } else {
    // More than one "::" is invalid.
    if (addr.indexOf("::", doubleColon + 1) !== -1) return null;
    const headPart = addr.slice(0, doubleColon);
    const rearPart = addr.slice(doubleColon + 2);
    head = headPart.length > 0 ? headPart.split(":") : [];
    rear = rearPart.length > 0 ? rearPart.split(":") : [];
    if (head.length + rear.length > 7) return null;
  }

  const hextets: string[] = [
    ...head,
    ...Array.from({ length: 8 - head.length - rear.length }, () => "0"),
    ...rear,
  ];
  if (hextets.length !== 8) return null;

  let value = 0n;
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(hextet, 16));
  }
  return value;
}

const BLOCKED_IPV6: readonly Cidr6[] = [
  cidr6("::1/128", "loopback", "IPv6 loopback — a service on the worker itself."),
  cidr6("::/128", "unspecified", "Unspecified address, which routes to localhost on many stacks."),
  cidr6("fc00::/7", "unique-local", "Unique local address (RFC 4193) — a private IPv6 network."),
  cidr6("fe80::/10", "link-local", "IPv6 link-local — reachable only on the local segment."),
  cidr6("ff00::/8", "multicast", "IPv6 multicast — addresses a group, not a host."),
  cidr6(
    "fd00:ec2::/32",
    "aws-metadata",
    "AWS instance metadata over IPv6 (fd00:ec2::254), which holds credentials.",
  ),
  cidr6("64:ff9b::/96", "nat64", "NAT64 prefix — translates to an arbitrary IPv4 address."),
  cidr6(
    "64:ff9b:1::/48",
    "nat64-local",
    "Local-use NAT64 prefix (RFC 8215), which translates to arbitrary IPv4.",
  ),
  cidr6("100::/64", "discard", "Discard-only address block (RFC 6666)."),
  cidr6("2001:db8::/32", "documentation", "Reserved for documentation. Never a real destination."),
  cidr6("2001::/32", "teredo", "Teredo tunnelling — encapsulates arbitrary destinations."),
  cidr6("2002::/16", "6to4", "6to4 tunnelling — embeds an arbitrary IPv4 destination."),
  cidr6("2001:10::/28", "orchid", "ORCHID overlay identifiers, deprecated and non-routable."),
  cidr6("2001:20::/28", "orchidv2", "ORCHIDv2 overlay identifiers, not publicly routable."),
];

/** IPv4-mapped IPv6 range: `::ffff:0:0/96`. Unwrapped and re-checked as IPv4. */
const IPV4_MAPPED_PREFIX = 0xffffn;
const IPV4_MAPPED_SHIFT = 32n;

/**
 * Hostnames that resolve to cloud metadata services.
 *
 * Checked by name as well as by address, because a DNS answer is not the only
 * way to reach these — a host file entry, a split-horizon resolver, or a
 * provider's magic DNS can all point a plausible-looking name at the metadata
 * endpoint without the address ever appearing in a resolution we inspect.
 */
export const BLOCKED_HOSTNAMES: readonly string[] = [
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.com",
  "metadata.packet.net",
  "metadata.platformequinix.com",
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
];

/** Suffixes that are internal by convention and never public. */
export const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".private",
  ".corp",
  ".home",
  ".lan",
  ".test",
  ".example",
  ".invalid",
  ".onion",
  ".ec2.internal",
  ".compute.internal",
  ".svc.cluster.local",
  ".cluster.local",
];

/**
 * Classify a single IP address.
 *
 * `address` must be a literal address, not a hostname — resolution is the
 * caller's job.
 */
export function classifyIp(address: string): IpClassification {
  const v4 = ipv4ToInt(address);
  if (v4 !== null) {
    for (const range of BLOCKED_IPV4) {
      if (((v4 & range.mask) >>> 0) === range.base) {
        return { address, family: 4, allowed: false, blockedBy: range.label, reason: range.reason };
      }
    }
    return { address, family: 4, allowed: true, blockedBy: null, reason: null };
  }

  const v6 = ipv6ToBigInt(address);
  if (v6 !== null) {
    // An IPv4-mapped address (::ffff:a.b.c.d) is an IPv4 destination wearing an
    // IPv6 costume. Unwrap and apply the IPv4 rules, or ::ffff:127.0.0.1 walks
    // straight through an IPv6-only blocklist.
    if (v6 >> IPV4_MAPPED_SHIFT === IPV4_MAPPED_PREFIX) {
      const embedded = Number(v6 & 0xffffffffn);
      const dotted = [24, 16, 8, 0].map((shift) => (embedded >>> shift) & 0xff).join(".");
      const inner = classifyIp(dotted);
      return {
        address,
        family: 6,
        allowed: inner.allowed,
        blockedBy: inner.allowed ? null : `ipv4-mapped:${inner.blockedBy}`,
        reason: inner.allowed
          ? null
          : `IPv4-mapped IPv6 address for ${dotted}. ${inner.reason ?? ""}`.trim(),
      };
    }
    for (const range of BLOCKED_IPV6) {
      if ((v6 & range.mask) === range.base) {
        return { address, family: 6, allowed: false, blockedBy: range.label, reason: range.reason };
      }
    }
    return { address, family: 6, allowed: true, blockedBy: null, reason: null };
  }

  // Not parseable as either family. Refuse rather than guess: an address we
  // cannot classify is an address we cannot vouch for.
  return {
    address,
    family: 4,
    allowed: false,
    blockedBy: "unparseable",
    reason: "This address could not be parsed as IPv4 or IPv6.",
  };
}

/** Is this hostname refused by name, before any DNS lookup? */
export function classifyHostname(hostname: string): { allowed: boolean; reason: string | null } {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (BLOCKED_HOSTNAMES.includes(host)) {
    return { allowed: false, reason: `"${host}" names a local or metadata service.` };
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { allowed: false, reason: `The "${suffix}" suffix is reserved for internal names.` };
    }
  }
  // A single-label hostname ("db", "redis", "intranet") can only resolve
  // through a local search domain, so it is internal by construction.
  if (!host.includes(".")) {
    return {
      allowed: false,
      reason: `"${host}" has no domain suffix, so it can only refer to something on the local network.`,
    };
  }
  return { allowed: true, reason: null };
}

/** All blocked ranges, for the Settings screen and the docs. */
export function describeBlockedRanges(): {
  family: 4 | 6;
  cidr: string;
  label: string;
  reason: string;
}[] {
  return [
    ...BLOCKED_IPV4.map((r) => ({
      family: 4 as const,
      cidr: r.cidr,
      label: r.label,
      reason: r.reason,
    })),
    ...BLOCKED_IPV6.map((r) => ({
      family: 6 as const,
      cidr: r.cidr,
      label: r.label,
      reason: r.reason,
    })),
  ];
}

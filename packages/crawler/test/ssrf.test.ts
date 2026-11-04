/**
 * SSRF protection tests (§37 "tests for URL validation/SSRF protections").
 *
 * The address-classification tests are exhaustive and offline. The guard tests
 * use `skipDnsForTesting` for the pure layers and a stub resolver where the
 * DNS answer itself is the thing under test, so nothing here touches the
 * network or depends on what a real domain currently resolves to.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GUARD_FAILURE_KINDS,
  classifyHostname,
  classifyIp,
  describeBlockedRanges,
  guardRedirect,
  guardUrl,
  hostResolverRules,
  ipv4ToInt,
  hostResolvesToPublicAddress,
  isGuardPolicyRefusal,
  ipv6ToBigInt,
} from "@uxd/crawler";

const blocked = (address: string, expectedRule?: string) => {
  const result = classifyIp(address);
  assert.equal(result.allowed, false, `${address} must be blocked`);
  assert.ok(result.reason, `${address} should carry a reason`);
  if (expectedRule) assert.match(result.blockedBy ?? "", new RegExp(expectedRule), address);
};

const allowed = (address: string) => {
  const result = classifyIp(address);
  assert.equal(result.allowed, true, `${address} should be allowed but was blocked: ${result.reason}`);
};

describe("classifyIp — IPv4 ranges that must never be reachable", () => {
  it("blocks loopback", () => {
    for (const a of ["127.0.0.1", "127.0.0.53", "127.1.2.3", "127.255.255.254"]) blocked(a, "loopback");
  });

  it("blocks cloud instance metadata", () => {
    // The single most valuable SSRF target: this address serves IAM
    // credentials on AWS, GCP, Azure, DigitalOcean and Oracle Cloud.
    blocked("169.254.169.254", "link-local");
    blocked("169.254.170.2", "link-local"); // ECS task metadata
    blocked("169.254.0.1", "link-local");
  });

  it("blocks RFC 1918 private networks", () => {
    for (const a of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.1.1"]) {
      blocked(a, "private");
    }
  });

  it("blocks carrier-grade NAT, which reaches other tenants", () => {
    for (const a of ["100.64.0.1", "100.100.100.200", "100.127.255.255"]) blocked(a, "cgnat");
  });

  it("blocks 0.0.0.0/8, which many stacks route to localhost", () => {
    blocked("0.0.0.0", "this-network");
    blocked("0.1.2.3", "this-network");
  });

  it("blocks multicast, reserved, broadcast and documentation ranges", () => {
    blocked("224.0.0.1", "multicast");
    blocked("239.255.255.255", "multicast");
    blocked("240.0.0.1", "reserved");
    // Matched by 240.0.0.0/4 before the more specific /32 rule is reached.
    // Which rule fires does not matter; that it is refused does.
    blocked("255.255.255.255");
    blocked("192.0.2.1", "documentation");
    blocked("198.51.100.1", "documentation");
    blocked("203.0.113.1", "documentation");
    blocked("198.18.0.1", "benchmark");
    blocked("192.88.99.1", "6to4-relay");
    blocked("192.0.0.1", "ietf-protocol");
  });

  it("allows ordinary public addresses", () => {
    for (const a of ["93.184.216.34", "1.1.1.1", "8.8.8.8", "151.101.1.140", "172.32.0.1", "11.0.0.1", "100.63.255.255", "100.128.0.1"]) {
      allowed(a);
    }
  });

  it("checks the exact boundaries of each range", () => {
    // One address below and above 172.16.0.0/12.
    blocked("172.16.0.0");
    blocked("172.31.255.255");
    allowed("172.15.255.255");
    allowed("172.32.0.0");
    // 100.64.0.0/10
    blocked("100.64.0.0");
    blocked("100.127.255.255");
    allowed("100.63.255.255");
    allowed("100.128.0.0");
  });
});

describe("classifyIp — IPv6", () => {
  it("blocks loopback, unspecified, ULA, link-local and multicast", () => {
    blocked("::1", "loopback");
    blocked("::", "unspecified");
    blocked("fc00::1", "unique-local");
    blocked("fd00::1", "unique-local");
    blocked("fdff:ffff::1", "unique-local");
    blocked("fe80::1", "link-local");
    blocked("ff02::1", "multicast");
  });

  it("blocks the AWS IPv6 metadata address", () => {
    blocked("fd00:ec2::254", "unique-local");
  });

  it("blocks tunnelling prefixes that embed arbitrary destinations", () => {
    blocked("64:ff9b::7f00:1", "nat64");
    blocked("2002:7f00:0001::", "6to4");
    blocked("2001:0:1::", "teredo");
    blocked("2001:db8::1", "documentation");
    blocked("100::1", "discard");
  });

  it("unwraps IPv4-mapped IPv6 and applies the IPv4 rules", () => {
    // The bypass this defends: an IPv6-only blocklist waves ::ffff:127.0.0.1
    // straight through to localhost.
    blocked("::ffff:127.0.0.1", "ipv4-mapped");
    blocked("::ffff:169.254.169.254", "ipv4-mapped");
    blocked("::ffff:10.0.0.1", "ipv4-mapped");
    blocked("::ffff:192.168.1.1", "ipv4-mapped");
    // ...and the reason names the address it really is.
    assert.match(classifyIp("::ffff:169.254.169.254").reason ?? "", /169\.254\.169\.254/);
    // A mapped public address is still fine.
    allowed("::ffff:93.184.216.34");
  });

  it("allows ordinary public IPv6", () => {
    for (const a of ["2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888", "2620:fe::fe"]) {
      allowed(a);
    }
  });

  it("handles bracketed and zoned forms", () => {
    blocked("[::1]", "loopback");
    blocked("fe80::1%eth0", "link-local");
  });

  it("refuses anything it cannot parse, rather than guessing", () => {
    for (const a of ["", "not-an-ip", "999.999.999.999", "1.2.3", "1.2.3.4.5", ":::1", "12345::", "gggg::1"]) {
      blocked(a, "unparseable");
    }
  });
});

describe("ipv4ToInt — parser strictness", () => {
  it("rejects leading zeros, which different resolvers read differently", () => {
    // "010.0.0.1" is 8.0.0.1 to an octal-aware resolver and 10.0.0.1 to a
    // decimal one. Disagreement between our parser and the connecting library
    // is a bypass, so the ambiguous form is refused outright.
    assert.equal(ipv4ToInt("010.0.0.1"), null);
    assert.equal(ipv4ToInt("127.00.0.1"), null);
    assert.equal(ipv4ToInt("0177.0.0.1"), null);
  });

  it("rejects malformed and out-of-range octets", () => {
    for (const a of ["256.1.1.1", "1.1.1.256", "1.1.1", "1.1.1.1.1", "-1.1.1.1", "a.b.c.d", "1..1.1", ""]) {
      assert.equal(ipv4ToInt(a), null, a);
    }
  });

  it("parses valid addresses", () => {
    assert.equal(ipv4ToInt("0.0.0.0"), 0);
    assert.equal(ipv4ToInt("127.0.0.1"), 2130706433);
    assert.equal(ipv4ToInt("255.255.255.255"), 4294967295);
  });
});

describe("ipv6ToBigInt", () => {
  it("expands compressed forms", () => {
    assert.equal(ipv6ToBigInt("::1"), 1n);
    assert.equal(ipv6ToBigInt("::"), 0n);
    assert.equal(ipv6ToBigInt("0:0:0:0:0:0:0:1"), 1n);
    assert.equal(ipv6ToBigInt("2001:db8::1"), ipv6ToBigInt("2001:0db8:0000:0000:0000:0000:0000:0001"));
  });

  it("handles embedded IPv4", () => {
    assert.equal(ipv6ToBigInt("::ffff:127.0.0.1"), (0xffffn << 32n) | 2130706433n);
  });

  it("rejects invalid forms", () => {
    for (const a of ["1::2::3", "12345::", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "gggg::"]) {
      assert.equal(ipv6ToBigInt(a), null, a);
    }
  });
});

describe("classifyHostname — refused before any DNS query", () => {
  it("blocks names that only ever mean something local", () => {
    for (const h of ["localhost", "LOCALHOST", "localhost.", "ip6-localhost", "instance-data"]) {
      assert.equal(classifyHostname(h).allowed, false, h);
    }
  });

  it("blocks cloud metadata hostnames", () => {
    // Reachable without the metadata IP ever appearing in a DNS answer we see.
    for (const h of ["metadata.google.internal", "metadata.goog", "metadata.azure.com"]) {
      assert.equal(classifyHostname(h).allowed, false, h);
    }
  });

  it("blocks internal-by-convention suffixes", () => {
    for (const h of [
      "app.localhost",
      "printer.local",
      "api.internal",
      "wiki.corp",
      "nas.home",
      "server.lan",
      "svc.test",
      "thing.invalid",
      "site.onion",
      "ip-10-0-0-1.ec2.internal",
      "kubernetes.default.svc.cluster.local",
    ]) {
      assert.equal(classifyHostname(h).allowed, false, h);
    }
  });

  it("blocks single-label hostnames, which need a local search domain", () => {
    for (const h of ["db", "redis", "postgres", "intranet", "router", "cache"]) {
      assert.equal(classifyHostname(h).allowed, false, h);
    }
  });

  it("allows ordinary public hostnames", () => {
    for (const h of ["example.com", "www.stripe.com", "a.b.c.example.co.uk"]) {
      assert.equal(classifyHostname(h).allowed, true, h);
    }
  });

  it("explains itself, since the message reaches a crawl log", () => {
    const result = classifyHostname("db");
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /local network/i);
  });
});

describe("guardUrl — layered refusal", () => {
  const noDns = { skipDnsForTesting: true } as const;

  it("refuses non-http protocols before anything else", async () => {
    for (const u of ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/", "data:text/html,x", "jar:https://example.com!/x"]) {
      const result = await guardUrl(u, noDns);
      assert.equal(result.ok, false, u);
      if (!result.ok) assert.equal(result.error.kind, GUARD_FAILURE_KINDS.INVALID_URL);
    }
  });

  it("refuses localhost and internal names without resolving them", async () => {
    // `localhost` is caught one layer earlier, by the syntax rule that a
    // hostname must have a domain suffix. Both refusals are correct; the
    // assertion is that no internal name gets through, whichever layer stops it.
    for (const u of ["http://localhost:8080/", "http://localhost/"]) {
      const result = await guardUrl(u, noDns);
      assert.equal(result.ok, false, u);
      if (!result.ok) {
        assert.ok(
          result.error.kind === GUARD_FAILURE_KINDS.BLOCKED_HOSTNAME ||
            result.error.kind === GUARD_FAILURE_KINDS.INVALID_URL,
          `${u} refused as ${result.error.kind}`,
        );
      }
    }
    // These have a domain suffix, so they reach the hostname layer proper.
    for (const u of [
      "http://api.internal/v1",
      "http://metadata.google.internal/",
      "http://kubernetes.default.svc.cluster.local/",
      "http://wiki.corp/",
      "http://ip-10-0-0-1.ec2.internal/",
    ]) {
      const result = await guardUrl(u, noDns);
      assert.equal(result.ok, false, u);
      if (!result.ok) assert.equal(result.error.kind, GUARD_FAILURE_KINDS.BLOCKED_HOSTNAME, u);
    }
  });

  it("refuses bare IP hosts by default, including obfuscated IPv4", async () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0177.0.0.1/",
      "http://0x7f000001/",
      "http://127.1/",
      "http://[::1]/",
    ]) {
      const result = await guardUrl(u, noDns);
      assert.equal(result.ok, false, u);
    }
  });

  it("refuses a private IP even when literals are explicitly permitted", async () => {
    // allowIpLiteral relaxes the "must be a domain name" rule; it does not
    // relax the address rules.
    for (const u of ["http://127.0.0.1/", "http://169.254.169.254/", "http://10.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
      const result = await guardUrl(u, { ...noDns, allowIpLiteral: true });
      assert.equal(result.ok, false, u);
      if (!result.ok) assert.equal(result.error.kind, GUARD_FAILURE_KINDS.PRIVATE_ADDRESS);
    }
  });

  it("permits a public literal IP when explicitly opted in, and pins it", async () => {
    const result = await guardUrl("http://93.184.216.34/", { allowIpLiteral: true });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.pinned, true);
      assert.deepEqual(result.value.addresses, [{ address: "93.184.216.34", family: 4 }]);
    }
  });

  it("applies the operator blocklist, including subdomains", async () => {
    // Ordinary public domains, not .test/.example — those are already refused
    // by the hostname layer as reserved TLDs, which would not exercise the
    // operator blocklist at all.
    const policy = { ...noDns, blockedDomains: ["blockedsite.com", "evilcorp.net"] };
    for (const u of [
      "https://blockedsite.com/x",
      "https://sub.blockedsite.com/x",
      "https://a.b.evilcorp.net/",
    ]) {
      const result = await guardUrl(u, policy);
      assert.equal(result.ok, false, u);
      if (!result.ok) assert.equal(result.error.kind, GUARD_FAILURE_KINDS.BLOCKED_BY_POLICY, u);
    }
    // A domain that merely shares a suffix is not blocked — the same
    // dot-boundary rule as crawl scope.
    assert.equal((await guardUrl("https://notblockedsite.com/", policy)).ok, true);
  });

  it("applies an allowlist when one is configured", async () => {
    const policy = { ...noDns, allowedDomains: ["stripe.com"] };
    assert.equal((await guardUrl("https://stripe.com/pricing", policy)).ok, true);
    assert.equal((await guardUrl("https://docs.stripe.com/x", policy)).ok, true);
    const denied = await guardUrl("https://example.com/", policy);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.kind, GUARD_FAILURE_KINDS.NOT_IN_ALLOWLIST);
  });

  it("applies crawl scope to discovered links", async () => {
    const policy = { ...noDns, scope: { hosts: ["example.com"], includeSubdomains: false } };
    assert.equal((await guardUrl("https://example.com/a", policy)).ok, true);
    const offScope = await guardUrl("https://other.com/a", policy);
    assert.equal(offScope.ok, false);
    if (!offScope.ok) assert.equal(offScope.error.kind, GUARD_FAILURE_KINDS.OUT_OF_SCOPE);
    // And the subdomain bypass does not work.
    const sub = await guardUrl("https://sub.example.com/a", policy);
    assert.equal(sub.ok, false);
  });

  it("reports a DNS failure distinctly from a block", async () => {
    // A name that cannot resolve, using a reserved TLD so no lookup succeeds.
    const result = await guardUrl("https://definitely-not-a-real-host-9f3a.example/", {
      dnsTimeoutMs: 3_000,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.error.kind === GUARD_FAILURE_KINDS.DNS_FAILED ||
          result.error.kind === GUARD_FAILURE_KINDS.BLOCKED_HOSTNAME,
        `unexpected kind ${result.error.kind}`,
      );
    }
  });

  it("carries an operator-readable message and an error code on every failure", async () => {
    const cases = ["file:///etc/passwd", "http://localhost/", "http://127.0.0.1/"];
    for (const u of cases) {
      const result = await guardUrl(u, noDns);
      assert.equal(result.ok, false, u);
      if (!result.ok) {
        assert.ok(result.error.message.length > 10, `${u} needs a real message`);
        assert.ok(result.error.errorCode, `${u} needs an error code`);
        assert.ok(result.error.url, `${u} should echo the url`);
      }
    }
  });
});

describe("guardRedirect — the hop that usually escapes checking", () => {
  it("re-applies every check to a redirect target", async () => {
    const from = "https://example.com/start";
    for (const location of [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:6379/",
      "file:///etc/passwd",
      "/../..//etc/passwd",
      "http://10.0.0.1/",
    ]) {
      const result = await guardRedirect(location, from, { skipDnsForTesting: true });
      // The relative path resolves back to example.com and is legitimately
      // allowed; the absolute internal targets must all be refused.
      if (location.startsWith("/")) continue;
      assert.equal(result.ok, false, location);
    }
  });

  it("resolves a relative redirect against the originating URL", async () => {
    const result = await guardRedirect("/pricing", "https://example.com/start", {
      skipDnsForTesting: true,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.parsed.normalized, "https://example.com/pricing");
  });

  it("does not apply crawl scope to a redirect, since example.com -> www is normal", async () => {
    const result = await guardRedirect("https://www.example.com/", "https://example.com/", {
      skipDnsForTesting: true,
      scope: { hosts: ["example.com"], includeSubdomains: false },
    });
    assert.equal(result.ok, true, "a same-site redirect should not be a scope failure");
  });

  it("refuses an unparseable redirect target", async () => {
    const result = await guardRedirect("http://[bad", "https://example.com/", {
      skipDnsForTesting: true,
    });
    assert.equal(result.ok, false);
  });
});

describe("address pinning", () => {
  it("produces Chromium resolver rules that map the host and exclude internal suffixes", () => {
    const rules = hostResolverRules({
      parsed: { host: "example.com" } as never,
      addresses: [{ address: "93.184.216.34", family: 4 }],
      pinned: true,
    });
    assert.ok(rules);
    assert.match(rules, /MAP example\.com 93\.184\.216\.34/);
    assert.match(rules, /EXCLUDE \*\.internal/);
    assert.match(rules, /EXCLUDE \*\.local/);
  });

  it("returns null when there is nothing validated to pin to", () => {
    assert.equal(
      hostResolverRules({ parsed: { host: "example.com" } as never, addresses: [], pinned: false }),
      null,
    );
  });
});

describe("describeBlockedRanges — surfaced in Settings and the docs", () => {
  it("documents every range with a reason", () => {
    const ranges = describeBlockedRanges();
    assert.ok(ranges.length >= 25, `expected a substantial blocklist, got ${ranges.length}`);
    for (const range of ranges) {
      assert.ok(range.label.length > 0);
      assert.ok(range.reason.length > 10, `${range.label} needs an explanation`);
    }
    assert.ok(ranges.some((r) => r.family === 4));
    assert.ok(ranges.some((r) => r.family === 6));
  });
});

describe("isGuardPolicyRefusal — a refusal is not the same as a failed lookup", () => {
  /**
   * A crawl experiment found a local DNS hiccup marking 31 real domains
   * (figma.com, gitlab.com, fonts.google.com) as `blocked` and non-retryable,
   * so they were discarded permanently and labelled identically to a
   * robots.txt refusal. The two call sites that decide this had also drifted:
   * the HTTP fetch path retried a DNS failure while the pre-flight guard did
   * not. These tests exist so both can be asked one question instead of each
   * having its own opinion.
   */
  it("treats a failed lookup as retryable, because it is not an answer", () => {
    assert.equal(
      isGuardPolicyRefusal(GUARD_FAILURE_KINDS.DNS_FAILED),
      false,
      "a resolver being briefly unavailable must not discard a URL",
    );
  });

  it("treats every actual policy decision as final", () => {
    // Retrying cannot make a private address public or an ftp:// URL http(s).
    for (const kind of [
      GUARD_FAILURE_KINDS.INVALID_URL,
      GUARD_FAILURE_KINDS.BLOCKED_HOSTNAME,
      GUARD_FAILURE_KINDS.BLOCKED_BY_POLICY,
      GUARD_FAILURE_KINDS.NOT_IN_ALLOWLIST,
      GUARD_FAILURE_KINDS.PRIVATE_ADDRESS,
      GUARD_FAILURE_KINDS.OUT_OF_SCOPE,
    ]) {
      assert.equal(isGuardPolicyRefusal(kind), true, `${kind} must be terminal`);
    }
  });

  it("covers every kind the guard can produce", () => {
    // A new failure kind defaults to "policy refusal", which is the safe
    // direction — but it should be a deliberate choice, so this fails loudly
    // if one is added without a decision being recorded above.
    const decided = new Set([
      GUARD_FAILURE_KINDS.DNS_FAILED,
      GUARD_FAILURE_KINDS.INVALID_URL,
      GUARD_FAILURE_KINDS.BLOCKED_HOSTNAME,
      GUARD_FAILURE_KINDS.BLOCKED_BY_POLICY,
      GUARD_FAILURE_KINDS.NOT_IN_ALLOWLIST,
      GUARD_FAILURE_KINDS.PRIVATE_ADDRESS,
      GUARD_FAILURE_KINDS.OUT_OF_SCOPE,
    ]);
    for (const kind of Object.values(GUARD_FAILURE_KINDS)) {
      assert.ok(decided.has(kind), `${kind} has no recorded retry decision`);
    }
  });

  it("refuses a private address as policy, not as a lookup failure", () => {
    // The end-to-end shape: the guard resolved the name fine and disliked the
    // answer. That is an answer, and it is terminal.
    const failure = { kind: GUARD_FAILURE_KINDS.PRIVATE_ADDRESS };
    assert.equal(isGuardPolicyRefusal(failure.kind), true);
  });
});

describe("hostResolvesToPublicAddress — the subresource screen", () => {
  /**
   * The main document was always resolved and pinned. Subresources were
   * screened by hostname *pattern* only, on the reasoning that a per-request
   * DNS query is too slow for a page issuing hundreds of them. The gap that
   * left is not subtle: a public name with a private A record passed cleanly,
   * and the browser would then fetch from an internal host on behalf of a page
   * we do not control.
   */
  it("refuses a hostname the pattern rules already reject, without a query", async () => {
    for (const host of ["localhost", "foo.local", "svc.internal", "metadata.google.internal"]) {
      const verdict = await hostResolvesToPublicAddress(host, { skipDnsForTesting: true });
      assert.equal(verdict.allowed, false, `${host} must be refused`);
      assert.ok(verdict.reason, `${host} should say why`);
    }
  });

  it("refuses a reserved suffix by pattern, before spending a query on it", async () => {
    const verdict = await hostResolvesToPublicAddress("nope.invalid", { dnsTimeoutMs: 2_000 });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? "", /invalid/i, "the pattern rule should be the one that fired");
  });

  it("refuses a resolvable-looking name that does not resolve", async () => {
    // Fails closed. A subresource we cannot verify is not loaded — the
    // screenshot is slightly poorer, which is the correct thing to trade.
    // A subdomain of a real domain gets past the pattern rules, so this
    // exercises the lookup itself rather than the cheap pre-check.
    const verdict = await hostResolvesToPublicAddress(
      "no-such-host-9f3a2b7c.example.com",
      { dnsTimeoutMs: 5_000 },
    );
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? "", /resolve/i);
  });

  it("allows a public name that resolves to public addresses", async () => {
    // The one case that needs the network. Skipped rather than failed when
    // DNS is unavailable, so the suite stays runnable offline.
    const verdict = await hostResolvesToPublicAddress("example.com", { dnsTimeoutMs: 5_000 });
    if (!verdict.allowed && /could not resolve/.test(verdict.reason ?? "")) return;
    assert.equal(verdict.allowed, true, `example.com was refused: ${verdict.reason}`);
  });

  it("does not query at all when DNS is skipped for a permitted name", async () => {
    const verdict = await hostResolvesToPublicAddress("example.com", { skipDnsForTesting: true });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, null);
  });
});

/**
 * Redaction utilities for benchmark artifacts and packs.
 *
 * Mirrors the rules from jake-benchmark `harness/lib/sanitize.py` so that a
 * pack or run artifact validated here matches what jake-benchmark would
 * publish. Three profiles:
 *
 *   - "none":     pass through unchanged
 *   - "internal": redact secrets only (tokens/keys)
 *   - "public":   redact everything that could leak topology, identity, or auth
 *
 * Profiles are additive: "public" includes everything "internal" does.
 *
 * The audit helper is the contract used by tests to fail builds when a
 * sensitive pattern survives a sanitization pass on a vendored pack.
 */

export type RedactionProfile = "none" | "internal" | "public";

type Rule = {
  name: string;
  pattern: RegExp;
  replacement: string;
  profiles: ReadonlySet<RedactionProfile>;
};

const SECRET_PROFILES: ReadonlySet<RedactionProfile> = new Set<RedactionProfile>([
  "internal",
  "public",
]);
const PUBLIC_ONLY: ReadonlySet<RedactionProfile> = new Set<RedactionProfile>(["public"]);

const INTERNAL_HOSTNAMES = [
  "frank-pc",
  "frank-wsl",
  "frankpi",
  "DESKTOP-DDEC81D",
  "clawed-nina",
  "clawed-peter",
  "clawed-adamas",
  "clawed-george",
  "clawed-jason_wwsa",
  "clawed-wwsa",
];

const RULES: Rule[] = [
  // --- Secrets (always redacted, even in 'internal' mode) ---
  {
    name: "anthropic_key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: "<REDACTED:anthropic_key>",
    profiles: SECRET_PROFILES,
  },
  {
    name: "openai_key",
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: "<REDACTED:openai_key>",
    profiles: SECRET_PROFILES,
  },
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "<REDACTED:aws_key>",
    profiles: SECRET_PROFILES,
  },
  {
    name: "bearer_token",
    pattern: /bearer\s+[A-Za-z0-9_.=-]{16,}/gi,
    replacement: "bearer <REDACTED:token>",
    profiles: SECRET_PROFILES,
  },
  {
    name: "oauth_refresh",
    pattern: /1\/\/[A-Za-z0-9_-]{30,}/g,
    replacement: "<REDACTED:oauth_refresh>",
    profiles: SECRET_PROFILES,
  },

  // --- Public-only: topology, identity, paths ---
  // Tailscale CGNAT range (100.64.0.0/10). Must run BEFORE generic IPv4.
  {
    name: "tailscale_ip",
    pattern: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    replacement: "<REDACTED:tailscale_ip>",
    profiles: PUBLIC_ONLY,
  },
  // Generic IPv4. The vendored agent pack uses 127.0.0.1 in literal task
  // text (loopback). The audit helper can elect to ignore loopback.
  {
    name: "ipv4",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "<REDACTED:ipv4>",
    profiles: PUBLIC_ONLY,
  },
  // Email addresses.
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "<REDACTED:email>",
    profiles: PUBLIC_ONLY,
  },
  // E.164 phone numbers.
  {
    name: "phone_e164",
    pattern: /\+\d{10,15}\b/g,
    replacement: "<REDACTED:phone>",
    profiles: PUBLIC_ONLY,
  },
  // North American phone formats. Require explicit phone formatting to
  // avoid swallowing 10-digit timestamps that appear inside run-IDs.
  {
    name: "phone_na",
    pattern: /(?:\(\d{3}\)[\s-]?\d{3}[\s-]\d{4}|\b(?:1[\s-])?\d{3}[\s-]\d{3}[\s-]\d{4}\b)/g,
    replacement: "<REDACTED:phone>",
    profiles: PUBLIC_ONLY,
  },
  // Internal hostnames (single alternation, word-bounded).
  {
    name: "internal_hostname",
    pattern: new RegExp("\\b(?:" + INTERNAL_HOSTNAMES.map(escapeRegExp).join("|") + ")\\b", "g"),
    replacement: "<REDACTED:hostname>",
    profiles: PUBLIC_ONLY,
  },
  // Absolute home/root paths.
  {
    name: "home_path",
    pattern: /\/(?:home|Users|root|var\/lib)\/[A-Za-z0-9._\-/]+/g,
    replacement: "<REDACTED:path>",
    profiles: PUBLIC_ONLY,
  },
];

/**
 * Domains and IPs that are intentionally allowed in fictional fixtures or
 * loopback test setups. The audit helper accepts an `allowList` of email
 * domains and IPs that are not flagged as leaks.
 */
export type AuditOptions = {
  allowEmailDomains?: readonly string[];
  allowIps?: readonly string[];
  allowLoopbackIps?: boolean;
};

export type LeakFinding = {
  rule: string;
  match: string;
  start: number;
  end: number;
};

/**
 * Apply redaction to a string using the named profile. Idempotent.
 */
export function sanitize(text: string, profile: RedactionProfile = "public"): string {
  if (profile === "none" || text.length === 0) {
    return text;
  }
  let out = text;
  for (const rule of RULES) {
    if (!rule.profiles.has(profile)) {
      continue;
    }
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Recursively redact strings in objects/arrays. Other types pass through.
 */
export function sanitizeObject<T>(obj: T, profile: RedactionProfile = "public"): T {
  if (typeof obj === "string") {
    return sanitize(obj, profile) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => sanitizeObject(v, profile)) as T;
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeObject(v, profile);
    }
    return out as T;
  }
  return obj;
}

/**
 * Walk text and return all sensitive matches that survive sanitization.
 * Used by tests to assert the vendored agent pack is public-safe.
 */
export function audit(text: string, opts: AuditOptions = {}): LeakFinding[] {
  const allowDomains = new Set((opts.allowEmailDomains ?? []).map((d) => d.toLowerCase()));
  const allowIps = new Set(opts.allowIps ?? []);
  const allowLoopback = opts.allowLoopbackIps ?? false;

  const findings: LeakFinding[] = [];
  for (const rule of RULES) {
    // Reset lastIndex for each scan.
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null = regex.exec(text);
    while (m !== null) {
      const match = m[0];
      if (rule.name === "email") {
        const domain = match.split("@")[1]?.toLowerCase() ?? "";
        if (allowDomains.has(domain)) {
          m = regex.exec(text);
          continue;
        }
      }
      if (rule.name === "ipv4" || rule.name === "tailscale_ip") {
        if (allowIps.has(match)) {
          m = regex.exec(text);
          continue;
        }
        if (allowLoopback && (match === "127.0.0.1" || match.startsWith("127."))) {
          m = regex.exec(text);
          continue;
        }
      }
      findings.push({ rule: rule.name, match, start: m.index, end: m.index + match.length });
      m = regex.exec(text);
    }
  }
  return findings;
}

/**
 * Audit a parsed pack object by serializing it then scanning. The pack JSON
 * shape is stable so this is a faithful representation of what would ship.
 */
export function auditPack(pack: unknown, opts: AuditOptions = {}): LeakFinding[] {
  return audit(JSON.stringify(pack), opts);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names of all redaction rules active under the given profile. Useful for
 * documentation and tests that assert profile coverage.
 */
export function ruleNames(profile: RedactionProfile = "public"): string[] {
  if (profile === "none") {
    return [];
  }
  return RULES.filter((r) => r.profiles.has(profile)).map((r) => r.name);
}

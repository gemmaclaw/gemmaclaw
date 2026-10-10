import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  audit,
  auditPack,
  HOSTNAMES_ENV,
  HOSTNAMES_FILE_ENV,
  privateHostnamesConfigured,
  reloadPrivateHostnames,
  ruleNames,
  sanitize,
  sanitizeObject,
} from "./redaction.js";
import { loadAgentFixtureTasks } from "./task-loader.js";

// The real hostname list lives outside the repo; pin the fixture fakes so the
// tests do not depend on what the machine running them has configured.
const FAKE_HOSTNAMES = ["example-tailnet-host-c77ea0", "example-private-host-33ba82"];
const ABSENT_FILE = path.join(os.tmpdir(), "gemmaclaw-redaction-test-absent.txt");

function pinFakeHostnames(): void {
  reloadPrivateHostnames({
    [HOSTNAMES_ENV]: FAKE_HOSTNAMES.join(","),
    [HOSTNAMES_FILE_ENV]: ABSENT_FILE,
  });
}

beforeEach(pinFakeHostnames);
afterAll(() => {
  reloadPrivateHostnames();
});

describe("private hostname config", () => {
  it("matches configured hostnames case-insensitively", () => {
    expect(sanitize("box EXAMPLE-TAILNET-HOST-C77EA0 up", "public")).toBe(
      "box <REDACTED:hostname> up",
    );
  });

  it("loads names from the env list and the config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-redaction-"));
    const file = path.join(dir, "hosts.txt");
    fs.writeFileSync(file, "# private list\nexample-file-host  # note\n\n");
    const names = reloadPrivateHostnames({
      [HOSTNAMES_ENV]: "example-env-a, example-env-b",
      [HOSTNAMES_FILE_ENV]: file,
    });
    expect(names.toSorted()).toEqual(["example-env-a", "example-env-b", "example-file-host"]);
    expect(sanitize("example-file-host example-env-b", "public")).toBe(
      "<REDACTED:hostname> <REDACTED:hostname>",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("has no hostname rule when nothing is configured", () => {
    expect(reloadPrivateHostnames({ [HOSTNAMES_FILE_ENV]: ABSENT_FILE })).toEqual([]);
    expect(privateHostnamesConfigured()).toBe(false);
    expect(ruleNames("public")).not.toContain("internal_hostname");
    expect(sanitize("example-tailnet-host-c77ea0", "public")).toBe("example-tailnet-host-c77ea0");
  });

  it("redacts Tailscale MagicDNS names without config", () => {
    expect(sanitize("ssh box-1.tail0000.ts.net now", "public")).toBe("ssh <REDACTED:hostname> now");
  });
});

describe("sanitize", () => {
  it("redacts API keys (anthropic, openai, aws) under 'internal' profile", () => {
    const text =
      "key1=sk-ant-1234567890abcdefghijklm key2=sk-1234567890abcdefghijklm aws=AKIAABCDEFGHIJKLMNOP";
    const out = sanitize(text, "internal");
    expect(out).toContain("<REDACTED:anthropic_key>");
    expect(out).toContain("<REDACTED:openai_key>");
    expect(out).toContain("<REDACTED:aws_key>");
  });

  it("keeps emails/IPs under 'internal' profile (debug-friendly)", () => {
    const out = sanitize("email=person@example.com ip=192.168.1.10", "internal");
    expect(out).toContain("person@example.com");
    expect(out).toContain("192.168.1.10");
  });

  it("redacts emails, IPs, hostnames, paths under 'public' profile", () => {
    const text = [
      "email=person@example.com",
      "tailscale=100.64.0.163",
      "ipv4=192.168.1.10",
      "host=example-tailnet-host-c77ea0",
      "path=/home/example-user/.openclaw/workspace/state",
      "phone=+15559553227",
    ].join(" ");
    const out = sanitize(text, "public");
    expect(out).not.toContain("person@example.com");
    expect(out).not.toContain("100.64.0.163");
    expect(out).not.toContain("192.168.1.10");
    expect(out).not.toContain("example-tailnet-host-c77ea0");
    expect(out).not.toContain("/home/example-user/");
    expect(out).not.toContain("+15559553227");
  });

  it("is idempotent (sanitize(sanitize(x)) == sanitize(x))", () => {
    const text = "email=a@b.com host=example-tailnet-host-c77ea0";
    const once = sanitize(text, "public");
    const twice = sanitize(once, "public");
    expect(twice).toBe(once);
  });

  it("'none' profile passes through unchanged", () => {
    const text = "any sensitive example-tailnet-host-c77ea0 192.168.1.1 a@b.com";
    expect(sanitize(text, "none")).toBe(text);
  });
});

describe("sanitizeObject", () => {
  it("walks dicts/lists recursively", () => {
    const obj = {
      hostname: "example-tailnet-host-c77ea0",
      list: ["1@b.com", { nested: "/home/example-user/x" }],
      keep: 42,
    };
    const out = sanitizeObject(obj, "public");
    expect(out.hostname).toBe("<REDACTED:hostname>");
    expect(out.list[0]).toBe("<REDACTED:email>");
    expect((out.list[1] as { nested: string }).nested).toBe("<REDACTED:path>");
    expect(out.keep).toBe(42);
  });
});

describe("audit", () => {
  it("returns findings for sensitive content in default mode", () => {
    const findings = audit("contact a@b.com on 100.64.0.163");
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.some((f) => f.rule === "email")).toBe(true);
    expect(findings.some((f) => f.rule === "tailscale_ip")).toBe(true);
  });

  it("respects allow lists for fictional fixture domains", () => {
    const findings = audit("send to flameprincess@firekingdom.land", {
      allowEmailDomains: ["firekingdom.land"],
    });
    expect(findings.some((f) => f.rule === "email")).toBe(false);
  });

  it("respects allowLoopbackIps for 127.0.0.1", () => {
    const findings = audit("server runs on 127.0.0.1:3456", { allowLoopbackIps: true });
    expect(findings.some((f) => f.rule === "ipv4")).toBe(false);
  });
});

describe("ruleNames", () => {
  it("public > internal in coverage", () => {
    const internalNames = new Set(ruleNames("internal"));
    const publicNames = new Set(ruleNames("public"));
    for (const n of internalNames) {
      expect(publicNames.has(n)).toBe(true);
    }
    expect(publicNames.size).toBeGreaterThan(internalNames.size);
  });

  it("'none' yields no rules", () => {
    expect(ruleNames("none")).toEqual([]);
  });
});

describe("vendored agent-fixtures.json privacy audit", () => {
  // The vendored agent pack ships in-tree and gets shipped with gemmaclaw.
  // It MUST NOT contain real personal data, infra hostnames, secrets, or
  // identifiable identifiers. The Adventure Time fixtures are fictional
  // (firekingdom.land, etc.); only loopback IPs are accepted.
  const FICTIONAL_DOMAINS = [
    "nightosphere.land",
    "firekingdom.land",
    "icekingdom.land",
    "adventuretime.land",
    "candykingdom",
    "candykingdom.land",
  ];

  it("vendored agent-fixtures.json has zero leak findings", () => {
    const pack = loadAgentFixtureTasks();
    const findings = auditPack(pack, {
      allowEmailDomains: FICTIONAL_DOMAINS,
      allowLoopbackIps: true,
    });
    if (findings.length > 0) {
      // Render a helpful failure message listing the offending matches so
      // bumps to the vendored pack are easy to triage.
      const summary = findings
        .slice(0, 10)
        .map((f) => `  ${f.rule}: ${f.match}`)
        .join("\n");
      throw new Error(
        `vendored agent-fixtures.json has ${findings.length} leak findings:\n${summary}`,
      );
    }
    expect(findings.length).toBe(0);
  });

  it("declares family='agent' and is non-empty", () => {
    const pack = loadAgentFixtureTasks();
    expect(pack.family).toBe("agent");
    expect(pack.tasks.length).toBeGreaterThanOrEqual(20);
  });
});

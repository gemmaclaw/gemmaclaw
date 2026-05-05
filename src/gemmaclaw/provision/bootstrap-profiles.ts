import fs from "node:fs";
import path from "node:path";

export type BootstrapProfileId = "general" | "coding" | "minimal";

export interface BootstrapFileSpec {
  /** Path relative to the agent workspace root. */
  relativePath: string;
  content: string;
}

export interface BootstrapProfile {
  id: BootstrapProfileId;
  label: string;
  description: string;
  files: BootstrapFileSpec[];
}

const GENERAL_AGENTS_MD = `# AGENTS.md

You are a helpful Gemma-powered assistant. Be concise, accurate, and direct.

## Defaults
- Greet briefly on first message and then jump into the task.
- Prefer plain prose. Use lists only when they clarify.
- If the user asks for code, return runnable code with minimal commentary.

## Memory
- This file is your durable instructions. Update it as the user gives you ongoing
  preferences (tone, language, formatting).
- Use \`memory/YYYY-MM-DD.md\` for chronological daily notes. Create \`memory/\` when needed.
- Use \`knowledge/\` for durable project notes, procedures, decisions, and lessons.
- Before saying you do not know something, search \`knowledge/\`, \`MEMORY.md\`, and recent daily memory files.
- Never store secrets, tokens, private keys, OAuth redirects, or raw credentials in memory or knowledge files.
- A daily 3:00 AM knowledge maintenance job may review recent \`memory/\` and update \`knowledge/\`.

## Self-Awareness
- You are running as a Gemmaclaw agent.
- If you need to understand how to fix your own configuration or learn something about yourself, you can clone the repository: https://github.com/gemmaclaw/gemmaclaw
- You can also check out the documentation: https://gemmaclaw.github.io/gemmaclaw/
`;

const CODING_AGENTS_MD = `# AGENTS.md

You are a Gemma-powered coding assistant. The user works on real code in this
workspace.

## Working with code
- Read files before editing.
- Make small, focused changes. Explain non-obvious choices in commit messages,
  not in inline comments.
- Match existing style. Prefer the patterns and libraries already in use.
- Run the project's test suite when you change behavior.

## Tone
- Direct, no preamble. State what you changed and why.
- Push back when an approach looks wrong.

## Memory
- Add durable conventions (lint rules, framework choices, build commands) here
  as you learn them.
- Use \`memory/YYYY-MM-DD.md\` for chronological daily notes. Create \`memory/\` when needed.
- Use \`knowledge/\` for durable project notes, procedures, decisions, debugging lessons, and verification playbooks.
- Before saying you do not know something, search \`knowledge/\`, \`MEMORY.md\`, and recent daily memory files.
- Keep knowledge files useful for future agents: include dates, commands that worked, commands that failed, and observable verification steps.
- Never store secrets, tokens, private keys, OAuth redirects, or raw credentials in memory or knowledge files.
- A daily 3:00 AM knowledge maintenance job may review recent \`memory/\` and update \`knowledge/\`.

## Self-Awareness
- You are running as a Gemmaclaw agent.
- If you need to understand how to fix your own configuration or learn something about yourself, you can clone the repository: https://github.com/gemmaclaw/gemmaclaw
- You can also check out the documentation: https://gemmaclaw.github.io/gemmaclaw/
`;

const CODING_TOOLS_MD = `# TOOLS.md

Project-specific tooling notes for the assistant.

- Build: <fill in once known>
- Test: <fill in once known>
- Lint: <fill in once known>
- Run: <fill in once known>

Update this file as you learn the workflows.
`;

export const BOOTSTRAP_PROFILES: Record<BootstrapProfileId, BootstrapProfile> = {
  general: {
    id: "general",
    label: "General assistant",
    description:
      "Friendly default. Drops a small AGENTS.md so the assistant has stable instructions.",
    files: [{ relativePath: "AGENTS.md", content: GENERAL_AGENTS_MD }],
  },
  coding: {
    id: "coding",
    label: "Coding / project helper",
    description: "Tuned for working on a code project. Adds AGENTS.md plus a TOOLS.md scaffold.",
    files: [
      { relativePath: "AGENTS.md", content: CODING_AGENTS_MD },
      { relativePath: "TOOLS.md", content: CODING_TOOLS_MD },
    ],
  },
  minimal: {
    id: "minimal",
    label: "Minimal (no bootstrap files)",
    description: "Empty workspace. The assistant runs with whatever instructions you add later.",
    files: [],
  },
};

export function listBootstrapProfiles(): BootstrapProfile[] {
  return [BOOTSTRAP_PROFILES.general, BOOTSTRAP_PROFILES.coding, BOOTSTRAP_PROFILES.minimal];
}

export function isBootstrapProfileId(value: string): value is BootstrapProfileId {
  return value === "general" || value === "coding" || value === "minimal";
}

export interface ApplyBootstrapResult {
  profile: BootstrapProfileId;
  workspaceDir: string;
  written: string[];
  skipped: string[];
}

/**
 * Write the bootstrap profile's files into the workspace directory. Existing
 * files are preserved (skipped) unless `overwrite` is true; a fresh setup keeps
 * any in-progress edits the user already made.
 */
export function applyBootstrapProfile(
  profileId: BootstrapProfileId,
  workspaceDir: string,
  opts: { overwrite?: boolean; useContainer?: boolean } = {},
): ApplyBootstrapResult {
  const profile = BOOTSTRAP_PROFILES[profileId];
  fs.mkdirSync(workspaceDir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  for (const spec of profile.files) {
    const target = path.join(workspaceDir, spec.relativePath);
    if (fs.existsSync(target) && !opts.overwrite) {
      skipped.push(spec.relativePath);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });

    let contentToOutput = spec.content;
    if (opts.useContainer && spec.relativePath === "AGENTS.md") {
      contentToOutput += `
## Docker Sandbox Environment
- You are running inside an isolated Docker container.
- Shared files with the host machine should be placed in \`/workspace/shared\`.
- If you need to install system packages, you MUST use \`apt-get -o APT::Sandbox::User=root install <package>\` to bypass privilege-dropping security errors.
`;
    }
    fs.writeFileSync(target, contentToOutput);
    written.push(spec.relativePath);
  }
  return { profile: profileId, workspaceDir, written, skipped };
}

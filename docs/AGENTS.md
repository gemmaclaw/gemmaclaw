# Docs Guide

This directory owns docs authoring, Mintlify link rules, and docs i18n policy.

## Gemmaclaw Docs Rules

- Gemmaclaw docs work is scoped to this repository and the Gemmaclaw site (`https://gemmaclaw.github.io/gemmaclaw/`).
- Do not publish Gemmaclaw docs changes to `openclaw/docs` or use `openclaw/docs` as a completion gate.
- Internal doc links in `docs/**/*.md` must stay root-relative with no `.md` or `.mdx` suffix (example: `[Config](/gateway/configuration)`).
- Section cross-references should use anchors on root-relative paths (example: `[Hooks](/gateway/configuration-reference#hooks)`).
- Doc headings should avoid em dashes and apostrophes because generated anchors are brittle there.
- README and other GitHub-rendered docs should keep absolute Gemmaclaw URLs so links work outside the site.
- Docs content must stay generic: no personal device names, hostnames, or local paths; use placeholders like `user@gateway-host`.

## Docs Content Rules

- For docs, UI copy, and picker lists, order services/providers alphabetically unless the section is explicitly describing runtime order or auto-detection order.
- Keep bundled plugin naming consistent with the repo-wide plugin terminology rules in the root `AGENTS.md`.

## Docs i18n

- Foreign-language docs are not maintained in this repo unless Gemmaclaw adds a Gemmaclaw-owned localization pipeline.
- Do not add or edit localized docs under `docs/<locale>/**` here.
- Treat English docs in this repo plus glossary files as the source of truth.
- Pipeline: update English docs here, update `docs/.i18n/glossary.<locale>.json` as needed, and verify the committed Gemmaclaw docs or Gemmaclaw site output. Do not trigger `openclaw/docs`.
- Before rerunning `scripts/docs-i18n`, add glossary entries for any new technical terms, page titles, or short nav labels that must stay in English or use a fixed translation.
- `pnpm docs:check-i18n-glossary` is the guard for changed English doc titles and short internal doc labels.
- Translation memory, if used, must live in a Gemmaclaw-owned location.
- See `docs/.i18n/README.md`.

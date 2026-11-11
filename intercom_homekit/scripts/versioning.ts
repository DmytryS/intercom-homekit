/**
 * `npm version patch|minor|major` hooks (run through scripts/version-hook.ts) (see package.json and .npmrc): one command bumps every
 * place that holds the version and commits it. Pushing that commit to main publishes the release.
 *
 *   preversion  → check: CHANGELOG.md has a non-empty "## Unreleased" section (before anything changes)
 *   version     → apply: config.yaml gets the new version, "## Unreleased" becomes "## <version>"
 *   postversion → commit: "Release <version>" with exactly those files (no tag: CI tags the release)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const file = (name: string) => new URL(name, root);
const UNRELEASED = /^## Unreleased[ \t]*$/m;
const FILES = ['package.json', 'package-lock.json', 'config.yaml', 'CHANGELOG.md'];

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Text of the "## Unreleased" section, or undefined without one. */
export function unreleasedNotes(changelog: string): string | undefined {
  const m = UNRELEASED.exec(changelog);
  if (!m) return undefined;
  const rest = changelog.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function releaseChangelog(changelog: string, version: string): string {
  return changelog.replace(UNRELEASED, `## ${version}`);
}

export function setAddonVersion(configYaml: string, version: string): string {
  const re = /^version: ".*"$/m;
  if (!re.test(configYaml)) throw new Error('config.yaml has no `version: "…"` line');
  return configYaml.replace(re, `version: "${version}"`);
}

export function check(): void {
  const notes = unreleasedNotes(readFileSync(file('CHANGELOG.md'), 'utf8'));
  if (notes === undefined) fail('CHANGELOG.md needs a "## Unreleased" section with the changes, at the top. Nothing was changed.');
  if (!notes) fail('The "## Unreleased" section in CHANGELOG.md is empty: describe the changes first. Nothing was changed.');
}

export function apply(): void {
  const { version } = JSON.parse(readFileSync(file('package.json'), 'utf8')) as { version: string };
  writeFileSync(file('config.yaml'), setAddonVersion(readFileSync(file('config.yaml'), 'utf8'), version));
  writeFileSync(file('CHANGELOG.md'), releaseChangelog(readFileSync(file('CHANGELOG.md'), 'utf8'), version));
}

export function commit(): void {
  const { version } = JSON.parse(readFileSync(file('package.json'), 'utf8')) as { version: string };
  const cwd = fileURLToPath(root);
  execFileSync('git', ['commit', '--quiet', '-m', `Release ${version}`, '--', ...FILES], { cwd, stdio: 'inherit' });
  console.log(`\n✓ Committed "Release ${version}". Push it to main (or merge it there): CI publishes the image and creates the v${version} release.\n`);
}

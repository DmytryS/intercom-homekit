import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { releaseChangelog, setAddonVersion, unreleasedNotes } from '../scripts/versioning.ts';

describe('npm version hooks', () => {
  const changelog = '# Changelog\n\n## Unreleased\n\n- Fixed a thing.\n\n## 0.7.0\n\n- Old.\n';

  it('finds the notes of the Unreleased section, and none when it is missing or empty', () => {
    assert.equal(unreleasedNotes(changelog), '- Fixed a thing.');
    assert.equal(unreleasedNotes('# Changelog\n\n## Unreleased\n\n## 0.7.0\n\n- Old.\n'), '');
    assert.equal(unreleasedNotes('# Changelog\n\n## 0.7.0\n'), undefined);
  });

  it('turns Unreleased into the version and updates config.yaml', () => {
    assert.equal(releaseChangelog(changelog, '0.8.0'), changelog.replace('## Unreleased', '## 0.8.0'));
    const config = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8');
    const updated = setAddonVersion(config, '9.9.9');
    assert.match(updated, /^version: "9\.9\.9"$/m);
    assert.equal(updated.split('\n').filter((l, i) => l !== config.split('\n')[i]).length, 1, 'only the version line changes');
    assert.throws(() => setAddonVersion('name: x\n', '1.0.0'), /no `version/);
  });

  it('is wired into npm version, which does not tag (CI does)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.preversion, 'node scripts/version-hook.ts check');
    assert.equal(pkg.scripts.version, 'node scripts/version-hook.ts apply');
    assert.equal(pkg.scripts.postversion, 'node scripts/version-hook.ts commit');
    assert.match(readFileSync(new URL('../.npmrc', import.meta.url), 'utf8'), /^git-tag-version=false$/m);
  });
});

// -----------------------------------------------------------------------------
// Release helpers, run by the Release and GitHub releases workflows.
//
//   node .github/scripts/release.mjs prepare <version> <docker-image> <repo-url>
//     Points the manifest at the new release (`version` + `docker_image`, and
//     the sub-containers running the integration's own image) and moves the
//     `## [Unreleased]` section of CHANGELOG.md under `## [<version>] - <today>`.
//
//   node .github/scripts/release.mjs notes <version> < CHANGELOG.md
//     Prints the changelog section of <version> (nothing when there is none):
//     the notes of its GitHub Release.
//
// Both files are edited in place instead of being re-printed (jq,
// JSON.stringify...), so the release commit keeps the Prettier layout and
// `npm run format:check` stays green. test/release.test.js checks it against
// the real files of the repository.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MANIFEST_FILE = 'gladys-assistant-integration.json';
const CHANGELOG_FILE = 'CHANGELOG.md';
const UNRELEASED_HEADING = '## [Unreleased]';

/**
 * Name of a Docker image reference, without its tag or digest:
 * `ghcr.io/me/repo:1.2.0` -> `ghcr.io/me/repo`. The tag is what follows the
 * last colon after the last slash (a registry port, `host:5000/repo`, is not).
 * @param {string} ref - Image reference.
 * @returns {string} The image name.
 */
function imageName(ref) {
  const name = ref.split('@')[0];
  const tag = name.indexOf(':', name.lastIndexOf('/') + 1);
  return tag === -1 ? name : name.slice(0, tag);
}

/**
 * Set the top-level `version` and `docker_image` of a manifest, leaving every
 * other byte of the file untouched. A sub-container (`containers` field) that
 * runs the integration's own image follows it to the new tag: its previous tag
 * may not even exist on the registry. Any other sub-container (a broker, a
 * database...) pins a third-party image the release does not publish, and
 * keeps it.
 * @param {string} text - Manifest content (Prettier-formatted JSON).
 * @param {string} version - Released version, e.g. 1.2.0.
 * @param {string} dockerImage - Image of that version, e.g. ghcr.io/me/repo:1.2.0.
 * @returns {string} The new manifest content.
 */
export function bumpManifest(text, version, dockerImage) {
  const manifest = JSON.parse(text);
  const updates = { version, docker_image: dockerImage };
  // In formatted JSON the first indented line is the first top-level key: its
  // indentation tells top-level keys from nested ones (a sub-container of the
  // `containers` field declares its own `docker_image`).
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0];
  let result = text;
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^(${indent}"${key}":\\s*)"[^"]*"`, 'm');
    if (indent === undefined || !pattern.test(result)) {
      throw new Error(`${MANIFEST_FILE}: no top-level "${key}" string to update`);
    }
    result = result.replace(pattern, (_match, prefix) => prefix + JSON.stringify(value));
  }

  // The integration's own image: the one the manifest pointed at, or the new
  // one (the repository was renamed, or created from the template).
  const ownImages = new Set([imageName(manifest.docker_image), imageName(dockerImage)]);
  const followsRelease = (container) =>
    typeof container?.docker_image === 'string' && ownImages.has(imageName(container.docker_image));
  // Only the top-level and sub-container objects hold a `docker_image` key (the
  // top-level one already points at the release: rewriting it is a no-op).
  result = result.replace(/("docker_image":\s*)"([^"]*)"/g, (match, prefix, image) =>
    ownImages.has(imageName(image)) ? prefix + JSON.stringify(dockerImage) : match,
  );

  // Those values changed, and nothing else did.
  const expected = { ...manifest, ...updates };
  if (Array.isArray(manifest.containers)) {
    expected.containers = manifest.containers.map((container) =>
      followsRelease(container) ? { ...container, docker_image: dockerImage } : container,
    );
  }
  assert.deepEqual(JSON.parse(result), expected);
  return result;
}

/**
 * Heading line of a version section: `## [1.2.0] - 2026-01-02` (or `## 1.2.0`).
 * @param {string} version - Version, e.g. 1.2.0.
 * @returns {RegExp} Multiline pattern matching the whole heading line.
 */
function versionHeading(version) {
  return new RegExp(`^## \\[?${version.replaceAll('.', '\\.')}\\]?(?: |$).*$`, 'm');
}

/**
 * Index where a changelog section starting at `from` ends: the next `## `
 * heading, else the link reference definitions closing the file, else its end.
 * @param {string} text - Changelog content.
 * @param {number} from - Index just after the section heading.
 * @returns {number} End index of the section body.
 */
function sectionEnd(text, from) {
  const rest = text.slice(from);
  const nextHeading = rest.search(/^## /m);
  if (nextHeading !== -1) {
    return from + nextHeading;
  }
  const links = rest.search(/^\[[^\]]+\]: /m);
  return links === -1 ? text.length : from + links;
}

/**
 * Move the Unreleased section of a Keep a Changelog document under the
 * released version, and point the comparison links at the new tag.
 * @param {string} text - Current CHANGELOG.md content.
 * @param {string} version - Released version, e.g. 1.2.0.
 * @param {string} date - Release date, YYYY-MM-DD.
 * @param {string} repoUrl - Repository URL, e.g. https://github.com/me/repo.
 * @returns {string} The new content (unchanged without an Unreleased section).
 */
export function rollChangelog(text, version, date, repoUrl) {
  // A heading line, not a mention of it in the text.
  const heading = /^## \[Unreleased\][ \t]*$/m.exec(text);
  if (!heading || versionHeading(version).test(text)) {
    return text;
  }
  const start = heading.index;
  const bodyStart = start + heading[0].length;
  const bodyEnd = sectionEnd(text, bodyStart);
  const body = text.slice(bodyStart, bodyEnd).trim();
  const rest = text.slice(bodyEnd).trimStart();

  const released = `## [${version}] - ${date}\n\n${body ? `${body}\n\n` : ''}`;
  let result = `${text.slice(0, start)}${UNRELEASED_HEADING}\n\n${released}${rest}`;

  // Links: `[Unreleased]` now compares from the new tag, and the new version
  // compares the previous tag with it (or links to its tag for a first release).
  // The URL comes from the workflow, so a repository created from the template
  // gets its own links at its first release.
  const previous = /^## \[(\d+\.\d+\.\d+)\]/m.exec(rest)?.[1];
  const links =
    `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD\n` +
    (previous
      ? `[${version}]: ${repoUrl}/compare/v${previous}...v${version}`
      : `[${version}]: ${repoUrl}/releases/tag/v${version}`);
  const unreleasedLink = /^\[Unreleased\]: .*$/m;
  result = unreleasedLink.test(result)
    ? result.replace(unreleasedLink, () => links)
    : `${result.trimEnd()}\n\n${links}`;
  return `${result.trimEnd()}\n`;
}

/**
 * Body of the changelog section of a version: the notes of its GitHub Release.
 * @param {string} text - CHANGELOG.md content.
 * @param {string} version - Version, e.g. 1.2.0.
 * @returns {string} The section body, empty when the version has none.
 */
export function releaseNotes(text, version) {
  const match = versionHeading(version).exec(text);
  if (!match) {
    return '';
  }
  const bodyStart = match.index + match[0].length;
  return text.slice(bodyStart, sectionEnd(text, bodyStart)).trim();
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const [command, version, ...args] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('Usage: release.mjs prepare <x.y.z> <docker-image> <repo-url>');
    console.error('       release.mjs notes <x.y.z> < CHANGELOG.md');
    process.exit(1);
  }

  if (command === 'prepare') {
    const [dockerImage, repoUrl] = args;
    writeFileSync(
      MANIFEST_FILE,
      bumpManifest(readFileSync(MANIFEST_FILE, 'utf8'), version, dockerImage),
    );

    if (existsSync(CHANGELOG_FILE)) {
      const changelog = readFileSync(CHANGELOG_FILE, 'utf8');
      const date = new Date().toISOString().slice(0, 10);
      const rolled = rollChangelog(changelog, version, date, repoUrl);
      if (rolled === changelog) {
        console.log(
          `::warning::${CHANGELOG_FILE} left as is: no "${UNRELEASED_HEADING}" section,` +
            ` or ${version} is already listed`,
        );
      }
      writeFileSync(CHANGELOG_FILE, rolled);
    }
  } else if (command === 'notes') {
    process.stdout.write(releaseNotes(readFileSync(0, 'utf8'), version));
  } else {
    console.error(`Unknown command "${command}"`);
    process.exit(1);
  }
}

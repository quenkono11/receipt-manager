'use strict';
// Update notice: asks GitHub for the latest release and compares version numbers.
// Nothing is downloaded or installed, and no receipt data is sent (a plain GET request).
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// "v1.2.0" or "1.2.0" -> [1, 2, 0]; anything else (for example "1.2.0-beta") -> null.
function parseVersion(s) {
  const m = VERSION_RE.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True only when `remote` is a higher version than `local`, so an older release is never announced.
function isNewer(remote, local) {
  const a = parseVersion(remote); const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Reads the GitHub repository ("owner/repo") from the "repository" field of package.json.
// Accepted: "github:owner/repo", "owner/repo", "https://github.com/owner/repo(.git)", or { url: ... }.
function repoFromPackage(pkg) {
  let r = pkg && pkg.repository;
  if (r && typeof r === 'object') r = r.url;
  if (typeof r !== 'string') return null;
  r = r.trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:github:|https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/)?([^/\s]+\/[^/\s]+)$/.exec(r);
  return m && REPO_RE.test(m[1]) ? m[1] : null;
}

// Resolves to { version, url } when a newer published release exists, otherwise null.
// Every failure (offline, rate limit, bad answer) also resolves to null: the notice just does not appear.
async function checkForUpdate({ repo, current, fetchFn = globalThis.fetch, timeoutMs = 8000 }) {
  if (!repo || !REPO_RE.test(repo) || typeof fetchFn !== 'function') return null;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'receipt-manager' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const rel = await res.json();
    if (!rel || rel.draft || rel.prerelease || !isNewer(rel.tag_name, current)) return null;
    const url = typeof rel.html_url === 'string' && rel.html_url.startsWith('https://github.com/')
      ? rel.html_url : `https://github.com/${repo}/releases/latest`;
    return { version: parseVersion(rel.tag_name).join('.'), url };
  } catch { return null; }
}

module.exports = { parseVersion, isNewer, repoFromPackage, checkForUpdate };

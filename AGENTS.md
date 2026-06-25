# Agent Instructions

## Releases

- Follow SemVer for all package releases.
- Use `MAJOR.MINOR.PATCH` for stable releases.
- Use SemVer prerelease identifiers for beta releases, for example `0.1.0-beta.0`, `0.1.0-beta.1`, then `0.1.0` for the stable release.
- Treat breaking changes as major version bumps, new backwards-compatible features as minor bumps, and backwards-compatible bug fixes as patch bumps.
- Use Conventional Commit prefixes so release-please can infer release notes and version bumps:
  - `fix:` for patch changes.
  - `feat:` for minor changes.
  - `feat!:` or a `BREAKING CHANGE:` footer for major changes.
- Do not manually bump `package.json` for routine releases unless the task is explicitly setting up or correcting release metadata. Let release-please update versions through its release PRs.
- Keep npm dist-tags aligned with release stability: beta prereleases use `beta`, stable releases use `latest`.

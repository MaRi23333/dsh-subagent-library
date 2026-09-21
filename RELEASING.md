# Releasing

Releases are published to npm automatically by `.github/workflows/publish.yml` when a
GitHub Release is **published** (OIDC Trusted Publishing, no npm token involved).

## 1. Pre-release checks

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run smoke
pnpm run check:pack
```

## 2. Version and tag

- Bump `package.json` `"version"` first and commit it.
- Create an **annotated** tag whose name is exactly `v${version}`:

  ```sh
  git tag -a vX.Y.Z -m "vX.Y.Z"
  git push origin main
  git push origin vX.Y.Z
  ```

- Do **not** use a lightweight tag (`git tag vX.Y.Z`) — the workflow rejects it.
- The tag must point at the commit the release is built from, and the tag name must
  equal `v${package.json version}`; the workflow verifies both.

## 3. Create the GitHub Release

Create the Release from the pushed annotated tag — after the CI workflow on the pushed commit has gone green. On `published`, the workflow runs:
frozen install → typecheck → tests → build → committed-lib consistency → smoke →
package whitelist → npm publish via OIDC (with SLSA provenance).

## 4. Do not publish manually

Do not run `npm publish` yourself for a normal release — it races the workflow or
fails with "version already exists". After the run goes green, verify on the
registry (`npm view dsh-subagent-library version dist-tags.latest`).

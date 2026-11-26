# Vendored canonical SDK

The CLI consumes the WorkflowEngine's published client instead of maintaining
its own. This artifact is byte-for-byte the file published by the engine; it is
installed as a `file:` dependency by `package.json`.

## Source

- Repository: `Auctivon-CoderaxAI/Coderax-WorkflowEngine`
- Consolidation target: pull request #7 (`9b4cb5ce4f8688cf232d006028e5e255eda6cb1f`)
- Path: `packages/sdk/artifacts/coderax-sdk-1.1.0.tgz`
- Artifact manifest: `packages/sdk/sdk-artifact.json`
- Hosted CI at that commit: `verify` — success
  (`https://github.com/Auctivon-CoderaxAI/Coderax-WorkflowEngine/actions/runs/45883087284`)

## File

```text
520a0cf89532a71dec40b571615d7a08ac6d7f1f4427732f1b95854d4bc573db  coderax-sdk-1.1.0.tgz
```

`520a0cf8…` is the `sha256` in the engine's own `sdk-artifact.json`, whose
`bytes` field is `32581`. `sha256sum vendor/coderax-sdk-1.1.0.tgz` must match.

The tarball bundles the matching `@coderax/contracts` schemas under its own
`node_modules`, so the CLI declares no separate contracts dependency. `zod` is
the only external runtime dependency.

## Two artifacts both call themselves 1.1.0

`contract/authoritative-v1.1` (`ea66028`) publishes a different tarball with the
same name and version: `c2599576231c85c3f6e68a31933ab2833627582e3f7d5f791fc46becacc79b33`.
It exports `negotiate()`, `parseSse()` and `SDK_COVERAGE`. The PR #7 artifact
exports `handshake({contract})`, `compatibility()`, `SDK_OPERATION_COVERAGE` and
task-scoped artifact methods. The bytes are not interchangeable, so matching
version numbers do **not** establish compatibility.

The two branches are competing implementations that their owners must
reconcile. This CLI targets the designated consolidation target (PR #7) and
negotiates against whatever contract a deployment actually serves at runtime;
it does not claim the surfaces are the same.

## Verify

```sh
npm run verify:vendor
```

## Updating

1. Fetch the new artifact from the engine's `sdk-artifact.json` path.
2. Replace the tarball and `SHA256SUMS`.
3. Update this file with the commit and sums.
4. Run `npm ci` to refresh the lockfile, then `npm test`.
5. A contract version change requires the compatibility check in
   `src/capability-registry.js` and the status expectations in
   `test/capabilities.test.js` to be reviewed, not merely accepted.

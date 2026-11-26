# Vendored canonical SDK

The CLI consumes the WorkflowEngine's published client instead of maintaining
its own. These artifacts are byte-for-byte the files the engine published; they
are installed as `file:` dependencies by `package.json`.

## Source

- Repository: `Auctivon-CoderaxAI/Coderax-WorkflowEngine`
- Branch: `contract/authoritative-v1.1`
- Commit: `ea66028` (`feat(contracts): publish authoritative v1.1 API and shared SDK`)
- Path: `dist-artifacts/`

## Files

```text
f4c9048702a78ac23e12c1c5bcbe63eca235144270660ec59177abdd167d8651  coderax-contracts-1.1.0.tgz
c2599576231c85c3f6e68a31933ab2833627582e3f7d5f791fc46becacc79b33  coderax-sdk-1.1.0.tgz
```

These are the exact lines from the published `SHA256SUMS` and match the
`sha256`/`bytes` fields in the published `manifest.json`
(`engineVersion 0.2.0`, `contractVersion 1.1.0`, `sdkVersion 1.1.0`).

## Verify

```sh
cd vendor && sha256sum -c SHA256SUMS
```

## Dependencies

`@coderax/contracts` and `@coderax/sdk` both require `zod ^3.25.67`, which is
installed from npm and pinned by `package-lock.json`. No other runtime
dependency is introduced.

## Updating

1. Fetch the new `dist-artifacts` from the engine branch or release.
2. Replace both tarballs and `SHA256SUMS`.
3. Update this file with the commit and sums.
4. Run `npm install` to refresh the lockfile, then `npm test`.
5. A contract version change requires the compatibility check in
   `src/capability-registry.js` and the status expectations in
   `test/capabilities.test.js` to be reviewed, not merely accepted.

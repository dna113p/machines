# Releasing

The [publishing workflow](../.github/workflows/publish.yml) runs on a standard
GitHub runner and uses npm trusted publishing, so no npm token is stored in
GitHub.

**A release is a change to the version in `package.json`.** When `main`
receives a stable version that npm doesn't have yet, the workflow runs the
[checks](../README.md#checks), publishes to npm if they pass, and tags the
commit `vX.Y.Z`. Every other push to `main` publishes nothing.

To release the next minor version, bump it on a branch and merge that branch:

```bash
npm version minor --no-git-tag-version
git commit -am "Release X.Y.0"
```

Other routes:

- Pushing a `vX.Y.Z` tag yourself still publishes that version if npm lacks
  it. The tag must match the stable version in `package.json`.
- Running **Publish to npm** manually in GitHub Actions runs the checks and a
  publishing dry run. It does not publish a package.

# Releasing

The initial project is source-only; workspace packages are not published to npm.

## Release checklist

1. Update the root and all workspace package versions to the same SemVer.
2. Move relevant `CHANGELOG.md` entries from `Unreleased` into the release version.
3. Run:

   ```bash
   bun install --frozen-lockfile
   bun run check
   bun audit
   ```

4. Open a pull request and require green CI.
5. Merge to `main`.
6. Record the exact merge SHA and create an annotated tag `vX.Y.Z` at that SHA.
7. Create a GitHub release from the tag with the changelog excerpt.
8. Rehearse `scripts/deploy_local.py install` against the exact tagged SHA.
9. Verify the installed `.installed.json`, `current` symlink, and rollback path.
10. Install the root-owned broker, helper, socket/template units, and service hardening with `scripts/install_root_assets.py` from the exact tagged checkout; verify its manifest, destination hashes, socket mode/owner, and Broker Protocol capability readback before restarting the Claude service.

Never retag or replace release artifacts.

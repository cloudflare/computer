# Release-branch comparison for cloudflare/computer #114

This comparison uses the package preview built from release commit `1233647`
(`@cloudflare/computer@0.3.0`) and the matching image reference expected by that
branch: `ghcr.io/cloudflare/computer-computerd-linux-x64:0.3.0`.

At the time of the repro run, neither image tag `0.3.0` nor the documented
release-candidate tag `next` existed in GHCR, so the release pair could not be
deployed end-to-end. The source/unit comparison still verifies that the branch
renamed and parameterized the callback endpoint (`/ws` -> `/api`) and that its
container transport suite passes.

# Release failure recovery

v0.1.0 must not be published until an AgentMail email-code end-to-end run succeeds against an explicitly authorized test origin, publishable key, and exact Frontend API URL, and until a real Smart CAPTCHA challenge path has been observed or explicitly accepted as a residual gate.

The release workflow is `workflow_dispatch` only. It refuses to publish unless `docs/E2E_ACCEPTANCE.md` contains the line `ACCEPTED`. That file is not in this branch.

If a publish is started and fails:

1. Do not retag the same commit over a partial GitHub Release. Delete the draft or failed release asset first.
2. Fix the package build, rebuild `dist/@aviorstudio_gd-clerk.zip`, and confirm its sha256 matches a fresh local build.
3. Publish a new release from the corrected tag. Do not force-push `main` to hide a bad asset.
4. If a bad ZIP was already downloaded, publish a follow-up release and tell consumers to discard the previous sha256. Do not rewrite history.

The workflow uses the default `GITHUB_TOKEN` with `contents: write` only. It does not use a secret key, npm token, or Clerk credential.

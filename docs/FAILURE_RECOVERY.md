# Release failure recovery

v0.1.0 must not be published until a live email-code run has been exercised. That proof is a successful `e2e` workflow artifact for the same commit and ZIP, not a file committed to the repository. `docs/E2E_ACCEPTANCE.md` is rejected if it is added. The evidence must record the tested ZIP sha256, the pinned clerk bundle sha256, an allowed origin, an https Frontend API origin, a delivered normal email-code sign-up and sign-in, a confirmed sign-out, a signed-out reload, an observed network failure, and an observed Godot web export. A presented Turnstile challenge is not acceptance and is not recorded as completed. None of those observations exist yet.

The release workflow is `workflow_dispatch` on `main` only. The verify job uses read tokens, runs the test suite, builds one ZIP, checks the closed 34-entry manifest, installs that ZIP, and refuses to continue without live evidence or a main-only release environment. The publish job does not grant `contents: write` to `GITHUB_TOKEN`. It uses the `release` environment token to tag that same commit and upload that same ZIP. It recomputes the checksum and checks the evidence again. Release notes are generated package provenance, not this recovery document.

The tag ruleset, when present, must be active on `refs/tags/v*` and restrict creation, update, and deletion. Its only bypass may be one dedicated publisher app that is not GitHub Actions and not a repository admin, organization owner, or repository role. That publisher id is not pinned, so the check fails closed. This does not protect `main`. A read-only remote check found `main` unprotected, with no rulesets, no environments, and the default Actions `GITHUB_TOKEN` permission set to write. There is no pull-request or required-CI rule on `main`. Tag rules do not close that gap, and this repository does not configure it.

If a publish is started and fails:

1. Do not retag the same commit over a partial GitHub Release. Delete the draft or failed release asset first.
2. Fix the package build, rebuild `dist/@aviorstudio_gd-clerk.zip`, and confirm its sha256 matches a fresh local build of the same commit.
3. Publish a new release from the corrected tag only after verify and publish both accept the same artifact. Do not force-push `main` to hide a bad asset.
4. If a bad ZIP was already downloaded, publish a follow-up release and tell consumers to discard the previous sha256. Do not rewrite history.

The workflow does not use a secret key, npm token, or Clerk credential. A missing publishable key, Frontend API, origin, or inbox blocks the live run before any evidence file is written.

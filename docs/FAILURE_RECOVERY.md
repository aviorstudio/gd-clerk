# Release failure recovery

v0.1.0 must not be published until a maintainer has manually accepted a redacted live email-code report for the exact candidate commit and ZIP. That report is not produced or fetched by this repository. A committed acceptance file is not evidence. `docs/E2E_ACCEPTANCE.md` must not be added.

`SIGNED_OUT` means the consumer revoke callback was validated and the current tab's active session became null. It is not an all-tab or all-device purge. A reload or another tab may still show a stale session. Publishing still requires a redacted external report for the exact candidate. This repository does not fetch or accept that report by itself.

The release workflow is `workflow_dispatch` on `main` only. Its test job uses a read token, runs the generic gates, builds one ZIP, and uploads that ZIP with its checksum. The publish job grants `contents: write` only to `GITHUB_TOKEN`, checks the main ref, downloads that same ZIP, and checks the checksum. It then fails closed. The failure is an explicit hold: this workflow does not verify external live evidence, and no file, input, or secret clears the hold. Removing the hold later is a code change. It is not automatic enforcement of another repository, and it is not proof a report was reviewed.

This repository does not configure a tag ruleset, a release environment, or a dedicated release token. Classic protection on `main` requires the GitHub Actions check `test` (app id 15368), with strict status checks, admin enforcement, no required reviews, and no force-push or branch deletion. The default Actions `GITHUB_TOKEN` permission is read. There is still no ruleset and no required pull request.

If a publish is started and fails:

1. Do not retag the same commit over a partial GitHub Release. Delete the draft or failed release asset first.
2. Fix the package build, rebuild `dist/@aviorstudio_gd-clerk.zip`, and confirm its sha256 matches a fresh local build of the same commit.
3. Do not force-push `main` to hide a bad asset. Do not remove the external evidence hold to skip a missing review.
4. If a bad ZIP was already downloaded, publish a follow-up release and tell consumers to discard the previous sha256. Do not rewrite history.

The workflow does not use a secret key, npm token, Clerk credential, inbox, or sender.

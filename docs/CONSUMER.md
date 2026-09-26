# Consumer contract

gd-clerk is a game-agnostic Godot 4.7 web addon. It does not know a consuming project's Clerk instance, origins, inbox, or sender.

## Configure in the consuming project

`configure(ClerkConfig, done)` requires:

- a `pk_test_` or `pk_live_` publishable key supplied by the consuming project
- the exact `https://` Frontend API origin encoded by that key
- an explicit allowed-origin list that includes the current page origin

Do not commit those values into this repository. Do not add them as Actions secrets here. Native and headless calls return `UNAVAILABLE`. This addon does not store session tokens, codes, emails, or secret keys.

The exported page loads only the bridge until `configure` succeeds. The vendored browser bundle is then inserted from the same origin with that validated public key. A key, Frontend API, or origin that fails the existing checks does not load the bundle.

## Candidate, not a release

The ZIP from a successful `ci` run is a candidate for isolated test integration only. It is not a released or production pin. Identify it by the full git commit and the ZIP sha256 in `dist/CANDIDATE.json` and `dist/@aviorstudio_gd-clerk.zip.sha256`. The closed manifest has 34 entries. Install by unzipping at the consuming project's root, then enable the `GdClerk` plugin or instance the script.

## Live email-code proof

This repository does not run live email-code signup or sign-in, does not call an inbox provider, and does not read another repository's Actions artifacts. A consuming project that wants live proof runs that proof itself, in isolation, against the exact candidate ZIP.

A redacted report may be sent to the maintainer who owns that proof. This repository does not fetch that report. A committed file, a workflow input, or a secret is not acceptance. Suggested report fields, with no tokens, codes, emails, keys, inboxes, or origins:

- `schema`: `gd-clerk.consumer-e2e.v1`
- `commit`: 40 hex characters of the candidate commit
- `package_sha256`: 64 hex characters of the candidate ZIP
- `clerk_browser_sha256`: 64 hex characters of `addons/@aviorstudio_gd-clerk/javascript/clerk/clerk.browser.js` inside that ZIP
- `email_code_sign_up`: `delivered`
- `email_code_sign_in`: `delivered`
- `sign_out`: `confirmed`
- `reload_signed_out`: `confirmed`
- `network_failure`: `observed`
- `godot_web_export`: `observed`
- `captcha_challenge`: `not_presented`
- `captcha_challenge_accepted`: `false`

A presented challenge is not acceptance. This repository's browser fixture mocks the Smart challenge and is not that proof. Whether captcha is off is read from the loaded Clerk instance, not from a separate dashboard request. Reload after changing bot protection before judging that value. A consumer-supplied slot must be an unhidden `<div id="clerk-captcha">`, with optional `data-cl-theme`, `data-cl-size`, or `data-cl-language` only.

Do not submit `sign_out: confirmed` for the current pin. `SIGNED_OUT` still means only that the SDK call resolved and the browser session is absent, which is not a remote delete. Wait until that proof is decided before retesting sign-out.

The release publish job fails closed until a later code change. That change is not automatic enforcement of another repository, and it is not proof a report was reviewed.

# gd-clerk

Godot 4.7 addon for web email-code sign-in and sign-up through the pinned official `@clerk/clerk-js@6.33.0` browser bundle. Plugin version `0.1.0`.

Install by copying `addons/@aviorstudio_gd-clerk/` into a Godot project, or unzip `dist/@aviorstudio_gd-clerk.zip` at the project root. The ZIP has 34 intentional entries: the 33 addon files in `scripts/package-allowlist.json`, including Godot `.uid` files and the pinned Clerk same-directory bundle, plus `PACKAGE_MANIFEST.json`. Enable the `GdClerk` plugin to add the optional `GdClerk` autoload and the web export injector. The script can also be instanced without the plugin.

## Platform

Web export only. Native and headless calls return `UNAVAILABLE` once and do not fall back to another provider, a password, or a stored credential. The browser SDK owns cookies and persistence. This addon does not store session tokens, codes, emails, secret keys, or a native credential store.

## API

`configure(ClerkConfig, done)` requires a `pk_test_` or `pk_live_` publishable key, the exact `https://` Frontend API origin encoded by that key, and an explicit allowed-origin list. The current page origin must be in that list. The consuming project supplies those values. This repository does not embed a game origin, publishable key, inbox, or sender.

`begin_email_code(email, mode, done)` takes `0` for `SIGN_IN` and `1` for `SIGN_UP`. Sign-in never creates an account. Sign-up uses the legacy `client.signUp` resource only after the Smart CAPTCHA slot is mounted. Future hook methods are not used.

`complete_email_code`, `resend_email_code`, and `cancel_email_code` continue or stop that one attempt. Resend waits 30 seconds, matching Clerk's documented prebuilt cooldown. Callbacks run once.

`get_session_token(min_validity_seconds, done)` returns an ephemeral token only when the unverified JWT `exp` claim is at least `min_validity_seconds` ahead. That claim is a scheduling hint. A Go server must verify the token and authorize the request. Concurrent refreshes share one `skipCache` fetch.

`sign_out(done)` returns `SIGNED_OUT` only after `clerk.signOut()` resolves and the browser session is absent. Otherwise it returns `SIGN_OUT_FAILED` or `UNAVAILABLE`, keeps protected token requests blocked, and can be retried. A failed sign-out sets a non-secret `sessionStorage` latch that survives reload.

`session_changed` emits `signed_in`, `status`, and `protected_actions_blocked` only. It never includes a token, code, or email.

Unexpected MFA, device trust, protect checks, session tasks, and missing sign-up fields fail closed with `NEEDS_MORE_STEPS` / `UNSUPPORTED_CHALLENGE`.

## SDK pin

Vanilla `clerk.client.signIn` and `clerk.client.signUp` are the documented legacy resources. `SignInFuture` and `SignUpFuture` exist on the pinned types only as `__internal_future`, which framework hooks use. This addon does not call those methods, `emailCode`, `verifications`, or `finalize`.

The browser files under `javascript/clerk/` are the exact `6.33.0` `clerk.browser.js` build and its same-directory chunks. They are not loaded from a floating CDN. `npm ci` plus `node scripts/vendor-clerk.mjs --check` verifies the lockfile integrity.

## Not released

There is no production release. This addon is game-agnostic. A consuming project may test the candidate ZIP in an isolated integration. That ZIP is not a released pin. Live email-code proof belongs to the consuming project. This repository does not run that proof, does not read another repository's evidence, and does not accept a committed acceptance file. The browser fixture mocks the Smart challenge and does not claim interactive challenge completion. See `docs/CONSUMER.md`, `docs/CAPTCHA.md`, `docs/CSP.md`, and `docs/FAILURE_RECOVERY.md`.

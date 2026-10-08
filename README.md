<!-- Generated from private documentation source. Do not edit directly. Source SHA256: 5f2ecc8d04a71c77b7c0719d18f4f1279876887982b1c12eb482374d8e84477d -->

# gd-clerk

Godot 4.7 addon for Clerk email-code sign-in and sign-up. Web exports use the pinned official `@clerk/clerk-js@6.38.1` browser bundle; native builds (desktop, headless, mobile exports) call the Clerk Frontend API directly over HTTPS. One `GdClerk` API serves both. Plugin version `0.2.0`.

The checked-in source uses this SDK; existing published releases retain their original packaged SDK.

Install with GDAM (`"@aviorstudio/gd-clerk": {"tag": "v0.2.0"}` in `gdam.json`), by copying `addons/@aviorstudio_gd-clerk/` into a Godot project, or by unzipping a release's `@aviorstudio_gd-clerk.zip` at the project root. The ZIP has 38 intentional entries: the 37 addon files in `scripts/package-allowlist.json`, including Godot `.uid` files and the pinned Clerk same-directory bundle, plus `PACKAGE_MANIFEST.json`. Enable the `GdClerk` plugin to add the optional `GdClerk` autoload and the web export injector. The script can also be instanced without the plugin; on native it must be inside the scene tree because requests run as child `HTTPRequest` nodes.

## Platforms

Web exports load the browser SDK, which owns cookies and persistence. Native builds send the same email-code flow to `https://<frontend api>` with `_is_native=true` and `Clerk-API-Version: 2026-05-12`; the instance's **Native API** must be enabled in the Clerk dashboard (Configure, Native applications), otherwise every call fails with `ERROR` / `CONFIG` and phase `native_api_disabled`. The native path does not run CAPTCHA. The publishable key is never sent over the network on either platform. Results, error keys and phases are the same on both platforms, so a consumer needs no platform branches beyond configuration.

## Configuration

`ClerkConfig` is a resource with public `publishable_key` (`pk_test_` or `pk_live_`), `frontend_api` (the exact `https://` origin encoded by that key) and `allowed_origins` (web only). Two runtime-only fields are never serialized: `revoke_session`, the consumer's remote revoke callback, and `credential_store`, a `ClerkCredentialStore`.

On native the Frontend API host must be `clerk.<domain>` or `<slug>.clerk.accounts.dev` and must match the publishable key. `allowed_origins` is ignored.

`ClerkCredentialStore` holds the Frontend API client token for this device under the key `client_token`. The default keeps it in process memory, so a session lasts until the game exits. To restore sessions across launches, subclass it and override `read_value(key) -> String` and `write_value(key, value) -> bool` with the OS keyring; the addon never writes that token to disk itself. The token is kept after sign-out so the next sign-in reuses the client, and it is cleared when the Frontend API rejects it.

## API

`configure(ClerkConfig, done)` validates the configuration. On web it loads the browser SDK. On native it returns `CONFIGURED` immediately with phase `native_signed_out` when no client token is stored; with a stored token it calls `GET /v1/client`, restores the last active session (`native_restored`, `session_changed` reports `signed_in`), or forgets a rejected token (`native_token_rejected`). A network failure during restore is `ERROR` / `NETWORK` and configure can be retried.

`begin_email_code(email, mode, done)` takes `0` for `SIGN_IN` and `1` for `SIGN_UP`. Sign-in never creates an account. On native, sign-in creates a sign-in attempt, picks the `email_code` first factor and prepares it; sign-up creates a sign-up attempt and prepares email verification. `CODE_SENT` means the code was requested. A sign-in that needs a second factor, device trust or another unsupported step is `NEEDS_MORE_STEPS` / `UNSUPPORTED_CHALLENGE` (phase `status_challenge` or `missing_factor`), as is a sign-up that still reports missing requirements after verification. A begin while a session is active is `ERROR` / `UNKNOWN` ("A session is already present.").

`complete_email_code`, `resend_email_code`, and `cancel_email_code` continue or stop that one attempt. Resend waits 30 seconds, matching Clerk's documented prebuilt cooldown. One email-code attempt exists at a time: a second `begin_email_code` while a code is pending or a request is in flight is `ERROR` / `UNKNOWN` ("An email code request is already in progress.") until `cancel_email_code`, and `NEEDS_MORE_STEPS` ends the attempt. Callbacks run once; cancel settles the in-flight callback with `ERROR` / `CANCELLED`, drops its late completion, and a new attempt may start from inside that callback.

`get_session_token(min_validity_seconds, done)` returns `AUTHENTICATED` with `token` only when the unverified JWT `exp` claim is at least `min_validity_seconds` (0 to 120) ahead. On native the token comes from `POST /v1/client/sessions/{id}/tokens`, is cached, and is re-minted when it no longer meets the request; concurrent re-mints share one request. Native session tokens carry no `azp` claim. A Go server must verify the token and authorize the request. When the Frontend API reports the session as gone, the result is `ERROR` / `SESSION_EXPIRED` and `session_changed` reports `signed_out`.

`sign_out(done)` mints a fresh session JWT, calls the non-serialized `ClerkConfig.revoke_session` callback once with that JWT and a one-shot ack `Callable`, and expects exactly `{ "schema": "gd-clerk.revoke.v1", "remote_confirmed": true, "session_id": <sid>, "subject": <sub> }` for the snapshotted session. On web it then calls `clerk.setActive({ session: null })`; on native it calls `POST /v1/client/sessions/{id}/remove`. `SIGNED_OUT` carries phase `tab_deactivated` on web and `native_session_removed` on native. A missing callback, bad or late ack, timeout, missing token, or failed removal returns `SIGN_OUT_FAILED` with a `retryable` flag and a phase, and latches protected actions: email begin, complete, resend and token mint return `SIGN_OUT_FAILED` with phase `sign_out_latched` until a later `sign_out` returns `SIGNED_OUT`. On web the latch is a non-secret `sessionStorage` flag; on native it lives in process memory. The addon does not store the JWT or put it in a result or signal. Concurrent `sign_out` callers share one attempt.

`session_changed` emits `signed_in`, `status` (`unavailable`, `signed_out`, `signed_in`, `pending`, `sign_out_unconfirmed`) and `protected_actions_blocked` only. It never includes a token, code, or email.

Result messages are fixed strings; Frontend API messages, which may contain the email address, are never surfaced. Optional `phase` is an allowlisted enum and never contains a key, token, code, email, or session id.

## Native error mapping

HTTP 429 and `too_many_requests`, `signup_rate_limit_exceeded`, `verification_code_too_many_attempts`, `verification_code_too_many_requests` are `RATE_LIMIT`. `form_code_incorrect` is `INVALID_CODE`, `verification_expired` is `EXPIRED_CODE`, `form_identifier_not_found` is `ACCOUNT_NOT_FOUND`, `form_param_format_invalid` is `INVALID_EMAIL`, `strategy_for_user_invalid` is `NEEDS_MORE_STEPS` / `UNSUPPORTED_CHALLENGE`. `authentication_invalid`, `resource_not_found`, `signed_out` and every `session_*` code are `SESSION_EXPIRED`. `native_api_disabled` is `CONFIG` with phase `native_api_disabled`. `form_identifier_exists`, `session_exists`, `user_locked`, `verification_failed` and `verification_missing` are `ERROR` / `UNKNOWN` with a fixed message. Transport failures, the 30 s deadline and 5xx responses are `ERROR` / `NETWORK` with `retryable`.

## SDK pin

Vanilla `clerk.client.signIn` and `clerk.client.signUp` are the documented legacy resources. `SignInFuture` and `SignUpFuture` exist on the pinned types only as `__internal_future`, which framework hooks use. This addon does not call those methods, `emailCode`, `verifications`, or `finalize`.

The browser files under `javascript/clerk/` are the exact `6.38.1` `clerk.browser.js` build and its same-directory chunks. They are not loaded from a floating CDN, and the export HTML does not parse that bundle before `configure`. After the project-supplied publishable key passes the existing checks, the bridge inserts the same-origin file and calls `load()` on the instance the bundle creates. `npm ci` plus `node scripts/vendor-clerk.mjs --check` verifies the lockfile integrity. The native backend has no SDK dependency.

## Tests

`make test` runs the JavaScript policy tests, the headless Godot unit tests, the native suite against `tests/native/fapi_fixture.py` (a standard-library loopback Frontend API that is accepted only with `GD_CLERK_TEST_LOOPBACK=1` and `127.0.0.1`), the browser fixture, and three web export regressions. The fixture is not Clerk; live email-code proof belongs to the consuming project.

## Releases

Releases are cut by hand: the `release` workflow runs only on `workflow_dispatch` from `main` and re-runs every test, scan and web export regression against that commit before it publishes. Each release attaches the project-root ZIP, its checksum, and `@aviorstudio_gd-clerk.gdam.zip` (the same 37 addon files with `plugin.cfg` at the archive root), then publishes that flat ZIP to the GDAM registry. The bridge loads the Clerk bundle from beside its own script, so an export served from a subdirectory works. This addon is game-agnostic. The browser fixture mocks the Smart challenge and does not claim interactive challenge completion.

### Inspector configuration

Create a `ClerkConfig` resource in the FileSystem dock and save it as a `.tres` file. Edit its publishable key, frontend API URL, and allowed origins in the Inspector, then load that resource and pass it to `GdClerk.configure(config, done)`. These are public configuration values. Set the consumer's `revoke_session` callback and, on native, its `credential_store` at runtime before configuring; callbacks, stores and session tokens are never saved in the resource.

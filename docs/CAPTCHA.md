# Smart CAPTCHA policy

The user chose Clerk Smart bot sign-up protection ON.

This build:

- Reads `userSettings.signUp.captcha_enabled` and `displayConfig.captchaWidgetType` from the loaded Clerk environment.
- Refuses sign-up unless captcha is enabled and the widget type is `smart`.
- Mounts the documented `#clerk-captcha` slot before `client.signUp.create()`.
- Does not call `signUp.create()` if the slot cannot be mounted.
- Watches for `.clerk-invisible-captcha` during `create()` and fails closed if Clerk takes the deprecated invisible fallback.
- Does not set captcha bypass, does not use the Native API, and does not disable bot protection.

`appearance: interaction-only` is Clerk's own Turnstile setting. The slot stays in the DOM. Clerk expands it only when a visitor is challenged.

Untested without a configured instance: a real Cloudflare interactive challenge, a false-positive visitor completing that challenge, and the instance CSP actually serving Turnstile. Those gates block release.

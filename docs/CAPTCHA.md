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

The browser fixture mocks the Smart challenge. This repository does not run a live Clerk instance, does not set Clerk's documented testing-token bypass, and does not claim interactive challenge completion. A consuming project's isolated test must treat a presented Turnstile widget as not accepted.

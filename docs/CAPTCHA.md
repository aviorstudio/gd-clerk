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

The live runner mounts the slot inside a real Godot web export and refuses a testing token, an invisible widget, and any solver. Clerk's documented Playwright path (`setupClerkTestingToken` / `@clerk/testing`) bypasses Turnstile. That bypass is not a challenged-path observation, and this runner does not set it. The browser fixture mocks the Smart challenge. The live gate is a normal email-code sign-up and sign-in, plus those live widget and blocked-path checks. It does not claim interactive challenge completion. If a visible Turnstile widget appears, the live run fails and does not write acceptance evidence.

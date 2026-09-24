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

The live runner mounts the slot inside a real Godot web export and refuses a testing token, an invisible widget, and any solver. Clerk's documented Playwright path (`setupClerkTestingToken` / `@clerk/testing`) bypasses Turnstile. That bypass is not a challenged-path observation, and this runner does not set it. Clerk does not publish a supported way to complete an interactive Smart challenge from automation without that bypass. If a visible Turnstile widget appears, the runner records `presented_unsolved` and does not mark the challenge accepted. A sign-up that completes with no visible challenge is the normal Smart path, not a challenged observation.

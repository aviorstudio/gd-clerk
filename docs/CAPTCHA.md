# CAPTCHA policy

Bot protection is optional. The addon reads the Clerk instance after `load()`. It does not fetch dashboard configuration and does not change it.

`captcha_enabled === false` on that loaded object means sign-up calls `client.signUp.create()` with no CAPTCHA slot and no bypass. A string, a missing environment, or any other non-boolean is not off. The loaded value can be older than a dashboard change until the page loads again.

`captcha_enabled === true` is supported only when all of these are true:

- `displayConfig.captchaWidgetType` is `smart`
- both `captchaPublicKey` and `captchaPublicKeyInvisible` are non-empty strings on that loaded object
- `client.captchaBypass` is not `true`

Otherwise sign-up fails before `create()`. The addon never sets a bypass, testing token, or invisible fallback.

When Smart is supported, a visible documented slot must exist before `create()`. The addon creates `<div id="clerk-captcha">` only when that id is absent. A consumer-supplied slot must be an unhidden `<div id="clerk-captcha">`. Optional attributes are `data-cl-theme`, `data-cl-size`, and `data-cl-language`. A hidden, disconnected, or `display: none` slot, or one with `data-clerk-captcha`, fails closed as `CONFIG` / `CAPTCHA_SLOT`. The addon does not unhide or rewrite that node.

During `create()`, `.clerk-invisible-captcha` fails closed on both the off path and the Smart path. A presented challenge is not acceptance.

The browser fixture mocks the Smart challenge. This repository does not run a live Clerk instance and does not claim interactive challenge completion.

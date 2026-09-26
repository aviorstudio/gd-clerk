# Content Security Policy

gd-clerk does not call the Clerk Frontend API itself. The pinned `@clerk/clerk-js@6.33.0` browser bundle does, and Smart sign-up bot protection loads Cloudflare Turnstile only when Clerk decides a challenge is required.

Official requirements: https://clerk.com/docs/guides/secure/best-practices/csp-headers

For a web export that uses this addon, allow at least:

- `script-src`: `'self'`, the exact configured Frontend API origin, `https://challenges.cloudflare.com`, `https://*.protect.clerk.com`
- `connect-src`: `'self'`, the exact Frontend API origin, `https://*.protect.clerk.com:*`
- `frame-src`: `https://challenges.cloudflare.com`, `https://*.protect.clerk.com`
- `worker-src`: `'self' blob:`
- `img-src`: `https://img.clerk.com`
- `style-src`: `'self' 'unsafe-inline'` when Clerk injects the Turnstile widget

Godot's `JavaScriptBridge.eval` fallback needs `script-src 'unsafe-eval'`. The export plugin avoids that fallback by injecting same-origin `<script src="gd-clerk/gd_clerk_bridge.js">` before `</head>`. The bridge inserts `<script src="gd-clerk/clerk.browser.js">` only after `configure` validates the project-supplied publishable key, and it does not use `eval` or a floating CDN URL.

The addon mounts `<div id="clerk-captcha">` before `signUp.create()`. If that element is missing, Clerk's own bundle falls back to an invisible widget. This addon treats that fallback as a failure and does not continue sign-up. A live Cloudflare interactive challenge has not been executed against a configured Clerk instance.

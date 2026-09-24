extends SceneTree

func _init() -> void:
	var failed := _run()
	quit(1 if failed else 0)

func _run() -> bool:
	var failed := false
	failed = _expect(_native_unavailable(), "native methods return UNAVAILABLE once") or failed
	failed = _expect(_policy(), "config policy rejects unsafe and unlisted origins") or failed
	failed = _expect(_html(), "web export injects pinned local scripts") or failed
	failed = _expect(_result_drops_secrets(), "results drop unexpected token and email fields") or failed
	return failed

func _expect(ok: bool, label: String) -> bool:
	if ok:
		print("ok ", label)
		return false
	push_error("FAIL " + label)
	return true

func _native_unavailable() -> bool:
	var clerk = load("res://addons/@aviorstudio_gd-clerk/gd_clerk.gd").new()
	var calls: Array = []
	var done := func(result: ClerkResult) -> void:
		calls.append(result.state)
	clerk.configure(ClerkConfig.new(), done)
	clerk.begin_email_code("person@example.com", 0, done)
	clerk.complete_email_code("123456", done)
	clerk.resend_email_code(done)
	clerk.get_session_token(30, done)
	clerk.sign_out(done)
	clerk.cancel_email_code()
	clerk.configure(ClerkConfig.new(), done)
	return calls.size() == 7 and calls.all(func(item): return item == "UNAVAILABLE")

func _policy() -> bool:
	var host := "example.clerk.accounts.dev"
	var config := ClerkConfig.new()
	var encoded := Marshalls.utf8_to_base64(host + "$")
	while encoded.ends_with("="):
		encoded = encoded.substr(0, encoded.length() - 1)
	config.publishable_key = "pk_test_" + encoded
	config.frontend_api = "https://" + host
	config.allowed_origins = PackedStringArray(["http://localhost:3100", "https://app.revik.gg"])
	if ClerkPolicy.validate_config(config, "http://localhost:3100") != "":
		return false
	if ClerkPolicy.validate_config(config, "http://localhost:3101") == "":
		return false
	if ClerkPolicy.validate_config(config, "https://app.revik.gg") != "":
		return false
	config.frontend_api = "http://" + host
	if ClerkPolicy.validate_config(config, "http://localhost:3100") == "":
		return false
	config.frontend_api = "https://other.clerk.accounts.dev"
	if ClerkPolicy.validate_config(config, "http://localhost:3100") == "":
		return false
	config.publishable_key = "sk_bad"
	config.frontend_api = "https://" + host
	if ClerkPolicy.validate_config(config, "http://localhost:3100") == "":
		return false
	return ClerkPolicy.validate_email("person@example.com") and not ClerkPolicy.validate_email("not an email") and ClerkPolicy.validate_code("123456") and not ClerkPolicy.validate_code("12ab")

func _html() -> bool:
	var patched := GdClerkHtmlExport.patch_html("<html><head><title>x</title></head><body></body></html>")
	return patched.contains("gd-clerk/clerk.browser.js") and patched.contains("gd-clerk/gd_clerk_bridge.js") and not patched.contains("clerk.accounts.dev/npm")

func _result_drops_secrets() -> bool:
	var raw := '{"state":"ERROR","error_key":"UNKNOWN","message":"failed","token":"secret-token","email":"person@example.com"}'
	var result := ClerkResult.from_json(raw, false)
	var state := SessionState.from_json('{"signed_in":true,"status":"signed_in","protected_actions_blocked":false,"token":"secret-token","email":"a@b.c"}')
	return result.token == "" and not result.message.contains("person@") and state.to_dictionary().has("token") == false and state.to_dictionary().has("email") == false

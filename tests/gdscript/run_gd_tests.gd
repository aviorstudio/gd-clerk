extends SceneTree

func _init() -> void:
	var failed := _run()
	quit(1 if failed else 0)

func _run() -> bool:
	var failed := false
	failed = _expect(_native_unavailable(), "native methods return UNAVAILABLE once") or failed
	failed = _expect(_policy(), "config policy rejects unsafe and unlisted origins") or failed
	failed = _expect(_origin_closed(), "empty and unsupported origins fail closed without echoing") or failed
	failed = _expect(_html(), "web export injects pinned local scripts") or failed
	failed = _expect(_result_drops_secrets(), "results drop unexpected token and email fields") or failed
	failed = _expect(_relay_lifecycle(), "relays are released, cancelled once, and ignored after free") or failed
	failed = _expect(_relay_cap_and_callback_free(), "relay cap fails closed and a finished callback can free its owner") or failed
	failed = _expect(_session_owner_freed(), "session callback does not touch a freed owner") or failed
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
	var ok := calls.size() == 7 and calls.all(func(item): return item == "UNAVAILABLE")
	clerk.free()
	return ok

func _policy() -> bool:
	var host := "example.clerk.accounts.dev"
	var config := ClerkConfig.new()
	var encoded := Marshalls.utf8_to_base64(host + "$")
	while encoded.ends_with("="):
		encoded = encoded.substr(0, encoded.length() - 1)
	config.publishable_key = "pk_test_" + encoded
	config.frontend_api = "https://" + host
	config.allowed_origins = PackedStringArray(["http://127.0.0.1:8080", "https://consumer.example"])
	if ClerkPolicy.validate_config(config, "http://127.0.0.1:8080") != "":
		return false
	if ClerkPolicy.validate_config(config, "http://127.0.0.1:8081") == "":
		return false
	if ClerkPolicy.validate_config(config, "https://consumer.example") != "":
		return false
	config.frontend_api = "http://" + host
	if ClerkPolicy.validate_config(config, "http://127.0.0.1:8080") == "":
		return false
	config.frontend_api = "https://other.clerk.accounts.dev"
	if ClerkPolicy.validate_config(config, "http://127.0.0.1:8080") == "":
		return false
	config.publishable_key = "sk_bad"
	config.frontend_api = "https://" + host
	if ClerkPolicy.validate_config(config, "http://127.0.0.1:8080") == "":
		return false
	return ClerkPolicy.validate_email("person@example.com") and not ClerkPolicy.validate_email("not an email") and ClerkPolicy.validate_code("123456") and not ClerkPolicy.validate_code("12ab")

func _origin_closed() -> bool:
	var clerk = load("res://addons/@aviorstudio_gd-clerk/gd_clerk.gd").new()
	var native_origin: String = clerk._page_origin()
	var empty_ok: bool = not clerk._is_supported_origin("")
	var file_ok: bool = not clerk._is_supported_origin("file://secret.example")
	var null_ok: bool = not clerk._is_supported_origin("null")
	var listed_ok: bool = clerk._is_supported_origin("http://127.0.0.1:9")
	clerk.free()
	var config := _sample_config()
	var empty_message := ClerkPolicy.validate_config(config, "")
	var file_message := ClerkPolicy.validate_config(config, "file://secret.example")
	var opaque_message := ClerkPolicy.validate_config(config, "null")
	return native_origin == "" and empty_ok and file_ok and null_ok and listed_ok and empty_message == "Configuration is invalid." and file_message == "Configuration is invalid." and opaque_message == "Configuration is invalid." and not file_message.contains("secret.example") and not empty_message.contains("http")

func _sample_config() -> ClerkConfig:
	var host := "example.clerk.accounts.dev"
	var config := ClerkConfig.new()
	var encoded := Marshalls.utf8_to_base64(host + "$")
	while encoded.ends_with("="):
		encoded = encoded.substr(0, encoded.length() - 1)
	config.publishable_key = "pk_test_" + encoded
	config.frontend_api = "https://" + host
	config.allowed_origins = PackedStringArray(["http://127.0.0.1:9"])
	return config

func _html() -> bool:
	var patched := GdClerkHtmlExport.patch_html("<html><head><title>x</title></head><body></body></html>")
	return patched.contains("gd-clerk/gd_clerk_bridge.js") and not patched.contains("clerk.browser.js") and not patched.contains("clerk.accounts.dev") and not patched.contains("pk_") and not patched.contains("__clerk_publishable_key")

func _result_drops_secrets() -> bool:
	var raw := '{"state":"ERROR","error_key":"UNKNOWN","message":"failed","token":"secret-token","email":"person@example.com","phase":"person@example.com"}'
	var result := ClerkResult.from_json(raw, false)
	var state := SessionState.from_json('{"signed_in":true,"status":"signed_in","protected_actions_blocked":false,"token":"secret-token","email":"a@b.c"}')
	var allowed := ClerkResult.from_json('{"state":"ERROR","error_key":"NETWORK","phase":"create_stale"}', false)
	return result.token == "" and result.phase == "" and allowed.phase == "create_stale" and not result.message.contains("person@") and state.to_dictionary().has("token") == false and state.to_dictionary().has("email") == false

func _clerk() -> Node:
	return load("res://addons/@aviorstudio_gd-clerk/gd_clerk.gd").new()

func _label(result: ClerkResult) -> String:
	return result.error_key if result.error_key != "" else result.state

func _relay_lifecycle() -> bool:
	var clerk := _clerk()
	var calls: Array = []
	var done := func(result: ClerkResult) -> void:
		calls.append(_label(result))
	for _i in 20:
		var id: int = clerk._track(done)
		var relay = clerk._retain_relay(id, done, false, true)
		if relay == null:
			clerk.free()
			return false
		relay.on_js(['{"state":"CODE_SENT","error_key":"","message":"Verification code sent."}'])
	if calls.size() != 20 or clerk._relays.size() != 0:
		clerk.free()
		return false
	var cancelled_id: int = clerk._track(done)
	var cancelled = clerk._retain_relay(cancelled_id, done, false, true)
	clerk.cancel_email_code()
	if calls.size() != 21 or calls[20] != "CANCELLED" or clerk._relays.size() != 0:
		clerk.free()
		return false
	cancelled.on_js(['{"state":"AUTHENTICATED","error_key":"","message":"Signed in."}'])
	if calls.size() != 21:
		clerk.free()
		return false
	var next_id: int = clerk._track(done)
	var next = clerk._retain_relay(next_id, done, false, true)
	next.on_js(['{"state":"CODE_SENT","error_key":"","message":"Verification code sent."}'])
	if calls.size() != 22 or calls[21] != "CODE_SENT" or clerk._relays.size() != 0:
		clerk.free()
		return false
	var kept_id: int = clerk._track(done)
	var kept = clerk._retain_relay(kept_id, done, false, false)
	clerk.cancel_email_code()
	if calls.size() != 22 or clerk._relays.size() != 1:
		clerk.free()
		return false
	kept.on_js(['{"state":"SIGNED_OUT","error_key":"","message":"Signed out."}'])
	if calls.size() != 23 or calls[22] != "SIGNED_OUT" or clerk._relays.size() != 0:
		clerk.free()
		return false
	var freed_id: int = clerk._track(done)
	var freed = clerk._retain_relay(freed_id, done, false, true)
	var before := calls.size()
	clerk.free()
	freed.on_js(['{"state":"CODE_SENT","error_key":"","message":"later"}'])
	return calls.size() == before

func _relay_cap_and_callback_free() -> bool:
	var clerk := _clerk()
	var calls: Array = []
	var done := func(result: ClerkResult) -> void:
		calls.append(_label(result))
	for _i in 8:
		var id: int = clerk._track(done)
		if clerk._retain_relay(id, done, false, false) == null:
			clerk.free()
			return false
	var overflow: int = clerk._track(done)
	if clerk._retain_relay(overflow, done, false, false) != null or calls.size() != 1 or calls[0] != "UNKNOWN":
		clerk.free()
		return false
	clerk.free()
	var owner := _clerk()
	var saw: Array = []
	var freeing := func(result: ClerkResult) -> void:
		saw.append(result.state)
	var live: int = owner._track(freeing)
	var relay = owner._retain_relay(live, freeing, false, false)
	relay.on_js(['{"state":"CONFIGURED","error_key":"","message":"Configured."}'])
	if saw.size() != 1 or saw[0] != "CONFIGURED" or owner._relays.size() != 0:
		owner.free()
		return false
	owner.free()
	relay.on_js(['{"state":"CONFIGURED","error_key":"","message":"again"}'])
	return saw.size() == 1

func _session_owner_freed() -> bool:
	var clerk := _clerk()
	var statuses: Array = []
	clerk.session_changed.connect(func(state: SessionState) -> void:
		statuses.append(state.status)
	)
	var relay = clerk._make_session_relay()
	relay.on_js(['{"signed_in":true,"status":"signed_in","protected_actions_blocked":false}'])
	if statuses.size() != 1 or statuses[0] != "signed_in":
		clerk.free()
		return false
	clerk.free()
	relay.on_js(['{"signed_in":false,"status":"signed_out","protected_actions_blocked":true}'])
	return statuses.size() == 1

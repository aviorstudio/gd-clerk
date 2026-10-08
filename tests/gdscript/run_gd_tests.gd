extends SceneTree

func _init() -> void:
	var failed := _run()
	quit(1 if failed else 0)

func _run() -> bool:
	var failed := false
	failed = _expect(_native_unconfigured(), "native methods fail closed with CONFIG until configured") or failed
	failed = _expect(_native_policy(), "native config policy accepts Clerk hosts and rejects the rest") or failed
	failed = _expect(_native_helpers(), "native backend redacts, form-encodes, decodes exp and parses revoke acks") or failed
	failed = _expect(_config_resource(), "Inspector configuration round-trips without runtime callbacks") or failed
	failed = _expect(_policy(), "config policy rejects unsafe and unlisted origins") or failed
	failed = _expect(_origin_closed(), "empty and unsupported origins fail closed without echoing") or failed
	failed = _expect(_html(), "web export injects pinned local scripts") or failed
	failed = _expect(_result_drops_secrets(), "results drop unexpected token and email fields") or failed
	failed = _expect(_config_omits_revoke(), "revoke callback is not serialized and phases stay allowlisted") or failed
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

func _native_unconfigured() -> bool:
	var clerk = load("res://addons/@aviorstudio_gd-clerk/gd_clerk.gd").new()
	var calls: Array = []
	var done := func(result: ClerkResult) -> void:
		calls.append(result.state + "/" + result.error_key)
	clerk.configure(ClerkConfig.new(), done)
	clerk.begin_email_code("person@example.com", 0, done)
	clerk.complete_email_code("123456", done)
	clerk.resend_email_code(done)
	clerk.get_session_token(30, done)
	clerk.sign_out(done)
	clerk.cancel_email_code()
	clerk.configure(null, done)
	# A valid native config on a node outside the tree fails closed too: requests need the tree.
	var detached := _native_config("https://example.clerk.accounts.dev")
	clerk.configure(detached, done)
	var ok: bool = calls.size() == 8 and calls.all(func(item): return item == "ERROR/CONFIG") and clerk._relays.size() == 0
	clerk.free()
	return ok

func _native_config(frontend_api: String) -> ClerkConfig:
	var host := frontend_api.trim_prefix("https://").trim_prefix("http://")
	var config := ClerkConfig.new()
	var encoded := Marshalls.utf8_to_base64(host + "$")
	while encoded.ends_with("="):
		encoded = encoded.substr(0, encoded.length() - 1)
	config.publishable_key = "pk_test_" + encoded
	config.frontend_api = frontend_api
	return config

func _native_policy() -> bool:
	if ClerkPolicy.validate_native_config(_native_config("https://example.clerk.accounts.dev")) != "":
		return false
	if ClerkPolicy.validate_native_config(_native_config("https://clerk.example.com")) != "":
		return false
	if ClerkPolicy.validate_native_config(_native_config("https://clerk.play.example.com")) != "":
		return false
	# allowed_origins are not required natively.
	var with_origins := _native_config("https://clerk.example.com")
	with_origins.allowed_origins = PackedStringArray(["https://consumer.example"])
	if ClerkPolicy.validate_native_config(with_origins) != "":
		return false
	var rejected: Array = [
		_native_config("http://example.clerk.accounts.dev"),
		_native_config("https://accounts.example.com"),
		_native_config("https://clerk.accounts.dev"),
		_native_config("https://example.com"),
		_native_config("https://clerk.example.com/path"),
		_native_config("http://127.0.0.1:9"),
	]
	for config in rejected:
		var message: String = ClerkPolicy.validate_native_config(config)
		if message != "Configuration is invalid." or message.contains("clerk") or message.contains("127"):
			return false
	var mismatched := _native_config("https://clerk.example.com")
	mismatched.frontend_api = "https://clerk.other.com"
	if ClerkPolicy.validate_native_config(mismatched) == "":
		return false
	var secret := _native_config("https://clerk.example.com")
	secret.publishable_key = "sk_" + "live_" + "notallowedhere1234567890"
	if ClerkPolicy.validate_native_config(secret) == "" or ClerkPolicy.validate_native_config(null) == "":
		return false
	# Loopback http is accepted only while the test flag is set.
	var loopback := _native_config("http://127.0.0.1:9")
	var before := ClerkPolicy.validate_native_config(loopback)
	OS.set_environment("GD_CLERK_TEST_LOOPBACK", "1")
	var during := ClerkPolicy.validate_native_config(loopback)
	var remote_http := ClerkPolicy.validate_native_config(_native_config("http://example.clerk.accounts.dev"))
	OS.unset_environment("GD_CLERK_TEST_LOOPBACK")
	var after := ClerkPolicy.validate_native_config(loopback)
	if before == "" or during != "" or remote_http == "" or after == "":
		return false
	var web := _sample_config()
	return ClerkPolicy.validate_config(web, "http://127.0.0.1:9") == "" and not ClerkPolicy.is_native_frontend_api_host("clerk.") and ClerkPolicy.is_native_frontend_api_host("CLERK.Example.com")

func _native_helpers() -> bool:
	var backend_script = load("res://addons/@aviorstudio_gd-clerk/clerk_native_backend.gd")
	var backend = backend_script.new()
	var redacted: String = backend_script.sanitize_message("code 123456 for person@example.com token eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2ln key pk_test_abc123 ok")
	if redacted.contains("person@") or redacted.contains("123456") or redacted.contains("eyJ") or redacted.contains("pk_test") or not redacted.ends_with("ok"):
		return false
	if backend_script.sanitize_message("x".repeat(400)).length() != 180:
		return false
	var form: String = backend_script._form_encode({"identifier": "a+b@example.com", "strategy": "email_code"})
	if form != "identifier=a%2Bb%40example.com&strategy=email_code":
		return false
	var exp := int(Time.get_unix_time_from_system()) + 600
	var payload := Marshalls.utf8_to_base64(JSON.stringify({"exp": exp, "sub": "user_1"})).replace("=", "").replace("+", "-").replace("/", "_")
	var jwt := "eyJhbGciOiJSUzI1NiJ9." + payload + ".sig"
	if backend._token_exp(jwt) != exp or not backend._token_meets(jwt, 120) or backend._token_meets(jwt, 601) or backend._token_meets("not.a.jwt", 0):
		return false
	var good := {"schema": "gd-clerk.revoke.v1", "remote_confirmed": true, "session_id": "sess_1", "subject": "user_1"}
	if backend._parse_revoke_ack(good).is_empty() or backend._parse_revoke_ack(JSON.stringify(good)).is_empty():
		return false
	var extra := good.duplicate()
	extra["note"] = "x"
	var unconfirmed := good.duplicate()
	unconfirmed["remote_confirmed"] = "true"
	if not backend._parse_revoke_ack(extra).is_empty() or not backend._parse_revoke_ack(unconfirmed).is_empty() or not backend._parse_revoke_ack("[]").is_empty():
		return false
	if backend._sanitize_token("Bearer") != "" or backend._sanitize_token(" dvb_abc ") != "dvb_abc" or backend._sanitize_token("a b") != "":
		return false
	var state: Dictionary = backend.session_state()
	if state.get("status") != "unavailable" or state.get("signed_in") != false or state.get("protected_actions_blocked") != false:
		return false
	var store := ClerkCredentialStore.new()
	return store.read_value("client_token") == "" and store.write_value("client_token", "dvb_1") and store.read_value("client_token") == "dvb_1" and store.write_value("client_token", "") and store.read_value("client_token") == ""

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

func _config_omits_revoke() -> bool:
	var config := ClerkConfig.new()
	config.revoke_session = func(_jwt: String, _done: Callable) -> void:
		pass
	var data := config.to_dictionary()
	var raw := JSON.stringify(data)
	var kept := ClerkResult.from_json('{"state":"SIGNED_OUT","phase":"tab_deactivated","token":"aaa.not-a-token.sig"}', false)
	var dropped := ClerkResult.from_json('{"state":"SIGN_OUT_FAILED","phase":"not_a_phase"}', false)
	return not data.has("revoke_session") and not raw.contains("revoke") and kept.phase == "tab_deactivated" and kept.token == "" and dropped.phase == ""

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

func _config_resource() -> bool:
	var config := _sample_config()
	config.revoke_session = func(_jwt: String, _done: Callable) -> void: pass
	var path := "user://clerk-config-test.tres"
	if ResourceSaver.save(config, path) != OK:
		return false
	var restored := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE) as ClerkConfig
	var text := FileAccess.get_file_as_string(path)
	DirAccess.remove_absolute(path)
	return restored != null and restored.to_dictionary() == config.to_dictionary() and not restored.revoke_session.is_valid() and not text.contains("revoke_session")

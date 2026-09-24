extends Node

signal session_changed(state: SessionState)

var _next_id: int = 1
var _pending: Dictionary = {}
var _session_cb: Variant = null
var _listener_ready: bool = false
var _relays: Array = []

func configure(config: ClerkConfig, done: Callable) -> void:
	if not _is_web():
		_finish_now(done, ClerkResult.unavailable())
		return
	var origin := _page_origin()
	var problem := ClerkPolicy.validate_config(config, origin)
	if problem != "":
		_finish_now(done, ClerkResult.error("CONFIG", problem))
		return
	var bridge := _bridge()
	if bridge == null:
		_finish_now(done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return
	_ensure_listener()
	var id := _track(done)
	var cb := _make_callback(id, done, false)
	bridge.call("configure", JSON.stringify(config.to_dictionary()), cb)

func begin_email_code(email: String, mode: int, done: Callable) -> void:
	if not _is_web():
		_finish_now(done, ClerkResult.unavailable())
		return
	if not ClerkPolicy.validate_email(email):
		_finish_now(done, ClerkResult.error("UNKNOWN", "The email address is not valid."))
		return
	var mode_name := "SIGN_IN" if mode == 0 else "SIGN_UP" if mode == 1 else ""
	if mode_name == "":
		_finish_now(done, ClerkResult.error("CONFIG", "Configuration is invalid."))
		return
	var bridge := _bridge()
	if bridge == null:
		_finish_now(done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return
	var id := _track(done)
	bridge.call("beginEmailCode", email, mode_name, _make_callback(id, done, false))

func complete_email_code(code: String, done: Callable) -> void:
	if not _is_web():
		_finish_now(done, ClerkResult.unavailable())
		return
	if not ClerkPolicy.validate_code(code):
		_finish_now(done, ClerkResult.error("INVALID_CODE", "The verification code is invalid."))
		return
	var bridge := _bridge()
	if bridge == null:
		_finish_now(done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return
	var id := _track(done)
	bridge.call("completeEmailCode", code, _make_callback(id, done, false))

func resend_email_code(done: Callable) -> void:
	if not _is_web():
		_finish_now(done, ClerkResult.unavailable())
		return
	var bridge := _bridge()
	if bridge == null:
		_finish_now(done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return
	var id := _track(done)
	bridge.call("resendEmailCode", _make_callback(id, done, false))

func cancel_email_code() -> void:
	if not _is_web():
		return
	var bridge := _bridge()
	if bridge == null:
		return
	bridge.call("cancelEmailCode")

func get_session_token(min_validity_seconds: int, done: Callable) -> void:
	if not _is_web():
		_finish_now(done, ClerkResult.unavailable())
		return
	var bridge := _bridge()
	if bridge == null:
		_finish_now(done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return
	var id := _track(done)
	bridge.call("getSessionToken", min_validity_seconds, _make_callback(id, done, true))

func sign_out(done: Callable) -> void:
	if not _is_web():
		_finish_now(done, ClerkResult.unavailable())
		return
	var bridge := _bridge()
	if bridge == null:
		_finish_now(done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return
	var id := _track(done)
	bridge.call("signOut", _make_callback(id, done, false))

func _is_web() -> bool:
	return OS.has_feature("web")

func _js() -> Object:
	return Engine.get_singleton("JavaScriptBridge")

func _bridge() -> Object:
	var js := _js()
	if js == null:
		return null
	return js.call("get_interface", "GdClerkBridge")

func _page_origin() -> String:
	var js := _js()
	if js == null:
		return ""
	var location = js.call("get_interface", "location")
	if location == null:
		return ""
	return str(location.get("origin"))

func _track(done: Callable) -> int:
	var id := _next_id
	_next_id += 1
	_pending[id] = true
	return id

func _finish_now(done: Callable, result: ClerkResult) -> void:
	var id := _track(done)
	_complete(id, done, result)

func _complete(id: int, done: Callable, result: ClerkResult) -> void:
	if not _pending.has(id):
		return
	_pending.erase(id)
	if done.is_valid():
		done.call(result)

func _make_callback(id: int, done: Callable, allow_token: bool) -> Variant:
	var js := _js()
	var relay := _Relay.new()
	relay.owner = self
	relay.id = id
	relay.done = done
	relay.allow_token = allow_token
	_relays.append(relay)
	return js.call("create_callback", Callable(relay, "on_js"))

func _ensure_listener() -> void:
	if _listener_ready:
		return
	var js := _js()
	var bridge := _bridge()
	if js == null or bridge == null:
		return
	var relay := _SessionRelay.new()
	relay.owner = self
	_session_cb = js.call("create_callback", Callable(relay, "on_js"))
	bridge.call("setSessionListener", _session_cb)
	_listener_ready = true

func _on_session_payload(raw: String) -> void:
	session_changed.emit(SessionState.from_json(raw))

class _Relay:
	extends RefCounted
	var owner: Node
	var id: int = 0
	var done: Callable
	var allow_token: bool = false

	func on_js(args: Array) -> void:
		if owner == null:
			return
		var raw := ""
		if not args.is_empty():
			raw = str(args[0])
		owner._complete(id, done, ClerkResult.from_json(raw, allow_token))

class _SessionRelay:
	extends RefCounted
	var owner: Node

	func on_js(args: Array) -> void:
		if owner == null or args.is_empty():
			return
		owner._on_session_payload(str(args[0]))

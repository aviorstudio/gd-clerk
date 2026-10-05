extends Node

signal session_changed(state: SessionState)

const _MAX_LIVE_RELAYS := 8

var _next_id: int = 1
var _generation: int = 1
var _pending: Dictionary = {}
var _session_cb: Variant = null
var _session_relay: RefCounted = null
var _listener_ready: bool = false
var _relays: Array = []
var _revoke_session: Callable = Callable()
var _revoke_relay: RefCounted = null
var _revoke_js: Variant = null
var _revoke_ack_attempt: int = 0

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
	_revoke_session = config.revoke_session
	_bind_revoke_session()
	var id := _track(done)
	var cb: Variant = _make_callback(id, done, false, false)
	if cb == null:
		return
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
	var cb: Variant = _make_callback(id, done, false, true)
	if cb == null:
		return
	bridge.call("beginEmailCode", email, mode_name, cb)

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
	var cb: Variant = _make_callback(id, done, false, true)
	if cb == null:
		return
	bridge.call("completeEmailCode", code, cb)

func resend_email_code(done: Callable) -> void:
	if not _is_web():
		_finish_now(done, ClerkResult.unavailable())
		return
	var bridge := _bridge()
	if bridge == null:
		_finish_now(done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return
	var id := _track(done)
	var cb: Variant = _make_callback(id, done, false, true)
	if cb == null:
		return
	bridge.call("resendEmailCode", cb)

func cancel_email_code() -> void:
	_generation += 1
	var stale: Array = []
	for relay in _relays:
		if relay.cancellable and not relay.settled and relay.generation != _generation:
			stale.append(relay)
	for relay in stale:
		if not is_instance_valid(self):
			return
		relay.settled = true
		relay.cancelled = true
		_release_relay(relay)
		_complete(relay.id, relay.done, ClerkResult.error("CANCELLED", "The request was cancelled."))
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
	var cb: Variant = _make_callback(id, done, true, false)
	if cb == null:
		return
	bridge.call("getSessionToken", min_validity_seconds, cb)

func sign_out(done: Callable) -> void:
	if not _is_web():
		_finish_now(done, ClerkResult.unavailable())
		return
	var bridge := _bridge()
	if bridge == null:
		_finish_now(done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return
	var id := _track(done)
	var cb: Variant = _make_callback(id, done, false, false)
	if cb == null:
		return
	_bind_revoke_session()
	bridge.call("signOut", cb)

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
	if not _is_web():
		return ""
	var js := _js()
	if js == null:
		return ""
	var location: Variant = js.call("get_interface", "location")
	if location == null or not (location is Object):
		return ""
	# Read the property. A method call named get is forwarded to JavaScript and does not exist on Location.
	var origin: Variant = (location as Object).origin
	if typeof(origin) != TYPE_STRING or not _is_supported_origin(origin):
		return ""
	return origin

func _is_supported_origin(origin: String) -> bool:
	if origin.is_empty() or origin.length() > 200:
		return false
	if origin.contains(" ") or origin.contains("\t") or origin.contains("\n") or origin.contains("\r"):
		return false
	var scheme := ""
	if origin.begins_with("https://"):
		scheme = "https://"
	elif origin.begins_with("http://"):
		scheme = "http://"
	else:
		return false
	var body := origin.substr(scheme.length())
	if body.is_empty() or body.contains("/") or body.contains("?") or body.contains("#") or body.contains("@") or body.contains("\\"):
		return false
	return true

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
	# The callback may queue_free this node. Do not touch self after it runs.
	if done.is_valid():
		done.call(result)

func _make_callback(id: int, done: Callable, allow_token: bool, cancellable: bool) -> Variant:
	if _relays.size() >= _MAX_LIVE_RELAYS:
		_complete(id, done, ClerkResult.error("UNKNOWN", "The request failed."))
		return null
	var js := _js()
	if js == null:
		_complete(id, done, ClerkResult.error("CONFIG", "Clerk bridge is not loaded."))
		return null
	var relay: Variant = _retain_relay(id, done, allow_token, cancellable)
	if relay == null:
		return null
	var callback: Variant = js.call("create_callback", Callable(relay, "on_js"))
	# The engine drops the JavaScript proxy when this Variant dies. A later
	# bridge callback then no-ops, so the relay must hold it until delivery.
	relay.js_callback = callback
	return callback

func _retain_relay(id: int, done: Callable, allow_token: bool, cancellable: bool) -> Variant:
	if _relays.size() >= _MAX_LIVE_RELAYS:
		_complete(id, done, ClerkResult.error("UNKNOWN", "The request failed."))
		return null
	var relay := _Relay.new()
	relay.owner = self
	relay.id = id
	relay.done = done
	relay.allow_token = allow_token
	relay.generation = _generation
	relay.cancellable = cancellable
	_relays.append(relay)
	return relay

func _release_relay(relay: _Relay) -> void:
	var kept: Array = []
	for item in _relays:
		if item != relay:
			kept.append(item)
	_relays = kept

func _make_session_relay() -> _SessionRelay:
	var relay := _SessionRelay.new()
	relay.owner = self
	_session_relay = relay
	return relay

func _notification(what: int) -> void:
	if what != NOTIFICATION_PREDELETE:
		return
	_generation += 1
	for relay in _relays:
		relay.settled = true
		relay.owner = null
	_relays.clear()
	_pending.clear()
	if _session_relay != null:
		_session_relay.settled = true
		_session_relay.owner = null
		_session_relay = null

func _ensure_listener() -> void:
	if _listener_ready:
		return
	var js := _js()
	var bridge := _bridge()
	if js == null or bridge == null:
		return
	var relay := _make_session_relay()
	_session_cb = js.call("create_callback", Callable(relay, "on_js"))
	bridge.call("setSessionListener", _session_cb)
	_listener_ready = true

func _bind_revoke_session() -> void:
	var bridge := _bridge()
	var js := _js()
	if bridge == null or js == null:
		return
	if not _revoke_session.is_valid():
		bridge.call("setRevokeSession", null)
		return
	if _revoke_js == null:
		var relay := _RevokeRelay.new()
		relay.owner = self
		_revoke_relay = relay
		_revoke_js = js.call("create_callback", Callable(relay, "on_jwt"))
	bridge.call("setRevokeSession", _revoke_js)

func _submit_revoke(payload: Variant) -> void:
	var bridge := _bridge()
	if bridge == null:
		return
	var raw := ""
	if payload is Dictionary:
		raw = JSON.stringify(payload)
	elif typeof(payload) == TYPE_STRING:
		raw = payload
	bridge.call("submitRevokeAck", raw)

func _on_session_payload(raw: String) -> void:
	session_changed.emit(SessionState.from_json(raw))

class _Relay:
	extends RefCounted
	var owner: Node
	var id: int = 0
	var done: Callable
	var allow_token: bool = false
	var generation: int = 0
	var cancellable: bool = false
	var cancelled: bool = false
	var settled: bool = false
	var js_callback: Variant = null

	func on_js(args: Array) -> void:
		if settled:
			return
		js_callback = null
		if not is_instance_valid(owner):
			settled = true
			return
		var deliver_cancel: bool = cancelled or (cancellable and generation != owner._generation)
		settled = true
		var result: ClerkResult
		if deliver_cancel:
			result = ClerkResult.error("CANCELLED", "The request was cancelled.")
		else:
			var raw := ""
			if not args.is_empty():
				raw = str(args[0])
			result = ClerkResult.from_json(raw, allow_token)
		var target: Node = owner
		target._release_relay(self)
		if not is_instance_valid(target):
			return
		target._complete(id, done, result)

class _SessionRelay:
	extends RefCounted
	var owner: Node
	var settled: bool = false

	func on_js(args: Array) -> void:
		if settled or not is_instance_valid(owner) or args.is_empty():
			return
		owner._on_session_payload(str(args[0]))

class _RevokeRelay:
	extends RefCounted
	var owner: Node
	var attempt: int = 0

	func on_jwt(args: Array) -> void:
		if not is_instance_valid(owner):
			return
		attempt += 1
		var mine := attempt
		var jwt := ""
		if not args.is_empty():
			jwt = str(args[0])
		if jwt == "" or not owner._revoke_session.is_valid():
			owner._submit_revoke("")
			return
		var ack := func(payload: Variant) -> void:
			if not is_instance_valid(owner) or mine != attempt or owner._revoke_ack_attempt == mine:
				return
			owner._revoke_ack_attempt = mine
			owner._submit_revoke(payload)
		owner._revoke_session.call(jwt, ack)

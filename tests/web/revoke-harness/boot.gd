extends Node

var _clerk: Node
var _started: bool = false
var _mode: String = ""
var _invocations: int = 0
var _saw_token: bool = false
var _late_done: Callable = Callable()
var _steps: Array = []
var _signals: Array = []

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	_clerk = get_node_or_null("/root/GdClerk")
	if _clerk != null and _clerk.has_signal("session_changed"):
		_clerk.session_changed.connect(_on_session)
	var window := _window()
	if window == null:
		return
	window.gdClerkStart = false
	window.gdClerkReady = true
	window.gdClerkPhase = "ready"

func _process(_delta: float) -> void:
	if _started or not OS.has_feature("web"):
		return
	var window := _window()
	if window == null or not _is_start(window.gdClerkStart):
		return
	_started = true
	window.gdClerkPhase = "started"
	_run()

func _is_start(value: Variant) -> bool:
	if typeof(value) == TYPE_BOOL:
		return value
	if typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT:
		return value == 1
	return str(value) == "true"

func _on_session(state: SessionState) -> void:
	_signals.append(state.status)

func _run() -> void:
	if _clerk == null:
		_fail("missing_autoload")
		return
	var config := _config(false)
	if config == null:
		_fail("bad_config")
		return
	_clerk.configure(config, func(result: ClerkResult) -> void:
		_record("missing_configure", result)
		if result.state != "CONFIGURED":
			_finish()
			return
		_clerk.sign_out(func(signed: ClerkResult) -> void:
			_record("missing", signed)
			_clerk.get_session_token(10, func(probe: ClerkResult) -> void:
				_record("missing_latch", probe)
				_configure_host()
			)
		)
	)

func _configure_host() -> void:
	var config := _config(true)
	if config == null:
		_fail("bad_config")
		return
	_clerk.configure(config, func(result: ClerkResult) -> void:
		_record("host_configure", result)
		if result.state != "CONFIGURED":
			_finish()
			return
		_sign("malformed", _after_malformed)
	)

func _after_malformed() -> void:
	_sign("late", _after_late)

func _after_late() -> void:
	var before := _counter("gdClerkSetActive")
	if _late_done.is_valid():
		_late_done.call(_ack())
	_refresh()
	_steps.append({
		"name": "late_ignored",
		"set_active": _counter("gdClerkSetActive"),
		"unchanged": _counter("gdClerkSetActive") == before,
	})
	_publish(false)
	_window().gdClerkKeepSession = true
	_sign("failure", _after_failure)

func _after_failure() -> void:
	_window().gdClerkKeepSession = false
	_window().call("gdClerkPrime")
	_sign("intermediate", _after_intermediate)

func _after_intermediate() -> void:
	_window().call("gdClerkPrime")
	_sign("success", _after_success)

func _after_success() -> void:
	_clerk.get_session_token(10, func(probe: ClerkResult) -> void:
		_record("success_open", probe)
		_finish()
	)

func _sign(mode: String, next: Callable) -> void:
	_mode = mode
	_clerk.sign_out(func(result: ClerkResult) -> void:
		_record(mode, result)
		next.call()
	)

func _revoke(jwt: String, done: Callable) -> void:
	_invocations += 1
	if jwt.contains(".") and jwt.split(".").size() == 3 and jwt.length() > 8:
		_saw_token = true
	if _mode == "late":
		_late_done = done
		return
	if _mode == "malformed":
		var bad := _ack()
		bad["extra"] = true
		done.call(bad)
		return
	if _mode == "intermediate":
		_window().call("gdClerkNoteIntermediate")
	done.call(_ack())

func _ack() -> Dictionary:
	return {
		"schema": "gd-clerk.revoke.v1",
		"remote_confirmed": true,
		"session_id": "sess_current",
		"subject": "user_current",
	}

func _config(with_revoke: bool) -> ClerkConfig:
	var window := _window()
	if window == null:
		return null
	var key := str(window.gdClerkPublicKey)
	var fapi := str(window.gdClerkFrontendApi)
	var origin := _origin()
	if key == "" or fapi == "" or origin == "":
		return null
	var config := ClerkConfig.new()
	config.publishable_key = key
	config.frontend_api = fapi
	config.allowed_origins = PackedStringArray([origin])
	if with_revoke:
		config.revoke_session = _revoke
	return config

func _record(name: String, result: ClerkResult) -> void:
	_refresh()
	var window := _window()
	if window != null:
		window.gdClerkPhase = name
	_steps.append({
		"name": name,
		"state": result.state,
		"error_key": result.error_key,
		"phase": result.phase,
		"retryable": result.retryable,
		"invocations": _invocations,
		"saw_token": _saw_token,
		"set_active": _counter("gdClerkSetActive"),
		"sign_out_calls": _counter("gdClerkSignOutCalls"),
		"session_null": _flag("gdClerkSessionNull"),
		"other_remains": _flag("gdClerkOtherRemains"),
		"current_remains": _flag("gdClerkCurrentRemains"),
	})
	_publish(false)

func _fail(name: String) -> void:
	_steps.append({"name": name, "state": "HARNESS", "phase": name})
	_finish()

func _finish() -> void:
	_publish(true)

func _publish(done: bool) -> void:
	var window := _window()
	if window == null:
		return
	window.gdClerkReport = JSON.stringify({"steps": _steps, "signals": _signals})
	window.gdClerkDone = done

func _refresh() -> void:
	var window := _window()
	if window != null:
		window.call("gdClerkPublish")

func _counter(prop: String) -> int:
	var window := _window()
	if window == null:
		return -1
	var value: Variant = window.gdClerkSetActive if prop == "gdClerkSetActive" else window.gdClerkSignOutCalls
	if typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT:
		return int(value)
	var text := str(value)
	return int(text) if text.is_valid_int() else 0

func _flag(prop: String) -> bool:
	var window := _window()
	if window == null:
		return false
	var value: Variant = window.gdClerkSessionNull if prop == "gdClerkSessionNull" else window.gdClerkOtherRemains if prop == "gdClerkOtherRemains" else window.gdClerkCurrentRemains
	return value == true

func _window() -> Object:
	var js := Engine.get_singleton("JavaScriptBridge")
	if js == null:
		return null
	var window: Variant = js.call("get_interface", "window")
	if window == null or not (window is Object):
		return null
	return window

func _origin() -> String:
	var js := Engine.get_singleton("JavaScriptBridge")
	if js == null:
		return ""
	var location: Variant = js.call("get_interface", "location")
	if location == null or not (location is Object):
		return ""
	var origin: Variant = (location as Object).origin
	if typeof(origin) != TYPE_STRING:
		return ""
	return origin

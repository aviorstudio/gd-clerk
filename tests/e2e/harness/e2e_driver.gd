extends Node

const ConfigScript = preload("res://addons/@aviorstudio_gd-clerk/clerk_config.gd")

var _busy: bool = false
var _session_status: String = "unavailable"
var _signed_in: bool = false

func _ready() -> void:
	var clerk := get_node_or_null("/root/GdClerk")
	if clerk != null and clerk.has_signal("session_changed"):
		clerk.session_changed.connect(_on_session)
	if OS.has_feature("web"):
		JavaScriptBridge.eval("window.__gdClerkE2E={ready:true,command:null,result:null}")

func _process(_delta: float) -> void:
	if _busy or not OS.has_feature("web"):
		return
	var raw := _take_command()
	if raw == "" or raw == "<null>":
		return
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	_busy = true
	_dispatch(parsed)

func _on_session(state: SessionState) -> void:
	_session_status = state.status
	_signed_in = state.signed_in

func _take_command() -> String:
	var raw: Variant = JavaScriptBridge.eval("(function(){var q=window.__gdClerkE2E;if(!q||!q.command)return '';var s=JSON.stringify(q.command);q.command=null;return s;})()")
	return str(raw)

func _dispatch(cmd: Dictionary) -> void:
	var id := int(cmd.get("id", 0))
	var op := str(cmd.get("op", ""))
	var clerk := get_node_or_null("/root/GdClerk")
	if clerk == null:
		_finish(id, "ERROR", "CONFIG")
		return
	if op == "session":
		_finish(id, "SESSION", "")
		return
	if op == "configure":
		var config = ConfigScript.new()
		config.publishable_key = str(cmd.get("publishable_key", ""))
		config.frontend_api = str(cmd.get("frontend_api", ""))
		var origins := PackedStringArray()
		var items: Variant = cmd.get("allowed_origins", [])
		if typeof(items) == TYPE_ARRAY:
			for item in items:
				origins.append(str(item))
		config.allowed_origins = origins
		clerk.call("configure", config, _done.bind(id))
		return
	if op == "begin":
		clerk.call("begin_email_code", str(cmd.get("email", "")), int(cmd.get("mode", -1)), _done.bind(id))
		return
	if op == "complete":
		clerk.call("complete_email_code", str(cmd.get("code", "")), _done.bind(id))
		return
	if op == "sign_out":
		clerk.call("sign_out", _done.bind(id))
		return
	_finish(id, "ERROR", "CONFIG")

func _done(result: ClerkResult, id: int) -> void:
	call_deferred("_finish", id, result.state, result.error_key)

func _finish(id: int, state: String, error_key: String) -> void:
	var payload := {
		"id": id,
		"state": state,
		"error_key": error_key,
		"session_status": _session_status,
		"signed_in": _signed_in,
	}
	JavaScriptBridge.eval("window.__gdClerkE2E.result = " + JSON.stringify(payload) + ";")
	_busy = false

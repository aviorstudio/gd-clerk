class_name SessionState
extends RefCounted

var signed_in: bool = false
var status: String = "unavailable"
var protected_actions_blocked: bool = true

static func from_json(raw: String) -> SessionState:
	var state := SessionState.new()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		return state
	var data: Dictionary = parsed
	state.signed_in = bool(data.get("signed_in", false))
	state.status = str(data.get("status", "unavailable"))
	state.protected_actions_blocked = bool(data.get("protected_actions_blocked", true))
	return state

func to_dictionary() -> Dictionary:
	return {
		"signed_in": signed_in,
		"status": status,
		"protected_actions_blocked": protected_actions_blocked,
	}

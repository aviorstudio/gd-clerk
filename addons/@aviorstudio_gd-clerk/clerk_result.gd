class_name ClerkResult
extends RefCounted

var state: String = ""
var error_key: String = ""
var message: String = ""
var token: String = ""
var retryable: bool = false

static func unavailable() -> ClerkResult:
	var result := ClerkResult.new()
	result.state = "UNAVAILABLE"
	result.message = "Sign-in is unavailable on this platform."
	return result

static func error(error_key: String, message: String) -> ClerkResult:
	var result := ClerkResult.new()
	result.state = "ERROR"
	result.error_key = error_key
	result.message = message
	return result

static func from_json(raw: String, allow_token: bool = false) -> ClerkResult:
	var result := ClerkResult.new()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		result.state = "ERROR"
		result.error_key = "UNKNOWN"
		result.message = "The request failed."
		return result
	var data: Dictionary = parsed
	result.state = str(data.get("state", ""))
	result.error_key = str(data.get("error_key", ""))
	result.message = str(data.get("message", ""))
	result.retryable = bool(data.get("retryable", false))
	if allow_token and data.has("token"):
		result.token = str(data.get("token", ""))
	if result.message.length() > 180:
		result.message = result.message.substr(0, 180)
	return result

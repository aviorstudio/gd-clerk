class_name ClerkPolicy
extends RefCounted

static func limits() -> Dictionary:
	var text := FileAccess.get_file_as_string("res://addons/@aviorstudio_gd-clerk/limits.json")
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return {}
	return parsed

static func decode_publishable_key_host(key: String) -> String:
	if key.is_empty() or key.begins_with("sk_"):
		return ""
	var parts := key.split("_")
	if parts.size() != 3 or parts[0] != "pk":
		return ""
	if parts[1] != "test" and parts[1] != "live":
		return ""
	var decoded := _b64_decode(parts[2])
	if decoded.is_empty() or not decoded.ends_with("$"):
		return ""
	var host := decoded.substr(0, decoded.length() - 1)
	if host.is_empty() or host.contains("$") or host.contains("/") or not host.contains("."):
		return ""
	return host.to_lower()

static func validate_config(config: ClerkConfig, origin: String) -> String:
	var bounds: Dictionary = limits()
	var max_key := int(bounds.get("max_key_length", 512))
	var max_fapi := int(bounds.get("max_fapi_length", 256))
	var max_origins := int(bounds.get("max_origins", 32))
	var max_origin := int(bounds.get("max_origin_length", 200))
	if config == null:
		return "Configuration is invalid."
	var key := config.publishable_key
	if key.begins_with("sk_") or key.length() < 20 or key.length() > max_key:
		return "Configuration is invalid."
	var host := decode_publishable_key_host(key)
	if host.is_empty():
		return "Configuration is invalid."
	var fapi := config.frontend_api
	if fapi.length() > max_fapi or not fapi.begins_with("https://"):
		return "Configuration is invalid."
	var rest := fapi.substr(8)
	if rest.is_empty() or rest.contains("/") or rest.contains("?") or rest.contains("#"):
		return "Configuration is invalid."
	if rest.to_lower() != host:
		return "Configuration is invalid."
	if config.allowed_origins.is_empty() or config.allowed_origins.size() > max_origins:
		return "Configuration is invalid."
	var allowed := false
	for item in config.allowed_origins:
		var origin_item := str(item)
		if origin_item.is_empty() or origin_item.length() > max_origin:
			return "Configuration is invalid."
		if origin_item.contains("/") and not origin_item.begins_with("http://") and not origin_item.begins_with("https://"):
			return "Configuration is invalid."
		if not origin_item.begins_with("http://") and not origin_item.begins_with("https://"):
			return "Configuration is invalid."
		var body := origin_item.trim_prefix("https://").trim_prefix("http://")
		if body.is_empty() or body.contains("/") or body.contains("?") or body.contains("#"):
			return "Configuration is invalid."
		if origin_item == origin:
			allowed = true
	if origin.is_empty() or not allowed:
		return "Configuration is invalid."
	return ""

static func validate_email(email: String) -> bool:
	var bounds: Dictionary = limits()
	var max_len := int(bounds.get("max_email_length", 254))
	var value := email.strip_edges()
	if value.length() < 3 or value.length() > max_len:
		return false
	if value.contains(" ") or value.contains("\t") or value.contains("\n"):
		return false
	var at := value.find("@")
	if at <= 0 or value.rfind("@") != at:
		return false
	var domain := value.substr(at + 1)
	if domain.find(".") <= 0 or domain.ends_with("."):
		return false
	return true

static func validate_code(code: String) -> bool:
	var bounds: Dictionary = limits()
	var min_len := int(bounds.get("min_code_length", 4))
	var max_len := int(bounds.get("max_code_length", 12))
	var value := code.strip_edges()
	if value.length() < min_len or value.length() > max_len:
		return false
	for i in value.length():
		var ch := value.unicode_at(i)
		if ch < 48 or ch > 57:
			return false
	return true

static func _b64_decode(value: String) -> String:
	var padded := value
	while padded.length() % 4 != 0:
		padded += "="
	return Marshalls.base64_to_utf8(padded)

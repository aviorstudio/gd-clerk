class_name ClerkConfig
extends RefCounted

var publishable_key: String = ""
var frontend_api: String = ""
var allowed_origins: PackedStringArray = PackedStringArray()

func to_dictionary() -> Dictionary:
	return {
		"publishable_key": publishable_key,
		"frontend_api": frontend_api,
		"allowed_origins": Array(allowed_origins),
	}

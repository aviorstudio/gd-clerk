class_name ClerkConfig
extends RefCounted

var publishable_key: String = ""
var frontend_api: String = ""
var allowed_origins: PackedStringArray = PackedStringArray()
## Consumer-owned remote revoke. Called once with an ephemeral session JWT and a one-shot ack Callable. Never serialized.
var revoke_session: Callable = Callable()

func to_dictionary() -> Dictionary:
	return {
		"publishable_key": publishable_key,
		"frontend_api": frontend_api,
		"allowed_origins": Array(allowed_origins),
	}

class_name ClerkConfig
extends Resource

@export var publishable_key: String = ""
@export var frontend_api: String = ""
## Web only. Native builds ignore this list.
@export var allowed_origins: PackedStringArray = PackedStringArray()
## Consumer-owned remote revoke. Called once with an ephemeral session JWT and a one-shot ack Callable. Never serialized.
var revoke_session: Callable = Callable()
## Native only. Holds the Clerk client token for this device. Null keeps it in
## process memory. A consumer supplies a credential adapter in the
## @aviorstudio/gd-session shape, backed by the OS keyring, to restore the
## session across launches: read_value(key) and write_value(key, value) each
## return an object with `status` (0 is OK, 1 is NOT_FOUND) and `value`. It is
## matched by those methods, never by class, because the consumer's copy of
## gd-session may not be this addon's copy. Never serialized.
var credential_store: RefCounted = null

func to_dictionary() -> Dictionary:
	return {
		"publishable_key": publishable_key,
		"frontend_api": frontend_api,
		"allowed_origins": Array(allowed_origins),
	}

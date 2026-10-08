class_name ClerkConfig
extends Resource

@export var publishable_key: String = ""
@export var frontend_api: String = ""
## Web only. Native builds ignore this list.
@export var allowed_origins: PackedStringArray = PackedStringArray()
## Consumer-owned remote revoke. Called once with an ephemeral session JWT and a one-shot ack Callable. Never serialized.
var revoke_session: Callable = Callable()
## Native only. Holds the Clerk client token for this device. Null keeps it in
## process memory; a consumer supplies a ClerkCredentialStore subclass backed by
## the OS keyring to restore the session across launches. Never serialized.
var credential_store: ClerkCredentialStore = null

func to_dictionary() -> Dictionary:
	return {
		"publishable_key": publishable_key,
		"frontend_api": frontend_api,
		"allowed_origins": Array(allowed_origins),
	}

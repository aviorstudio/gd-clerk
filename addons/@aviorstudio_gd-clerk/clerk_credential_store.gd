class_name ClerkCredentialStore
extends RefCounted
## Native-only store for the Clerk client token that the Frontend API issues to
## this device. The default keeps values in process memory only. A consumer
## subclasses it and overrides both methods to persist the value in the OS
## keyring. The addon never writes secrets to disk itself and never serializes
## this object.

var _values: Dictionary = {}

## Returns the stored value for key, or "" when none is stored.
func read_value(key: String) -> String:
	return str(_values.get(key, ""))

## Stores value under key. An empty value clears the entry. Returns false when
## the store could not persist the value.
func write_value(key: String, value: String) -> bool:
	if value.is_empty():
		_values.erase(key)
	else:
		_values[key] = value
	return true

extends RefCounted
## Native (non-web) Clerk Frontend API backend.
##
## GdClerk owns one instance and hands it the same public calls the web bridge
## serves. Requests go over HTTPS to the Frontend API host encoded by the
## publishable key with HTTPRequest children of the GdClerk node. Results are
## delivered through GdClerk's relays as the same JSON payload shape the web
## bridge emits, so consumers see identical states, error keys and phases.
##
## The publishable key is never sent. The only credential this backend holds is
## the Frontend API client token, which it keeps in the consumer's
## ClerkCredentialStore (process memory by default).

const API_VERSION := "2026-05-12"
const ADDON_VERSION := "0.2.0"
const TOKEN_KEY := "client_token"
const MAX_BODY_BYTES := 262144
const MAX_MESSAGE_LENGTH := 180
const MAX_MIN_VALIDITY := 120
const CODES_PATH := "res://addons/@aviorstudio_gd-clerk/observed_error_codes.json"

const MESSAGES := {
	"CODE_SENT": "Verification code sent.",
	"AUTHENTICATED": "Signed in.",
	"NEEDS_MORE_STEPS": "Additional verification is required and is not supported.",
	"INVALID_CODE": "The verification code is invalid.",
	"ACCOUNT_NOT_FOUND": "No account uses that email address.",
	"INVALID_EMAIL": "The email address is not valid.",
	"EXPIRED_CODE": "The verification code has expired.",
	"RESEND_COOLDOWN": "Wait before requesting another code.",
	"RATE_LIMIT": "Too many requests. Try again later.",
	"NETWORK": "Network error. Try again.",
	"CONFIG": "Configuration is invalid.",
	"UNSUPPORTED_CHALLENGE": "This verification step is not supported.",
	"SESSION_EXPIRED": "Session is not available.",
	"CANCELLED": "The request was cancelled.",
	"UNKNOWN": "The request failed.",
	"SIGNED_OUT": "Signed out.",
	"SIGN_OUT_FAILED": "Sign-out could not be confirmed. Protected actions are blocked.",
	"CONFIGURED": "Configured.",
	"SESSION_PRESENT": "A session is already present.",
	"FLOW_BUSY": "An email code request is already in progress.",
	"NO_FLOW": "No email code request is in progress.",
	"VALIDITY": "min_validity_seconds is out of range.",
	"PROTECTED_BLOCKED": "Protected actions are blocked until sign-out is confirmed.",
	"NOT_IN_TREE": "GdClerk must be inside the scene tree.",
	"NATIVE_API_DISABLED": "The Clerk Native API is disabled for this instance. Enable it in the Clerk dashboard.",
	"IDENTIFIER_EXISTS": "An account already uses that email address.",
	"USER_LOCKED": "This account is locked.",
	"RESPONSE_TOO_LARGE": "The response was too large.",
}

var owner: Node = null
var timeout_ms: int = 30000
var resend_cooldown_ms: int = 30000

var _config: ClerkConfig = null
var _configured: bool = false
var _base_url: String = ""
var _store: ClerkCredentialStore = null
var _memory_store: ClerkCredentialStore = ClerkCredentialStore.new()
var _client_token: String = ""
var _sessions: Array = []
var _last_active_session_id: String = ""
var _active_session_id: String = ""
var _active_subject: String = ""
var _flow: Dictionary = {}
var _flow_request: Node = null
var _cached_jwt: String = ""
var _latched: bool = false
var _sign_out_inflight: bool = false
var _sign_out_waiters: Array = []
var _mint_inflight: bool = false
var _mint_waiters: Array = []
var _revoke_attempt: int = 0
var _session_generation: int = 0
var _codes: Dictionary = {}
var _native_codes: Dictionary = {}


func _init() -> void:
	var bounds: Dictionary = ClerkPolicy.limits()
	timeout_ms = int(bounds.get("network_timeout_ms", 30000))
	resend_cooldown_ms = int(bounds.get("resend_cooldown_ms", 30000))
	var text := FileAccess.get_file_as_string(CODES_PATH)
	var parsed: Variant = parse_json(text)
	if typeof(parsed) == TYPE_DICTIONARY:
		var data: Dictionary = parsed
		if typeof(data.get("codes")) == TYPE_DICTIONARY:
			_codes = data.get("codes")
		if typeof(data.get("native_codes")) == TYPE_DICTIONARY:
			_native_codes = data.get("native_codes")


# --- public entry points (called by GdClerk) ---------------------------------

func configure(config: ClerkConfig, relay: RefCounted) -> void:
	var problem := ClerkPolicy.validate_native_config(config)
	if problem != "":
		_deliver(relay, _payload("ERROR", "CONFIG", problem))
		return
	if not _owner_ready():
		_deliver(relay, _payload("ERROR", "CONFIG", MESSAGES.NOT_IN_TREE))
		return
	_config = config
	_base_url = config.frontend_api.strip_edges()
	_store = config.credential_store if config.credential_store != null else _memory_store
	_client_token = _sanitize_token(_store.read_value(TOKEN_KEY))
	if _client_token.is_empty():
		_configured = true
		_clear_session()
		_emit_session()
		_deliver(relay, _payload("CONFIGURED", "", MESSAGES.CONFIGURED, {"phase": "native_signed_out"}))
		return
	var generation := _session_generation
	_send(HTTPClient.METHOD_GET, "/v1/client", {}, false, func(reply: Dictionary) -> void:
		if not _owner_alive():
			return
		if generation != _session_generation:
			# Another reply moved the session while the restore was in flight.
			# Report the current state instead of applying a stale snapshot.
			_configured = true
			var current_phase := "native_restored" if _active_session_id != "" else "native_signed_out"
			_emit_session()
			_deliver(relay, _payload("CONFIGURED", "", MESSAGES.CONFIGURED, {"phase": current_phase}))
			return
		if reply.transport_ok and (reply.status == 401 or reply.status == 404):
			_forget_client_token()
			_configured = true
			_clear_session()
			_emit_session()
			_deliver(relay, _payload("CONFIGURED", "", MESSAGES.CONFIGURED, {"phase": "native_token_rejected"}))
			return
		if not reply.error.is_empty():
			_deliver(relay, reply.error)
			return
		var client: Variant = reply.json.get("response")
		if typeof(client) != TYPE_DICTIONARY:
			_deliver(relay, _payload("ERROR", "UNKNOWN", MESSAGES.UNKNOWN))
			return
		_absorb_client(client)
		_configured = true
		var restored := _select_restored_session()
		_emit_session()
		var phase := "native_restored" if restored else "native_signed_out"
		_deliver(relay, _payload("CONFIGURED", "", MESSAGES.CONFIGURED, {"phase": phase}))
	)


func begin_email_code(email: String, mode: int, relay: RefCounted) -> void:
	if not _require_ready(relay) or _reject_if_latched(relay):
		return
	if _flow_request != null or not _flow.is_empty():
		_deliver(relay, _payload("ERROR", "UNKNOWN", MESSAGES.FLOW_BUSY))
		return
	if _active_session_id != "":
		_deliver(relay, _payload("ERROR", "UNKNOWN", MESSAGES.SESSION_PRESENT))
		return
	var generation: int = owner._generation
	if mode == 1:
		_flow_request = _send(HTTPClient.METHOD_POST, "/v1/client/sign_ups", {"email_address": email}, true, func(reply: Dictionary) -> void:
			_flow_request = null
			if not _flow_alive(generation):
				return
			if not reply.error.is_empty():
				_deliver(relay, reply.error)
				return
			var sign_up: Variant = reply.json.get("response")
			if typeof(sign_up) != TYPE_DICTIONARY or str(sign_up.get("id", "")).is_empty():
				_deliver(relay, _payload("ERROR", "UNKNOWN", MESSAGES.UNKNOWN))
				return
			_flow = {"mode": "SIGN_UP", "id": str(sign_up.get("id")), "email_address_id": "", "sent_at": 0}
			_prepare_code(relay, generation)
		)
		return
	_flow_request = _send(HTTPClient.METHOD_POST, "/v1/client/sign_ins", {"identifier": email}, true, func(reply: Dictionary) -> void:
		_flow_request = null
		if not _flow_alive(generation):
			return
		if not reply.error.is_empty():
			_deliver(relay, reply.error)
			return
		var sign_in: Variant = reply.json.get("response")
		if typeof(sign_in) != TYPE_DICTIONARY or str(sign_in.get("id", "")).is_empty():
			_deliver(relay, _payload("ERROR", "UNKNOWN", MESSAGES.UNKNOWN))
			return
		var status := str(sign_in.get("status", ""))
		if status != "needs_first_factor":
			_deliver(relay, _payload("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS, {"phase": "status_challenge"}))
			return
		var email_address_id := _email_code_factor(sign_in.get("supported_first_factors"))
		if email_address_id.is_empty():
			_deliver(relay, _payload("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS, {"phase": "missing_factor"}))
			return
		_flow = {"mode": "SIGN_IN", "id": str(sign_in.get("id")), "email_address_id": email_address_id, "sent_at": 0}
		_prepare_code(relay, generation)
	)


func complete_email_code(code: String, relay: RefCounted) -> void:
	if not _require_ready(relay) or _reject_if_latched(relay):
		return
	if _flow.is_empty():
		_deliver(relay, _payload("ERROR", "CANCELLED", MESSAGES.NO_FLOW))
		return
	if _flow_request != null:
		_deliver(relay, _payload("ERROR", "UNKNOWN", MESSAGES.FLOW_BUSY))
		return
	var generation: int = owner._generation
	var sign_up := str(_flow.get("mode", "")) == "SIGN_UP"
	var path := "/v1/client/sign_ups/%s/attempt_verification" % str(_flow.get("id", "")) if sign_up else "/v1/client/sign_ins/%s/attempt_first_factor" % str(_flow.get("id", ""))
	_flow_request = _send(HTTPClient.METHOD_POST, path, {"strategy": "email_code", "code": code.strip_edges()}, true, func(reply: Dictionary) -> void:
		_flow_request = null
		if not _flow_alive(generation):
			return
		if not reply.error.is_empty():
			_deliver(relay, reply.error)
			return
		var resource: Variant = reply.json.get("response")
		if typeof(resource) != TYPE_DICTIONARY:
			_deliver(relay, _payload("ERROR", "UNKNOWN", MESSAGES.UNKNOWN))
			return
		var status := str(resource.get("status", ""))
		var created := str(resource.get("created_session_id", ""))
		if status != "complete" or created.is_empty():
			var phase := "missing_factor" if sign_up else "status_challenge"
			_flow = {}
			_deliver(relay, _payload("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS, {"phase": phase}))
			return
		var session := _session_by_id(created)
		if session.is_empty() or str(session.get("status", "")) != "active":
			_flow = {}
			_deliver(relay, _payload("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS, {"phase": "status_challenge"}))
			return
		_flow = {}
		_set_active_session(created, str(session.get("user_id", "")))
		_emit_session()
		_deliver(relay, _payload("AUTHENTICATED", "", MESSAGES.AUTHENTICATED))
	)


func resend_email_code(relay: RefCounted) -> void:
	if not _require_ready(relay) or _reject_if_latched(relay):
		return
	if _flow.is_empty():
		_deliver(relay, _payload("ERROR", "CANCELLED", MESSAGES.NO_FLOW))
		return
	if _flow_request != null:
		_deliver(relay, _payload("ERROR", "UNKNOWN", MESSAGES.FLOW_BUSY))
		return
	if Time.get_ticks_msec() - int(_flow.get("sent_at", 0)) < resend_cooldown_ms:
		_deliver(relay, _payload("ERROR", "RESEND_COOLDOWN", MESSAGES.RESEND_COOLDOWN))
		return
	_prepare_code(relay, owner._generation)


func cancel_email_code() -> void:
	_flow = {}
	if _flow_request != null:
		var node := _flow_request
		_flow_request = null
		_abort_request(node)


func get_session_token(min_validity_seconds: int, relay: RefCounted) -> void:
	if not _require_ready(relay):
		return
	if min_validity_seconds < 0 or min_validity_seconds > MAX_MIN_VALIDITY:
		_deliver(relay, _payload("ERROR", "CONFIG", MESSAGES.VALIDITY))
		return
	if _reject_if_latched(relay):
		return
	if _active_session_id.is_empty():
		_deliver(relay, _payload("ERROR", "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED))
		return
	if _token_meets(_cached_jwt, min_validity_seconds):
		_deliver(relay, _payload("TOKEN", "", "", {"token": _cached_jwt}))
		return
	_mint_waiters.append({"relay": relay, "min": min_validity_seconds})
	if _mint_inflight:
		return
	_mint_inflight = true
	var sid := _active_session_id
	var generation := _session_generation
	_send(HTTPClient.METHOD_POST, "/v1/client/sessions/%s/tokens" % sid, {}, false, func(reply: Dictionary) -> void:
		_mint_inflight = false
		var waiters: Array = _mint_waiters
		_mint_waiters = []
		if not _owner_alive():
			return
		var jwt := ""
		if reply.error.is_empty():
			jwt = str(reply.json.get("jwt", ""))
		var payload: Dictionary = {}
		if not reply.error.is_empty():
			payload = reply.error
			if str(payload.get("error_key", "")) == "SESSION_EXPIRED" and generation == _session_generation and sid == _active_session_id:
				_clear_session()
				_emit_session()
		elif jwt.is_empty():
			payload = _payload("ERROR", "UNKNOWN", MESSAGES.UNKNOWN)
		elif generation == _session_generation and sid == _active_session_id:
			_cached_jwt = jwt
		else:
			payload = _payload("ERROR", "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED)
		for waiter in waiters:
			if payload.is_empty():
				if _token_meets(jwt, int(waiter.get("min", 0))):
					_deliver(waiter.get("relay"), _payload("TOKEN", "", "", {"token": jwt}))
				else:
					_deliver(waiter.get("relay"), _payload("ERROR", "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED))
			else:
				_deliver(waiter.get("relay"), payload)
			if not _owner_alive():
				return
	)


func sign_out(relay: RefCounted) -> void:
	if not _require_ready(relay):
		return
	_sign_out_waiters.append(relay)
	if _sign_out_inflight:
		return
	_sign_out_inflight = true
	_latched = true
	_emit_session()
	if not _owner_alive():
		return
	if not owner._revoke_session.is_valid():
		_finish_sign_out(_failed_revoke("CONFIG", "revoke_missing"))
		return
	var sid := _active_session_id
	var sub := _active_subject
	if sid.is_empty() or sub.is_empty():
		_finish_sign_out(_failed_revoke("UNKNOWN", "revoke_no_session"))
		return
	var generation := _session_generation
	_send(HTTPClient.METHOD_POST, "/v1/client/sessions/%s/tokens" % sid, {}, false, func(reply: Dictionary) -> void:
		if not _owner_alive():
			return
		if not reply.error.is_empty():
			var key := "NETWORK" if str(reply.error.get("error_key", "")) == "NETWORK" else "UNKNOWN"
			_finish_sign_out(_failed_revoke(key, "revoke_no_token"))
			return
		var jwt := str(reply.json.get("jwt", ""))
		if jwt.is_empty():
			_finish_sign_out(_failed_revoke("UNKNOWN", "revoke_no_token"))
			return
		if generation != _session_generation or sid != _active_session_id:
			_finish_sign_out(_failed_revoke("UNKNOWN", "revoke_stale"))
			return
		_request_revoke_ack(jwt, sid, sub, generation)
	)


func is_configured() -> bool:
	return _configured


func session_state() -> Dictionary:
	var blocked := _latched
	var active := _active_session_id != "" and not blocked
	var status := "signed_out"
	if not _configured:
		status = "unavailable"
	elif active:
		status = "signed_in"
	elif blocked and _active_session_id != "":
		status = "sign_out_unconfirmed"
	return {"signed_in": active, "status": status, "protected_actions_blocked": blocked}


# --- sign-in / sign-up helpers ------------------------------------------------

func _prepare_code(relay: RefCounted, generation: int) -> void:
	var sign_up := str(_flow.get("mode", "")) == "SIGN_UP"
	var path := "/v1/client/sign_ups/%s/prepare_verification" % str(_flow.get("id", "")) if sign_up else "/v1/client/sign_ins/%s/prepare_first_factor" % str(_flow.get("id", ""))
	var form := {"strategy": "email_code"}
	if not sign_up:
		form["email_address_id"] = str(_flow.get("email_address_id", ""))
	_flow_request = _send(HTTPClient.METHOD_POST, path, form, true, func(reply: Dictionary) -> void:
		_flow_request = null
		if not _flow_alive(generation):
			return
		if not reply.error.is_empty():
			if int(_flow.get("sent_at", 0)) == 0:
				# The first prepare failed: no code is pending, so a retried
				# begin must start over. A failed resend keeps the attempt.
				_flow = {}
			_deliver(relay, reply.error)
			return
		_flow["sent_at"] = Time.get_ticks_msec()
		_deliver(relay, _payload("CODE_SENT", "", MESSAGES.CODE_SENT))
	)


func _email_code_factor(factors: Variant) -> String:
	if typeof(factors) != TYPE_ARRAY:
		return ""
	for item in factors:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		if str(item.get("strategy", "")) == "email_code":
			var id := str(item.get("email_address_id", ""))
			if not id.is_empty():
				return id
	return ""


func _flow_alive(generation: int) -> bool:
	return _owner_alive() and generation == owner._generation


# --- sign-out helpers ---------------------------------------------------------

func _request_revoke_ack(jwt: String, sid: String, sub: String, generation: int) -> void:
	_revoke_attempt += 1
	var attempt := _revoke_attempt
	var settled := [false]
	if not _owner_ready():
		_finish_sign_out(_failed_revoke("UNKNOWN", "revoke_no_session"))
		return
	var timer := owner.get_tree().create_timer(float(timeout_ms) / 1000.0, true, false, true)
	timer.timeout.connect(func() -> void:
		if settled[0] or not _owner_alive():
			return
		settled[0] = true
		_finish_sign_out(_failed_revoke("UNKNOWN", "revoke_timeout"))
	)
	var ack := func(payload: Variant) -> void:
		if settled[0] or attempt != _revoke_attempt or not _owner_alive():
			return
		settled[0] = true
		if generation != _session_generation or sid != _active_session_id:
			_finish_sign_out(_failed_revoke("UNKNOWN", "revoke_stale"))
			return
		var parsed := _parse_revoke_ack(payload)
		if parsed.is_empty() or str(parsed.get("session_id", "")) != sid or str(parsed.get("subject", "")) != sub:
			_finish_sign_out(_failed_revoke("UNKNOWN", "revoke_rejected"))
			return
		_remove_session(sid, generation)
	owner._revoke_session.call(jwt, ack)


func _remove_session(sid: String, generation: int) -> void:
	_send(HTTPClient.METHOD_POST, "/v1/client/sessions/%s/remove" % sid, {}, false, func(reply: Dictionary) -> void:
		if not _owner_alive():
			return
		var already_gone: bool = not reply.error.is_empty() and str(reply.error.get("error_key", "")) == "SESSION_EXPIRED"
		if not reply.error.is_empty() and not already_gone:
			var key := "NETWORK" if str(reply.error.get("error_key", "")) == "NETWORK" else "UNKNOWN"
			_finish_sign_out(_failed_revoke(key, "deactivate_failed"))
			return
		if already_gone:
			# The Frontend API no longer knows the session; the error reply carries
			# no client snapshot, so drop the stale local entry.
			_drop_session(sid)
		if generation == _session_generation and sid == _active_session_id:
			_clear_session()
		var remaining := _session_by_id(sid)
		if not remaining.is_empty() and str(remaining.get("status", "")) == "active":
			_finish_sign_out(_failed_revoke("UNKNOWN", "deactivate_failed"))
			return
		_latched = false
		_flow = {}
		_emit_session()
		_finish_sign_out(_payload("SIGNED_OUT", "", MESSAGES.SIGNED_OUT, {"phase": "native_session_removed"}))
	)


func _parse_revoke_ack(raw: Variant) -> Dictionary:
	var data: Variant = raw
	if typeof(raw) == TYPE_STRING:
		data = parse_json(raw)
	if typeof(data) != TYPE_DICTIONARY:
		return {}
	var dict: Dictionary = data
	if dict.size() != 4:
		return {}
	var confirmed: Variant = dict.get("remote_confirmed")
	if str(dict.get("schema", "")) != "gd-clerk.revoke.v1" or typeof(confirmed) != TYPE_BOOL or not confirmed:
		return {}
	var session_id: Variant = dict.get("session_id")
	var subject: Variant = dict.get("subject")
	if typeof(session_id) != TYPE_STRING or session_id == "" or typeof(subject) != TYPE_STRING or subject == "":
		return {}
	return {"session_id": session_id, "subject": subject}


func _failed_revoke(error_key: String, phase: String) -> Dictionary:
	_emit_session()
	return _payload("SIGN_OUT_FAILED", error_key, MESSAGES.SIGN_OUT_FAILED, {"retryable": true, "phase": phase})


func _finish_sign_out(payload: Dictionary) -> void:
	_sign_out_inflight = false
	var waiters: Array = _sign_out_waiters
	_sign_out_waiters = []
	for relay in waiters:
		_deliver(relay, payload)
		if not _owner_alive():
			return


# --- client / session state ---------------------------------------------------

func _absorb_client(client: Variant) -> void:
	if typeof(client) != TYPE_DICTIONARY:
		return
	var data: Dictionary = client
	var raw_sessions: Variant = data.get("sessions")
	var sessions: Array = []
	if typeof(raw_sessions) == TYPE_ARRAY:
		for item in raw_sessions:
			if typeof(item) != TYPE_DICTIONARY:
				continue
			var user: Variant = item.get("user")
			var user_id := ""
			if typeof(user) == TYPE_DICTIONARY:
				user_id = str(user.get("id", ""))
			sessions.append({"id": str(item.get("id", "")), "status": str(item.get("status", "")), "user_id": user_id})
	_sessions = sessions
	_last_active_session_id = str(data.get("last_active_session_id", "")) if data.get("last_active_session_id") != null else ""
	if _active_session_id != "":
		var current := _session_by_id(_active_session_id)
		if current.is_empty() or str(current.get("status", "")) != "active":
			_clear_session()
			_emit_session()


func _select_restored_session() -> bool:
	var chosen: Dictionary = {}
	if _last_active_session_id != "":
		var preferred := _session_by_id(_last_active_session_id)
		if not preferred.is_empty() and str(preferred.get("status", "")) == "active":
			chosen = preferred
	if chosen.is_empty():
		var active: Array = []
		for item in _sessions:
			if str(item.get("status", "")) == "active":
				active.append(item)
		if active.size() == 1:
			chosen = active[0]
	if chosen.is_empty() or str(chosen.get("user_id", "")).is_empty():
		_clear_session()
		return false
	_set_active_session(str(chosen.get("id", "")), str(chosen.get("user_id", "")))
	return true


func _session_by_id(sid: String) -> Dictionary:
	if sid.is_empty():
		return {}
	for item in _sessions:
		if str(item.get("id", "")) == sid:
			return item
	return {}


func _drop_session(sid: String) -> void:
	var kept: Array = []
	for item in _sessions:
		if str(item.get("id", "")) != sid:
			kept.append(item)
	_sessions = kept


func _set_active_session(sid: String, subject: String) -> void:
	if sid != _active_session_id:
		_session_generation += 1
	_active_session_id = sid
	_active_subject = subject
	_cached_jwt = ""


func _clear_session() -> void:
	if _active_session_id != "":
		_session_generation += 1
	_active_session_id = ""
	_active_subject = ""
	_cached_jwt = ""


func _emit_session() -> void:
	if not _owner_alive():
		return
	owner._on_session_payload(JSON.stringify(session_state()))


func _forget_client_token() -> void:
	_client_token = ""
	if _store != null:
		_store.write_value(TOKEN_KEY, "")


func _remember_client_token(token: String) -> void:
	_client_token = token
	if _store != null:
		_store.write_value(TOKEN_KEY, token)


func _sanitize_token(value: String) -> String:
	var token := value.strip_edges()
	if token.is_empty() or token.length() > 4096 or token.to_lower() == "bearer":
		return ""
	for i in token.length():
		var ch := token.unicode_at(i)
		if ch <= 32 or ch >= 127:
			return ""
	return token


# --- JWT helpers --------------------------------------------------------------

func _token_exp(jwt: String) -> int:
	var parts := jwt.split(".")
	if parts.size() != 3:
		return 0
	var payload := parts[1].replace("-", "+").replace("_", "/")
	if payload.is_empty() or payload.length() % 4 == 1 or not _is_base64(payload):
		return 0
	while payload.length() % 4 != 0:
		payload += "="
	var decoded := Marshalls.base64_to_utf8(payload)
	var parsed: Variant = parse_json(decoded)
	if typeof(parsed) != TYPE_DICTIONARY:
		return 0
	var exp: Variant = parsed.get("exp")
	if typeof(exp) != TYPE_FLOAT and typeof(exp) != TYPE_INT:
		return 0
	return int(exp)


static func _is_base64(value: String) -> bool:
	for i in value.length():
		var ch := value.unicode_at(i)
		var ok: bool = (ch >= 48 and ch <= 57) or (ch >= 65 and ch <= 90) or (ch >= 97 and ch <= 122) or ch == 43 or ch == 47
		if not ok:
			return false
	return true


## Parses JSON without logging engine errors for malformed input.
static func parse_json(text: String) -> Variant:
	if text.is_empty():
		return null
	var json := JSON.new()
	if json.parse(text) != OK:
		return null
	return json.data


func _token_meets(jwt: String, min_validity: int) -> bool:
	if jwt.is_empty():
		return false
	var exp := _token_exp(jwt)
	if exp <= 0:
		return false
	return exp - int(Time.get_unix_time_from_system()) >= min_validity


# --- guards and delivery ------------------------------------------------------

func _require_ready(relay: RefCounted) -> bool:
	if not _configured or _config == null:
		_deliver(relay, _payload("ERROR", "CONFIG", MESSAGES.CONFIG))
		return false
	if not _owner_ready():
		_deliver(relay, _payload("ERROR", "CONFIG", MESSAGES.NOT_IN_TREE))
		return false
	return true


func _reject_if_latched(relay: RefCounted) -> bool:
	if not _latched:
		return false
	_deliver(relay, _payload("SIGN_OUT_FAILED", "UNKNOWN", MESSAGES.PROTECTED_BLOCKED, {"retryable": true, "phase": "sign_out_latched"}))
	return true


func _owner_alive() -> bool:
	return owner != null and is_instance_valid(owner)


func _owner_ready() -> bool:
	return _owner_alive() and owner.is_inside_tree()


func _payload(state: String, error_key: String, message: String, extra: Dictionary = {}) -> Dictionary:
	var out := {"state": state, "error_key": error_key, "message": sanitize_message(message)}
	if extra.get("retryable", false) == true:
		out["retryable"] = true
	var phase := str(extra.get("phase", ""))
	if phase != "":
		out["phase"] = phase
	if state == "TOKEN" and extra.has("token"):
		out["state"] = "AUTHENTICATED"
		out["token"] = str(extra.get("token"))
	return out


func _deliver(relay: RefCounted, payload: Dictionary) -> void:
	if relay == null:
		return
	relay.deliver(JSON.stringify(payload))


## Removes email addresses, JWTs, publishable keys and long digit runs from a
## message and caps its length, mirroring the web bridge.
static func sanitize_message(message: String) -> String:
	var text := message
	var email := RegEx.create_from_string("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
	text = email.sub(text, "[redacted]", true)
	var jwt := RegEx.create_from_string("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
	text = jwt.sub(text, "[redacted]", true)
	var key := RegEx.create_from_string("\\b(?:pk|sk)_(?:test|live)_[A-Za-z0-9+/=_-]+")
	text = key.sub(text, "[redacted]", true)
	var digits := RegEx.create_from_string("\\b\\d{4,}\\b")
	text = digits.sub(text, "[redacted]", true)
	if text.length() > MAX_MESSAGE_LENGTH:
		text = text.substr(0, MAX_MESSAGE_LENGTH)
	return text


# --- HTTP ---------------------------------------------------------------------

## Sends one Frontend API request. on_reply receives a Dictionary with
## transport_ok, status, json (Dictionary, possibly empty) and error (an empty
## Dictionary on success, else a result payload). The request node is a child of
## the owner; it frees itself after one completion.
func _send(method: int, path: String, form: Dictionary, cancellable: bool, on_reply: Callable) -> Node:
	var request := _DeadlineRequest.new()
	request.use_threads = false
	request.timeout = 0.0
	request.max_redirects = 0
	request.body_size_limit = MAX_BODY_BYTES
	request.accept_gzip = true
	request.cancellable = cancellable
	var headers := PackedStringArray([
		"Clerk-API-Version: " + API_VERSION,
		"Accept: application/json",
		"x-mobile: 1",
		"User-Agent: gd-clerk/%s (Godot %s; %s)" % [ADDON_VERSION, Engine.get_version_info().get("string", ""), OS.get_name()],
	])
	if not _client_token.is_empty():
		headers.append("Authorization: " + _client_token)
	var body := ""
	if method == HTTPClient.METHOD_POST:
		headers.append("Content-Type: application/x-www-form-urlencoded")
		body = _form_encode(form)
		if body.is_empty():
			# Godot omits Content-Length for an empty body; declare it for proxies.
			headers.append("Content-Length: 0")
	var url := _base_url + path + "?_is_native=true"
	if not _owner_ready():
		# A node outside the tree never processes the request; fail now.
		request.free()
		on_reply.call(_classify(HTTPRequest.RESULT_CANT_CONNECT, 0, PackedStringArray(), PackedByteArray()))
		return null
	owner.add_child(request)
	request.on_done = func(result: int, status: int, response_headers: PackedStringArray, raw: PackedByteArray) -> void:
		if not _owner_alive():
			return
		on_reply.call(_classify(result, status, response_headers, raw))
	request.request_completed.connect(request.finish)
	request.arm(timeout_ms)
	var err := request.request(url, headers, method, body)
	if err != OK:
		request.finish(HTTPRequest.RESULT_CANT_CONNECT, 0, PackedStringArray(), PackedByteArray())
		return null
	return request


func _abort_request(node: Node) -> void:
	if node == null or not is_instance_valid(node):
		return
	node.abort()


func _classify(result: int, status: int, headers: PackedStringArray, raw: PackedByteArray) -> Dictionary:
	var reply := {"transport_ok": false, "status": status, "json": {}, "error": {}}
	if result == HTTPRequest.RESULT_BODY_SIZE_LIMIT_EXCEEDED:
		reply.error = _payload("ERROR", "UNKNOWN", MESSAGES.RESPONSE_TOO_LARGE)
		return reply
	if result != HTTPRequest.RESULT_SUCCESS:
		reply.error = _payload("ERROR", "NETWORK", MESSAGES.NETWORK, {"retryable": true})
		return reply
	reply.transport_ok = true
	_absorb_authorization(headers)
	var parsed: Variant = parse_json(raw.get_string_from_utf8()) if raw.size() > 0 else null
	if typeof(parsed) == TYPE_DICTIONARY:
		reply.json = parsed
		if parsed.has("client") and typeof(parsed.get("client")) == TYPE_DICTIONARY:
			_absorb_client(parsed.get("client"))
	if status == 429:
		reply.error = _payload("ERROR", "RATE_LIMIT", MESSAGES.RATE_LIMIT)
		return reply
	if status < 200 or status >= 300:
		reply.error = _map_errors(reply.json, status)
		return reply
	if typeof(parsed) != TYPE_DICTIONARY:
		reply.error = _payload("ERROR", "UNKNOWN", MESSAGES.UNKNOWN)
	return reply


func _absorb_authorization(headers: PackedStringArray) -> void:
	for line in headers:
		var colon := line.find(":")
		if colon <= 0:
			continue
		if line.substr(0, colon).strip_edges().to_lower() != "authorization":
			continue
		var value := _sanitize_token(line.substr(colon + 1))
		if value.is_empty():
			_forget_client_token()
		elif value != _client_token:
			_remember_client_token(value)
		return


func _map_errors(json: Dictionary, status: int) -> Dictionary:
	var errors: Variant = json.get("errors")
	if typeof(errors) == TYPE_ARRAY:
		for item in errors:
			if typeof(item) != TYPE_DICTIONARY:
				continue
			var code := str(item.get("code", ""))
			if code.is_empty():
				continue
			var mapped := str(_codes.get(code, _native_codes.get(code, "")))
			if mapped.is_empty() and code.begins_with("session_"):
				mapped = "SESSION_EXPIRED"
			match code:
				"native_api_disabled":
					return _payload("ERROR", "CONFIG", MESSAGES.NATIVE_API_DISABLED, {"phase": "native_api_disabled"})
				"form_identifier_exists":
					return _payload("ERROR", "UNKNOWN", MESSAGES.IDENTIFIER_EXISTS)
				"session_exists":
					return _payload("ERROR", "UNKNOWN", MESSAGES.SESSION_PRESENT)
				"user_locked":
					return _payload("ERROR", "UNKNOWN", MESSAGES.USER_LOCKED)
			match mapped:
				"INVALID_CODE", "ACCOUNT_NOT_FOUND", "INVALID_EMAIL", "EXPIRED_CODE", "RATE_LIMIT", "SESSION_EXPIRED", "CONFIG", "UNKNOWN":
					return _payload("ERROR", mapped, MESSAGES.get(mapped, MESSAGES.UNKNOWN))
				"UNSUPPORTED_CHALLENGE":
					return _payload("NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", MESSAGES.NEEDS_MORE_STEPS)
	if status == 401 or status == 404:
		return _payload("ERROR", "SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED)
	if status >= 500:
		return _payload("ERROR", "NETWORK", MESSAGES.NETWORK, {"retryable": true})
	return _payload("ERROR", "UNKNOWN", MESSAGES.UNKNOWN)


static func _form_encode(form: Dictionary) -> String:
	var parts: PackedStringArray = PackedStringArray()
	for key in form.keys():
		parts.append(str(key).uri_encode() + "=" + str(form[key]).uri_encode())
	return "&".join(parts)


## HTTPRequest with a monotonic deadline. Godot's built-in timeout timer can
## charge a stalled previous frame to a request that just started, so the
## deadline is checked against Time.get_ticks_usec instead. Completes once.
class _DeadlineRequest:
	extends HTTPRequest
	var on_done: Callable = Callable()
	var cancellable: bool = false
	var _deadline_usec: int = 0
	var _settled: bool = false

	func arm(ms: int) -> void:
		_deadline_usec = Time.get_ticks_usec() + ms * 1000
		set_process(_deadline_usec > 0)

	func _process(_delta: float) -> void:
		if _settled or _deadline_usec <= 0 or Time.get_ticks_usec() < _deadline_usec:
			return
		_deadline_usec = 0
		set_process(false)
		cancel_request()
		finish(HTTPRequest.RESULT_TIMEOUT, 0, PackedStringArray(), PackedByteArray())

	func abort() -> void:
		if _settled:
			return
		_settled = true
		on_done = Callable()
		set_process(false)
		cancel_request()
		queue_free()

	func finish(result: int, status: int, headers: PackedStringArray, body: PackedByteArray) -> void:
		if _settled:
			return
		_settled = true
		set_process(false)
		var callback := on_done
		on_done = Callable()
		queue_free()
		if callback.is_valid():
			callback.call(result, status, headers, body)

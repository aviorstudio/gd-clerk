extends SceneTree
## Drives GdClerk natively through its public API against tests/native/fapi_fixture.py.
## Run by scripts/run-godot-tests.sh with GD_CLERK_TEST_LOOPBACK=1 and
## GD_CLERK_FIXTURE_PORT set. Prints "ok <label>" per passing check and exits 1
## when any check fails.

## A gd-session credential adapter with per-instance memory, so tests can hold
## independent stores. Reached through the installed dependency, not the deps
## file: tests are not packaged and may name the project's hoisted copy.
class MemoryCredentialAdapter extends "res://addons/@aviorstudio_gd-session/src/credential_adapter.gd":
	var values: Dictionary[String, String] = {}

	func read_value(key: String) -> Result:
		if not values.has(key):
			return Result.new(Status.NOT_FOUND)
		return Result.new(Status.OK, values[key])

	func write_value(key: String, value: String) -> Result:
		if value.is_empty():
			values.erase(key)
		else:
			values[key] = value
		return Result.new(Status.OK)

	func stored(key: String) -> String:
		return values.get(key, "")


const GdClerkScript := preload("res://addons/@aviorstudio_gd-clerk/gd_clerk.gd")
const CORRECT_CODE := "424242"
const CALL_TIMEOUT_MS := 15000

var _failed := false
var _messages: Array = []
var _base_url := ""
var _store := MemoryCredentialAdapter.new()


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	var port := OS.get_environment("GD_CLERK_FIXTURE_PORT")
	if not port.is_valid_int() or OS.get_environment("GD_CLERK_TEST_LOOPBACK") != "1":
		push_error("FAIL fixture environment missing")
		quit(1)
		return
	_base_url = "http://127.0.0.1:" + port
	await _test_configure_and_sign_in()
	await _test_restore()
	await _test_sign_out()
	await _test_errors()
	await _test_sign_up()
	await _test_session_gone()
	await _test_deadline_and_cancel()
	_check(_redacted(), "no result message leaks an email, code, token or key")
	await process_frame
	quit(1 if _failed else 0)


# --- scenarios ----------------------------------------------------------------

func _test_configure_and_sign_in() -> void:
	var clerk := _clerk()
	var states: Array = []
	clerk.session_changed.connect(func(state: SessionState) -> void: states.append(state))
	var sync_box: Array = []
	clerk.configure(_config(_store), func(result: ClerkResult) -> void: sync_box.append(result))
	var configured_sync: bool = sync_box.size() == 1 and clerk.get_child_count() == 0
	var configured: ClerkResult = await _call(func(done: Callable) -> void: clerk.configure(_config(_store), done))
	_check(_is(configured, "CONFIGURED", "", "native_signed_out"), "configure without a stored token reports native_signed_out")
	_check(states.size() >= 1 and not states[0].signed_in and states[0].status == "signed_out" and not states[0].protected_actions_blocked, "configure emits a signed_out session state")
	_check(configured_sync and _store.stored("client_token") == "", "configure completes synchronously without a request when no token is stored")

	var sent: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("ok@example.test", 0, done))
	_check(_is(sent, "CODE_SENT"), "sign-in begin reaches CODE_SENT")
	var token_after_begin := _store.stored("client_token")
	_check(token_after_begin.begins_with("dvb_"), "the client token from the Authorization response header is stored")

	var wrong: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code("111111", done))
	_check(_is(wrong, "ERROR", "INVALID_CODE"), "wrong code maps to INVALID_CODE")
	var expired: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code("000000", done))
	_check(_is(expired, "ERROR", "EXPIRED_CODE"), "expired code maps to EXPIRED_CODE")
	var attempts: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code("999999", done))
	_check(_is(attempts, "ERROR", "RATE_LIMIT"), "too many attempts maps to RATE_LIMIT")
	var cooldown: ClerkResult = await _call(func(done: Callable) -> void: clerk.resend_email_code(done))
	_check(_is(cooldown, "ERROR", "RESEND_COOLDOWN"), "resend inside the cooldown is refused locally")
	clerk._native.resend_cooldown_ms = 0
	var resent: ClerkResult = await _call(func(done: Callable) -> void: clerk.resend_email_code(done))
	_check(_is(resent, "CODE_SENT"), "resend after the cooldown re-prepares the code")

	var busy_probe: Array = []
	clerk.complete_email_code(CORRECT_CODE, func(result: ClerkResult) -> void: busy_probe.append(result))
	var busy: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code(CORRECT_CODE, done))
	_check(_is(busy, "ERROR", "UNKNOWN") and busy.message == "An email code request is already in progress.", "a second in-flight email request is refused")
	await _settle(busy_probe)
	_check(busy_probe.size() == 1 and _is(busy_probe[0], "AUTHENTICATED"), "correct code reaches AUTHENTICATED")
	var token_after_sign_in := _store.stored("client_token")
	_check(token_after_sign_in.begins_with("dvb_") and token_after_sign_in != token_after_begin, "a rotated client token replaces the stored one")
	_check(states.size() >= 2 and states[-1].signed_in and states[-1].status == "signed_in", "sign-in emits a signed_in session state")

	var present: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("ok@example.test", 0, done))
	_check(_is(present, "ERROR", "UNKNOWN") and present.message == "A session is already present.", "begin while signed in is refused")
	var mid: Array = []
	clerk.configure(_config(_store), func(result: ClerkResult) -> void: mid.append(result))
	clerk._native._session_generation += 1
	await _settle(mid)
	_check(mid.size() == 1 and _is(mid[0], "CONFIGURED", "", "native_restored") and clerk._relays.size() == 0, "a configure whose session generation moved mid-flight still completes")

	var first: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(30, done))
	_check(_is(first, "AUTHENTICATED") and first.token.begins_with("eyJ") and first.token.split(".").size() == 3, "get_session_token mints a JWT")
	var again: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(30, done))
	_check(_is(again, "AUTHENTICATED") and again.token == first.token, "a token that still meets min_validity is served from the cache")
	# The fixture issues 60 s tokens. After 3.5 s the cached token (truncated to whole seconds) no longer meets 58 s.
	await _wait_ms(3500)
	var a: Array = []
	var b: Array = []
	clerk.get_session_token(58, func(result: ClerkResult) -> void: a.append(result))
	clerk.get_session_token(58, func(result: ClerkResult) -> void: b.append(result))
	await _settle(a)
	await _settle(b)
	_check(a.size() == 1 and b.size() == 1 and _is(a[0], "AUTHENTICATED") and a[0].token == b[0].token and a[0].token != first.token, "concurrent re-mints share one fresh token")
	var too_long: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(90, done))
	_check(_is(too_long, "ERROR", "SESSION_EXPIRED"), "a token that cannot meet min_validity is SESSION_EXPIRED")
	var out_of_range: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(121, done))
	_check(_is(out_of_range, "ERROR", "CONFIG"), "min_validity above the cap is CONFIG")
	_check(clerk._relays.size() == 0, "relays are released after native delivery")
	_free(clerk)


func _test_restore() -> void:
	var clerk := _clerk()
	var states: Array = []
	clerk.session_changed.connect(func(state: SessionState) -> void: states.append(state))
	var restored: ClerkResult = await _call(func(done: Callable) -> void: clerk.configure(_config(_store), done))
	_check(_is(restored, "CONFIGURED", "", "native_restored"), "configure restores the session from the stored client token")
	_check(states.size() == 1 and states[0].signed_in and states[0].status == "signed_in", "restore emits signed_in")
	var token: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(10, done))
	_check(_is(token, "AUTHENTICATED") and token.token != "", "a restored session mints tokens")
	_free(clerk)

	var bogus := MemoryCredentialAdapter.new()
	bogus.write_value("client_token", "dvb_bogus")
	var rejected_clerk := _clerk()
	var rejected: ClerkResult = await _call(func(done: Callable) -> void: rejected_clerk.configure(_config(bogus), done))
	_check(_is(rejected, "CONFIGURED", "", "native_token_rejected") and bogus.stored("client_token") == "", "a rejected client token is forgotten and configure stays signed out")
	_free(rejected_clerk)

	var clearing := MemoryCredentialAdapter.new()
	clearing.write_value("client_token", "dvb_clear")
	var cleared_clerk := _clerk()
	var cleared: ClerkResult = await _call(func(done: Callable) -> void: cleared_clerk.configure(_config(clearing), done))
	_check(_is(cleared, "CONFIGURED", "", "native_signed_out") and clearing.stored("client_token") == "", "an empty Authorization response header clears the stored token")
	_free(cleared_clerk)


func _test_sign_out() -> void:
	var clerk := _clerk()
	var states: Array = []
	clerk.session_changed.connect(func(state: SessionState) -> void: states.append(state))
	var config := _config(_store)
	var restored: ClerkResult = await _call(func(done: Callable) -> void: clerk.configure(config, done))
	_check(_is(restored, "CONFIGURED", "", "native_restored"), "sign-out scenario starts signed in")

	var missing: ClerkResult = await _call(func(done: Callable) -> void: clerk.sign_out(done))
	_check(_is(missing, "SIGN_OUT_FAILED", "CONFIG", "revoke_missing") and missing.retryable, "sign-out without a revoke callback fails closed")
	_check(states[-1].protected_actions_blocked and states[-1].status == "sign_out_unconfirmed" and not states[-1].signed_in, "a failed sign-out latches protected actions")
	var latched_token: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(0, done))
	_check(_is(latched_token, "SIGN_OUT_FAILED", "UNKNOWN", "sign_out_latched"), "token mint is blocked while latched")
	var latched_begin: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("ok@example.test", 0, done))
	_check(_is(latched_begin, "SIGN_OUT_FAILED", "UNKNOWN", "sign_out_latched"), "email begin is blocked while latched")

	var seen_jwts: Array = []
	config.revoke_session = func(jwt: String, ack: Callable) -> void:
		seen_jwts.append(jwt)
		ack.call({"schema": "gd-clerk.revoke.v1", "remote_confirmed": true, "session_id": "sess_other", "subject": "user_other"})
	var reconfigured: ClerkResult = await _call(func(done: Callable) -> void: clerk.configure(config, done))
	_check(_is(reconfigured, "CONFIGURED", "", "native_restored"), "reconfigure with a revoke callback keeps the session")
	var rejected: ClerkResult = await _call(func(done: Callable) -> void: clerk.sign_out(done))
	_check(_is(rejected, "SIGN_OUT_FAILED", "UNKNOWN", "revoke_rejected") and seen_jwts.size() == 1 and seen_jwts[0].begins_with("eyJ"), "a mismatched revoke ack is rejected after the callback saw a fresh JWT")

	var original_timeout: int = clerk._native.timeout_ms
	config.revoke_session = func(_jwt: String, _ack: Callable) -> void:
		pass
	clerk._revoke_session = config.revoke_session
	clerk._native.timeout_ms = 500
	var timed_out: ClerkResult = await _call(func(done: Callable) -> void: clerk.sign_out(done))
	_check(_is(timed_out, "SIGN_OUT_FAILED", "UNKNOWN", "revoke_timeout"), "a silent revoke callback times out")
	clerk._native.timeout_ms = original_timeout

	config.revoke_session = func(jwt: String, ack: Callable) -> void:
		var claims := _claims(jwt)
		ack.call({"schema": "gd-clerk.revoke.v1", "remote_confirmed": true, "session_id": str(claims.get("sid", "")), "subject": str(claims.get("sub", ""))})
		ack.call({"schema": "gd-clerk.revoke.v1", "remote_confirmed": true, "session_id": "sess_late", "subject": "user_late"})
	clerk._revoke_session = config.revoke_session
	var first_out: Array = []
	clerk.sign_out(func(result: ClerkResult) -> void: first_out.append(result))
	var shared: ClerkResult = await _call(func(done: Callable) -> void: clerk.sign_out(done))
	await _settle(first_out)
	_check(first_out.size() == 1 and _is(first_out[0], "SIGNED_OUT", "", "native_session_removed") and _is(shared, "SIGNED_OUT", "", "native_session_removed"), "a valid ack removes the session and both sign-out callers see SIGNED_OUT")
	_check(states[-1].status == "signed_out" and not states[-1].signed_in and not states[-1].protected_actions_blocked, "sign-out clears the latch and emits signed_out")
	_check(_store.stored("client_token").begins_with("dvb_"), "the client token survives sign-out")
	var gone: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(0, done))
	_check(_is(gone, "ERROR", "SESSION_EXPIRED"), "token mint after sign-out is SESSION_EXPIRED without a request")
	var fresh: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("ok@example.test", 0, done))
	_check(_is(fresh, "CODE_SENT"), "a new sign-in can start after sign-out")
	clerk.cancel_email_code()
	_free(clerk)


func _test_errors() -> void:
	var clerk := _clerk()
	await _call(func(done: Callable) -> void: clerk.configure(_config(_store), done))
	var cases := [
		["missing@example.test", 0, "ERROR", "ACCOUNT_NOT_FOUND", ""],
		["ratelimit@example.test", 0, "ERROR", "RATE_LIMIT", ""],
		["locked@example.test", 0, "ERROR", "UNKNOWN", ""],
		["disabled@example.test", 0, "ERROR", "CONFIG", "native_api_disabled"],
		["disabled@example.test", 1, "ERROR", "CONFIG", "native_api_disabled"],
		["exists@example.test", 1, "ERROR", "UNKNOWN", ""],
		["ratelimit@example.test", 1, "ERROR", "RATE_LIMIT", ""],
	]
	for item in cases:
		var result: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code(item[0], item[1], done))
		_check(_is(result, item[2], item[3], item[4]), "begin %s mode %d maps to %s/%s" % [item[0].split("@")[0], item[1], item[2], item[3]])
		clerk.cancel_email_code()
	var locked: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("locked@example.test", 0, done))
	_check(locked.message == "This account is locked.", "user_locked carries its fixed message")
	var disabled: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("disabled@example.test", 1, done))
	_check(disabled.message.contains("Native API"), "native_api_disabled names the dashboard prerequisite")
	var flaky: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("flaky@example.test", 0, done))
	var retried: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("flaky@example.test", 0, done))
	_check(_is(flaky, "ERROR", "NETWORK") and flaky.retryable and _is(retried, "CODE_SENT"), "a failed first prepare does not wedge begin behind FLOW_BUSY")
	clerk.cancel_email_code()
	var mfa: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("mfa@example.test", 0, done))
	var busy: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("ok@example.test", 0, done))
	_check(_is(busy, "ERROR", "UNKNOWN") and busy.message == "An email code request is already in progress.", "begin while a code is pending is refused until cancel")
	var mfa_done: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code(CORRECT_CODE, done))
	_check(_is(mfa, "CODE_SENT") and _is(mfa_done, "NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", "status_challenge"), "a second factor is NEEDS_MORE_STEPS")
	var no_flow: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code(CORRECT_CODE, done))
	_check(_is(no_flow, "ERROR", "CANCELLED"), "NEEDS_MORE_STEPS ends the flow so complete is CANCELLED")
	clerk.cancel_email_code()
	var no_resend: ClerkResult = await _call(func(done: Callable) -> void: clerk.resend_email_code(done))
	_check(_is(no_resend, "ERROR", "CANCELLED"), "resend without a flow is CANCELLED")
	_free(clerk)


func _test_sign_up() -> void:
	var clerk := _clerk()
	var config := _config(_store)
	config.revoke_session = func(jwt: String, ack: Callable) -> void:
		var claims := _claims(jwt)
		ack.call({"schema": "gd-clerk.revoke.v1", "remote_confirmed": true, "session_id": str(claims.get("sid", "")), "subject": str(claims.get("sub", ""))})
	await _call(func(done: Callable) -> void: clerk.configure(config, done))
	var sent: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("new@example.test", 1, done))
	var wrong: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code("111111", done))
	var authed: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code(CORRECT_CODE, done))
	_check(_is(sent, "CODE_SENT") and _is(wrong, "ERROR", "INVALID_CODE") and _is(authed, "AUTHENTICATED"), "sign-up verifies the email code and signs in")
	var token: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(30, done))
	_check(_is(token, "AUTHENTICATED") and token.token != "", "a signed-up session mints tokens")
	var out: ClerkResult = await _call(func(done: Callable) -> void: clerk.sign_out(done))
	_check(_is(out, "SIGNED_OUT", "", "native_session_removed"), "sign-up session signs out")
	var partial: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("incomplete@example.test", 1, done))
	var incomplete: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code(CORRECT_CODE, done))
	_check(_is(partial, "CODE_SENT") and _is(incomplete, "NEEDS_MORE_STEPS", "UNSUPPORTED_CHALLENGE", "missing_factor"), "a sign-up with missing requirements is NEEDS_MORE_STEPS")
	clerk.cancel_email_code()
	_free(clerk)


func _test_session_gone() -> void:
	var clerk := _clerk()
	var states: Array = []
	clerk.session_changed.connect(func(state: SessionState) -> void: states.append(state))
	await _call(func(done: Callable) -> void: clerk.configure(_config(_store), done))
	await _call(func(done: Callable) -> void: clerk.begin_email_code("short@example.test", 0, done))
	var authed: ClerkResult = await _call(func(done: Callable) -> void: clerk.complete_email_code(CORRECT_CODE, done))
	var first: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(30, done))
	var revoked: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(90, done))
	_check(_is(authed, "AUTHENTICATED") and _is(first, "AUTHENTICATED") and _is(revoked, "ERROR", "SESSION_EXPIRED"), "a session revoked server-side is SESSION_EXPIRED on the next mint")
	_check(states[-1].status == "signed_out" and not states[-1].signed_in, "a gone session emits signed_out")
	var local: ClerkResult = await _call(func(done: Callable) -> void: clerk.get_session_token(0, done))
	_check(_is(local, "ERROR", "SESSION_EXPIRED"), "later mints fail locally")
	_free(clerk)

	var remote := _clerk()
	var remote_states: Array = []
	remote.session_changed.connect(func(state: SessionState) -> void: remote_states.append(state))
	var config := _config(_store)
	config.revoke_session = func(jwt: String, ack: Callable) -> void:
		var claims := _claims(jwt)
		ack.call({"schema": "gd-clerk.revoke.v1", "remote_confirmed": true, "session_id": str(claims.get("sid", "")), "subject": str(claims.get("sub", ""))})
	await _call(func(done: Callable) -> void: remote.configure(config, done))
	await _call(func(done: Callable) -> void: remote.begin_email_code("remote@example.test", 0, done))
	var remote_authed: ClerkResult = await _call(func(done: Callable) -> void: remote.complete_email_code(CORRECT_CODE, done))
	var remote_out: ClerkResult = await _call(func(done: Callable) -> void: remote.sign_out(done))
	_check(_is(remote_authed, "AUTHENTICATED") and _is(remote_out, "SIGNED_OUT", "", "native_session_removed"), "a session the revoke callback already removed still signs out")
	_check(not remote_states[-1].protected_actions_blocked and remote_states[-1].status == "signed_out", "sign-out after a remote removal clears the latch")
	var remote_fresh: ClerkResult = await _call(func(done: Callable) -> void: remote.begin_email_code("ok@example.test", 0, done))
	_check(_is(remote_fresh, "CODE_SENT"), "email begin works after that sign-out")
	remote.cancel_email_code()
	_free(remote)


func _test_deadline_and_cancel() -> void:
	var clerk := _clerk()
	await _call(func(done: Callable) -> void: clerk.configure(_config(_store), done))
	var original_timeout: int = clerk._native.timeout_ms
	clerk._native.timeout_ms = 1000
	var started := Time.get_ticks_msec()
	var slow: ClerkResult = await _call(func(done: Callable) -> void: clerk.begin_email_code("slow@example.test", 0, done))
	var elapsed := Time.get_ticks_msec() - started
	_check(_is(slow, "ERROR", "NETWORK") and slow.retryable and elapsed >= 900 and elapsed < 2500, "a stalled request hits the monotonic deadline as NETWORK")
	clerk._native.timeout_ms = original_timeout
	await process_frame
	_check(clerk.get_child_count() == 0, "a timed-out request node is freed")

	var cancelled: Array = []
	var restarted: Array = []
	clerk.begin_email_code("slow@example.test", 0, func(result: ClerkResult) -> void:
		cancelled.append(result)
		clerk.begin_email_code("ok@example.test", 0, func(inner: ClerkResult) -> void: restarted.append(inner))
	)
	clerk.cancel_email_code()
	_check(cancelled.size() == 1 and _is(cancelled[0], "ERROR", "CANCELLED"), "cancel settles the in-flight begin with CANCELLED")
	await _settle(restarted)
	_check(restarted.size() == 1 and _is(restarted[0], "CODE_SENT") and cancelled.size() == 1, "a flow restarted from the CANCELLED callback starts and the stale completion is dropped")
	clerk.cancel_email_code()
	await _wait_ms(3500)
	_check(cancelled.size() == 1 and clerk._relays.size() == 0 and clerk.get_child_count() == 0, "late fixture replies never reach a cancelled relay")
	_free(clerk)


# --- helpers ------------------------------------------------------------------

func _clerk() -> Node:
	var clerk: Node = GdClerkScript.new()
	root.add_child(clerk)
	return clerk


func _free(clerk: Node) -> void:
	root.remove_child(clerk)
	clerk.free()


func _config(store: MemoryCredentialAdapter) -> ClerkConfig:
	var host := _base_url.trim_prefix("http://")
	var config := ClerkConfig.new()
	var encoded := Marshalls.utf8_to_base64(host + "$")
	while encoded.ends_with("="):
		encoded = encoded.substr(0, encoded.length() - 1)
	config.publishable_key = "pk_test_" + encoded
	config.frontend_api = _base_url
	config.credential_store = store
	return config


func _call(start: Callable) -> ClerkResult:
	var box: Array = []
	start.call(func(result: ClerkResult) -> void: box.append(result))
	await _settle(box)
	if box.is_empty():
		push_error("FAIL call did not complete")
		_failed = true
		return ClerkResult.error("UNKNOWN", "timeout")
	return box[0]


func _settle(box: Array) -> void:
	var deadline := Time.get_ticks_msec() + CALL_TIMEOUT_MS
	while box.is_empty() and Time.get_ticks_msec() < deadline:
		await process_frame


func _wait_ms(ms: int) -> void:
	var deadline := Time.get_ticks_msec() + ms
	while Time.get_ticks_msec() < deadline:
		await process_frame


func _is(result: ClerkResult, state: String, error_key: String = "", phase: String = "") -> bool:
	if result == null:
		return false
	_messages.append(result.message)
	return result.state == state and result.error_key == error_key and (phase == "" or result.phase == phase)


func _check(ok: bool, label: String) -> void:
	if ok:
		print("ok ", label)
		return
	push_error("FAIL " + label)
	_failed = true


func _claims(jwt: String) -> Dictionary:
	var parts := jwt.split(".")
	if parts.size() != 3:
		return {}
	var payload := parts[1].replace("-", "+").replace("_", "/")
	while payload.length() % 4 != 0:
		payload += "="
	var parsed: Variant = JSON.parse_string(Marshalls.base64_to_utf8(payload))
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}


func _redacted() -> bool:
	var digits := RegEx.create_from_string("\\d{4,}")
	for message in _messages:
		var text := str(message)
		if text.contains("@") or text.contains("eyJ") or text.contains("pk_") or text.contains("dvb_") or digits.search(text) != null:
			push_error("FAIL leaked message")
			return false
	return true

#!/usr/bin/env python3
"""Loopback Clerk Frontend API fixture for the native gd-clerk backend tests.

Standard library only. Serves plain HTTP on 127.0.0.1 and writes its port to
the file named by --port-file. Scenarios are selected by the email address and
verification code the addon sends, so the Godot test needs no control channel:

  ok@example.test          sign-in happy path (code 424242)
  short@example.test       sign-in; the session is revoked server-side after
                           its first token mint
  remote@example.test      sign-in; the consumer's revoke removes the session,
                           so POST sessions/{id}/remove answers 404
  missing@example.test     form_identifier_not_found
  ratelimit@example.test   HTTP 429 on sign-in creation
  disabled@example.test    native_api_disabled (400)
  mfa@example.test         attempt succeeds but reports needs_second_factor
  locked@example.test      user_locked
  slow@example.test        sign-in creation sleeps SLOW_SECONDS before answering
  new@example.test         sign-up happy path
  exists@example.test      sign-up form_identifier_exists
  incomplete@example.test  sign-up verifies but stays missing_requirements

Codes: 424242 correct, 000000 verification_expired, 999999
verification_code_too_many_attempts, anything else form_code_incorrect.

Client tokens: a request without Authorization gets a new client and token
dvb_<n>. A successful sign-in or sign-up rotates the token (the old one is
rejected afterwards). Token dvb_bogus is rejected with 401. Token dvb_clear
returns an empty client with an empty Authorization response header.

Every request is checked for the native protocol; a violation answers 400 with
code fixture_protocol_violation, which the addon reports as UNKNOWN so the test
fails loudly. Error messages deliberately contain an email address, a code and
a token-looking string to prove the addon never echoes them.
"""

import argparse
import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SLOW_SECONDS = 3.0
TOKEN_TTL_SECONDS = 60
CORRECT_CODE = "424242"
API_VERSION = "2026-05-12"

LOCK = threading.Lock()
STATE = {
    "clients": {},  # token -> client dict
    "next_client": 1,
    "next_token": 1,
    "next_session": 1,
    "next_user": 1,
    "next_attempt": 1,
    "mints": 0,
}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(session: dict, now: int) -> str:
    STATE["mints"] += 1
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload = b64url(
        json.dumps(
            {
                "iat": now,
                "exp": now + session["ttl"],
                "nbf": now - 5,
                "sid": session["id"],
                "sub": session["user_id"],
                "iss": "http://127.0.0.1",
                "n": STATE["mints"],
            }
        ).encode()
    )
    return f"{header}.{payload}.fixturesig"


def new_token() -> str:
    token = f"dvb_{STATE['next_token']}"
    STATE["next_token"] += 1
    return token


def new_client() -> dict:
    client = {
        "object": "client",
        "id": f"client_{STATE['next_client']}",
        "sessions": [],
        "sign_in": None,
        "sign_up": None,
        "last_active_session_id": None,
        "token": new_token(),
    }
    STATE["next_client"] += 1
    STATE["clients"][client["token"]] = client
    return client


def rotate_token(client: dict) -> None:
    STATE["clients"].pop(client["token"], None)
    client["token"] = new_token()
    STATE["clients"][client["token"]] = client


def public_session(session: dict) -> dict:
    return {
        "object": "session",
        "id": session["id"],
        "status": session["status"],
        "user": {"object": "user", "id": session["user_id"], "email_addresses": [{"email_address": session["email"]}]},
        "last_active_token": None,
    }


def public_client(client: dict) -> dict:
    return {
        "object": "client",
        "id": client["id"],
        "sessions": [public_session(s) for s in client["sessions"]],
        "sign_in": client["sign_in"],
        "sign_up": client["sign_up"],
        "last_active_session_id": client["last_active_session_id"],
    }


def create_session(client: dict, email: str) -> dict:
    session = {
        "id": f"sess_{STATE['next_session']}",
        "status": "active",
        "user_id": f"user_{STATE['next_user']}",
        "email": email,
        "ttl": TOKEN_TTL_SECONDS,
        "revoke_after_mint": email == "short@example.test",
        "removed_remotely": email == "remote@example.test",
    }
    STATE["next_session"] += 1
    STATE["next_user"] += 1
    client["sessions"].append(session)
    client["last_active_session_id"] = session["id"]
    return session


def error_body(code: str, status: int, email: str = "person@example.test") -> tuple:
    message = f"{code} for {email} code 123456 token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig pk_test_leak"
    return status, {
        "errors": [{"message": message, "long_message": message, "code": code, "meta": {}}],
        "clerk_trace_id": "trace_fixture",
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence
        return

    def _read_form(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        return {k: v[0] for k, v in parse_qs(raw.decode(), keep_blank_values=True).items()}

    def _reply(self, status: int, body: dict, auth_header=None) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        if auth_header is not None:
            self.send_header("Authorization", auth_header)
        self.end_headers()
        self.wfile.write(data)

    def _protocol_violation(self) -> str:
        parts = urlsplit(self.path)
        query = parse_qs(parts.query)
        if query.get("_is_native") != ["true"]:
            return "missing _is_native=true"
        if self.headers.get("Clerk-API-Version") != API_VERSION:
            return "missing Clerk-API-Version"
        if "application/json" not in (self.headers.get("Accept") or ""):
            return "missing Accept"
        if self.headers.get("x-mobile") != "1":
            return "missing x-mobile"
        if "gd-clerk" not in (self.headers.get("User-Agent") or ""):
            return "missing gd-clerk user agent"
        auth = self.headers.get("Authorization")
        if auth is not None and auth.lower().startswith("bearer"):
            return "authorization must be the raw client token"
        if self.command == "POST" and "application/x-www-form-urlencoded" not in (self.headers.get("Content-Type") or ""):
            return "POST must be form encoded"
        for value in list(self.headers.values()) + [self.path]:
            if "pk_test" in value or "pk_live" in value:
                return "publishable key sent"
        return ""

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def _handle(self, method: str) -> None:
        violation = self._protocol_violation()
        form = self._read_form() if method == "POST" else {}
        if violation:
            self._reply(*error_body("fixture_protocol_violation", 400, violation))
            return
        if any("pk_test" in v or "pk_live" in v for v in form.values()):
            self._reply(*error_body("fixture_protocol_violation", 400, "publishable key in body"))
            return
        path = urlsplit(self.path).path
        auth = self.headers.get("Authorization")
        if path == "/v1/client/sign_ins" and form.get("identifier") == "slow@example.test":
            time.sleep(SLOW_SECONDS)
        with LOCK:
            if auth == "dvb_bogus":
                self._reply(*error_body("authentication_invalid", 401))
                return
            if auth == "dvb_clear":
                self._reply(200, {"response": {"object": "client", "id": "client_clear", "sessions": [], "sign_in": None, "sign_up": None, "last_active_session_id": None}, "client": None}, auth_header="")
                return
            client = STATE["clients"].get(auth) if auth else None
            if auth and client is None:
                self._reply(*error_body("authentication_invalid", 401))
                return
            if path == "/v1/client" and method == "GET":
                if client is None:
                    self._reply(*error_body("authentication_invalid", 401))
                    return
                self._reply(200, {"response": public_client(client), "client": None}, auth_header=client["token"])
                return
            if method != "POST":
                self._reply(*error_body("resource_not_found", 404))
                return
            if client is None:
                client = new_client()
            rotate = False
            status, body = 404, None
            if path == "/v1/client/sign_ins":
                status, body = self._sign_in_create(client, form)
            elif path.startswith("/v1/client/sign_ins/") and path.endswith("/prepare_first_factor"):
                status, body = self._sign_in_prepare(client, path.split("/")[4], form)
            elif path.startswith("/v1/client/sign_ins/") and path.endswith("/attempt_first_factor"):
                status, body, rotate = self._sign_in_attempt(client, path.split("/")[4], form)
            elif path == "/v1/client/sign_ups":
                status, body = self._sign_up_create(client, form)
            elif path.startswith("/v1/client/sign_ups/") and path.endswith("/prepare_verification"):
                status, body = self._sign_up_prepare(client, path.split("/")[4], form)
            elif path.startswith("/v1/client/sign_ups/") and path.endswith("/attempt_verification"):
                status, body, rotate = self._sign_up_attempt(client, path.split("/")[4], form)
            elif path.startswith("/v1/client/sessions/") and path.endswith("/tokens"):
                status, body = self._session_token(client, path.split("/")[4])
            elif path.startswith("/v1/client/sessions/") and path.endswith("/remove"):
                status, body = self._session_remove(client, path.split("/")[4])
            elif path.startswith("/v1/client/sessions/") and path.endswith("/touch"):
                status, body = self._session_touch(client, path.split("/")[4])
            else:
                status, body = error_body("resource_not_found", 404)
            if rotate:
                rotate_token(client)
            self._reply(status, body, auth_header=client["token"])

    # --- sign in ---------------------------------------------------------
    def _sign_in_create(self, client: dict, form: dict):
        email = form.get("identifier", "")
        if email == "ratelimit@example.test":
            return error_body("too_many_requests", 429, email)
        if email == "missing@example.test":
            return error_body("form_identifier_not_found", 422, email)
        if email == "locked@example.test":
            return error_body("user_locked", 403, email)
        if email == "disabled@example.test":
            return error_body("native_api_disabled", 400, email)
        if "@" not in email:
            return error_body("form_param_format_invalid", 422, email)
        attempt = {
            "object": "sign_in_attempt",
            "id": f"sia_{STATE['next_attempt']}",
            "status": "needs_first_factor",
            "identifier": email,
            "supported_first_factors": [
                {"strategy": "email_code", "email_address_id": f"idn_{STATE['next_attempt']}", "safe_identifier": "o**@example.test"}
            ],
            "first_factor_verification": None,
            "created_session_id": None,
            "email": email,
            "prepared": False,
        }
        STATE["next_attempt"] += 1
        client["sign_in"] = attempt
        return 200, {"response": self._public_sign_in(attempt), "client": public_client(client)}

    def _public_sign_in(self, attempt: dict) -> dict:
        return {k: v for k, v in attempt.items() if k not in ("email", "prepared")}

    def _sign_in_prepare(self, client: dict, sign_in_id: str, form: dict):
        attempt = client.get("sign_in")
        if not attempt or attempt["id"] != sign_in_id:
            return error_body("resource_not_found", 404)
        if form.get("strategy") != "email_code" or form.get("email_address_id") != attempt["supported_first_factors"][0]["email_address_id"]:
            return error_body("form_param_missing", 422)
        attempt["prepared"] = True
        attempt["first_factor_verification"] = {"status": "unverified", "strategy": "email_code"}
        return 200, {"response": self._public_sign_in(attempt), "client": public_client(client)}

    def _sign_in_attempt(self, client: dict, sign_in_id: str, form: dict):
        attempt = client.get("sign_in")
        if not attempt or attempt["id"] != sign_in_id:
            return (*error_body("resource_not_found", 404), False)
        if not attempt["prepared"]:
            return (*error_body("verification_missing", 422), False)
        code = form.get("code", "")
        if code == "000000":
            return (*error_body("verification_expired", 422), False)
        if code == "999999":
            return (*error_body("verification_code_too_many_attempts", 429), False)
        if code != CORRECT_CODE:
            return (*error_body("form_code_incorrect", 422), False)
        if attempt["email"] == "mfa@example.test":
            attempt["status"] = "needs_second_factor"
            attempt["first_factor_verification"] = {"status": "verified", "strategy": "email_code"}
            return 200, {"response": self._public_sign_in(attempt), "client": public_client(client)}, False
        session = create_session(client, attempt["email"])
        attempt["status"] = "complete"
        attempt["created_session_id"] = session["id"]
        attempt["first_factor_verification"] = {"status": "verified", "strategy": "email_code"}
        client["sign_in"] = None
        return 200, {"response": self._public_sign_in(attempt), "client": public_client(client)}, True

    # --- sign up ---------------------------------------------------------
    def _sign_up_create(self, client: dict, form: dict):
        email = form.get("email_address", "")
        if email == "exists@example.test":
            return error_body("form_identifier_exists", 422, email)
        if email == "disabled@example.test":
            return error_body("native_api_disabled", 400, email)
        if email == "ratelimit@example.test":
            return error_body("signup_rate_limit_exceeded", 429, email)
        attempt = {
            "object": "sign_up_attempt",
            "id": f"sua_{STATE['next_attempt']}",
            "status": "missing_requirements",
            "required_fields": ["email_address"],
            "missing_fields": [],
            "unverified_fields": ["email_address"],
            "verifications": {"email_address": None},
            "created_session_id": None,
            "email": email,
            "prepared": False,
        }
        STATE["next_attempt"] += 1
        client["sign_up"] = attempt
        return 200, {"response": self._public_sign_up(attempt), "client": public_client(client)}

    def _public_sign_up(self, attempt: dict) -> dict:
        return {k: v for k, v in attempt.items() if k not in ("email", "prepared")}

    def _sign_up_prepare(self, client: dict, sign_up_id: str, form: dict):
        attempt = client.get("sign_up")
        if not attempt or attempt["id"] != sign_up_id:
            return error_body("resource_not_found", 404)
        if form.get("strategy") != "email_code":
            return error_body("form_param_missing", 422)
        attempt["prepared"] = True
        attempt["verifications"] = {"email_address": {"status": "unverified", "strategy": "email_code"}}
        return 200, {"response": self._public_sign_up(attempt), "client": public_client(client)}

    def _sign_up_attempt(self, client: dict, sign_up_id: str, form: dict):
        attempt = client.get("sign_up")
        if not attempt or attempt["id"] != sign_up_id:
            return (*error_body("resource_not_found", 404), False)
        if not attempt["prepared"]:
            return (*error_body("verification_missing", 422), False)
        code = form.get("code", "")
        if code == "000000":
            return (*error_body("verification_expired", 422), False)
        if code != CORRECT_CODE:
            return (*error_body("form_code_incorrect", 422), False)
        attempt["unverified_fields"] = []
        attempt["verifications"] = {"email_address": {"status": "verified", "strategy": "email_code"}}
        if attempt["email"] == "incomplete@example.test":
            attempt["missing_fields"] = ["username"]
            return 200, {"response": self._public_sign_up(attempt), "client": public_client(client)}, False
        session = create_session(client, attempt["email"])
        attempt["status"] = "complete"
        attempt["created_session_id"] = session["id"]
        client["sign_up"] = None
        return 200, {"response": self._public_sign_up(attempt), "client": public_client(client)}, True

    # --- sessions --------------------------------------------------------
    def _find_session(self, client: dict, session_id: str):
        for session in client["sessions"]:
            if session["id"] == session_id:
                return session
        return None

    def _session_token(self, client: dict, session_id: str):
        session = self._find_session(client, session_id)
        if session is None:
            return error_body("session_not_found", 404)
        if session["status"] != "active":
            return error_body("authentication_invalid", 401)
        jwt = make_jwt(session, int(time.time()))
        if session["revoke_after_mint"]:
            session["status"] = "revoked"
        return 200, {"object": "token", "jwt": jwt}

    def _session_remove(self, client: dict, session_id: str):
        session = self._find_session(client, session_id)
        if session is None:
            return error_body("resource_not_found", 404)
        if session["removed_remotely"]:
            client["sessions"].remove(session)
            client["last_active_session_id"] = None
            return error_body("resource_not_found", 404)
        session["status"] = "removed"
        if client["last_active_session_id"] == session_id:
            client["last_active_session_id"] = None
        return 200, {"response": public_session(session), "client": public_client(client)}

    def _session_touch(self, client: dict, session_id: str):
        session = self._find_session(client, session_id)
        if session is None:
            return error_body("resource_not_found", 404)
        client["last_active_session_id"] = session_id
        return 200, {"response": public_session(session), "client": public_client(client)}


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # The addon closes the socket on deadline or cancel; a late write is expected.
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port-file", required=True)
    args = parser.parse_args()
    server = QuietServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    tmp = args.port_file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(str(port))
    os.replace(tmp, args.port_file)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

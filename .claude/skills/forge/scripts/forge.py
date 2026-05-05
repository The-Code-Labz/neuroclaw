#!/usr/bin/env python3
"""Forge backend client for Oracle.

Handles login + arbitrary authenticated calls against
https://forge-backend.neurolearninglabs.com

Designed to be stateless across invocations: each run does its own login
unless --token is passed.

API surface (verified 2026-05-05 against /api-docs.md):
  - /auth/login, /auth/register   (NO /auth/me — JWT carries identity)
  - /teams, /teams/{id}/join
  - /projects, /projects/{id}, /projects/runtimes
  - /projects/{id}/container/{start,stop}, DELETE container, GET container
  - /projects/{id}/files (tree), /files/{path} (read/write/delete)
  - /projects/{id}/files/move
  - /projects/{id}/exec   ← POST {command, timeout?:30} → {stdout,stderr,exit_code,ran_in}
  - WS /ws/projects/{id}/terminal?token=<jwt>
  - /health, /api-docs.md, /openapi.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

BASE_URL = os.environ.get("FORGE_BASE_URL", "https://forge-backend.neurolearninglabs.com").rstrip("/")
DEFAULT_EMAIL = os.environ.get("FORGE_EMAIL", "oracle@neurolearninglabs.com")
DEFAULT_PASSWORD = os.environ.get("FORGE_PASSWORD", "OracleForge2026!")
TIMEOUT = 30


def _request(method: str, path: str, *, token: str | None = None, body: Any = None, timeout: int = TIMEOUT) -> tuple[int, dict | str]:
    url = path if path.startswith("http") else f"{BASE_URL}{path if path.startswith('/') else '/' + path}"
    headers = {"Accept": "application/json", "User-Agent": "oracle-forge-client/0.2"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        status = e.code
    except Exception as e:  # network/DNS/etc.
        return 0, {"error": f"{type(e).__name__}: {e}"}
    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        parsed = raw
    return status, parsed


def _extract_token(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    for key in ("token", "access_token", "accessToken", "jwt", "id_token"):
        v = payload.get(key)
        if isinstance(v, str) and v:
            return v
    data = payload.get("data")
    if isinstance(data, dict):
        return _extract_token(data)
    return None


def _login(email: str, password: str) -> tuple[str | None, dict | str, int]:
    status, body = _request("POST", "/auth/login", body={"email": email, "password": password})
    return _extract_token(body), body, status


def _ensure_token(args) -> tuple[str | None, dict]:
    """Return (token, error_dict). On success error_dict is empty."""
    if args.token:
        return args.token, {}
    token, body, status = _login(args.email, args.password)
    if not token:
        return None, {"ok": False, "stage": "login", "status": status, "response": body}
    return token, {}


def cmd_login(args) -> int:
    status, body = _request("POST", "/auth/login", body={"email": args.email, "password": args.password})
    token = _extract_token(body)
    out = {
        "ok": status == 200 and bool(token),
        "status": status,
        "base_url": BASE_URL,
        "email": args.email,
        "token_preview": (token[:12] + "…" + token[-6:]) if token else None,
        "response": body,
    }
    print(json.dumps(out, indent=2, default=str))
    return 0 if out["ok"] else 1


def cmd_request(args) -> int:
    token, err = _ensure_token(args)
    if err:
        print(json.dumps(err, indent=2, default=str))
        return 1
    body = None
    if args.json:
        try:
            body = json.loads(args.json)
        except json.JSONDecodeError as e:
            print(json.dumps({"ok": False, "error": f"invalid --json: {e}"}, indent=2))
            return 2
    status, resp = _request(args.method, args.path, token=token, body=body)
    print(json.dumps({"ok": 200 <= status < 300, "status": status, "path": args.path, "response": resp}, indent=2, default=str))
    return 0 if 200 <= status < 300 else 1


def cmd_smoke(args) -> int:
    """Probe known-good endpoints. No /auth/me — that endpoint doesn't exist."""
    token, body, login_status = _login(args.email, args.password)
    result: dict = {
        "ok": False,
        "base_url": BASE_URL,
        "email": args.email,
        "login": {
            "status": login_status,
            "token_preview": (token[:12] + "…" + token[-6:]) if token else None,
            "response_keys": list(body.keys()) if isinstance(body, dict) else None,
            "response": body if not token else None,
        },
    }
    if not token:
        print(json.dumps(result, indent=2, default=str))
        return 1
    health_status, health_body = _request("GET", "/health", token=token)
    teams_status, teams_body = _request("GET", "/teams", token=token)
    projects_status, projects_body = _request("GET", "/projects", token=token)
    runtimes_status, runtimes_body = _request("GET", "/projects/runtimes", token=token)
    result["health"] = {"status": health_status, "response": health_body}
    result["teams"] = {"status": teams_status, "count": len(teams_body) if isinstance(teams_body, list) else None}
    result["projects"] = {"status": projects_status, "count": len(projects_body) if isinstance(projects_body, list) else None,
                          "summary": [{"id": p.get("id"), "name": p.get("name"), "team_id": p.get("team_id"), "container_port": p.get("container_port")}
                                      for p in projects_body] if isinstance(projects_body, list) else None}
    result["runtimes"] = {"status": runtimes_status, "response": runtimes_body}
    result["ok"] = all(s == 200 for s in (login_status, health_status, teams_status, projects_status, runtimes_status))
    print(json.dumps(result, indent=2, default=str))
    return 0 if result["ok"] else 1


def cmd_exec(args) -> int:
    """Convenience: POST /projects/{id}/exec with command + timeout."""
    token, err = _ensure_token(args)
    if err:
        print(json.dumps(err, indent=2, default=str))
        return 1
    status, resp = _request(
        "POST",
        f"/projects/{args.project_id}/exec",
        token=token,
        body={"command": args.command, "timeout": args.timeout},
        timeout=args.timeout + 10,
    )
    print(json.dumps({"ok": 200 <= status < 300, "status": status, "project_id": args.project_id, "response": resp}, indent=2, default=str))
    return 0 if 200 <= status < 300 else 1


def cmd_files(args) -> int:
    """List file tree of a project."""
    token, err = _ensure_token(args)
    if err:
        print(json.dumps(err, indent=2, default=str))
        return 1
    status, resp = _request("GET", f"/projects/{args.project_id}/files", token=token)
    print(json.dumps({"ok": 200 <= status < 300, "status": status, "project_id": args.project_id, "tree": resp}, indent=2, default=str))
    return 0 if 200 <= status < 300 else 1


def cmd_read(args) -> int:
    """Read a single file. Path is relative to project root (e.g. src/main.py)."""
    token, err = _ensure_token(args)
    if err:
        print(json.dumps(err, indent=2, default=str))
        return 1
    status, resp = _request("GET", f"/projects/{args.project_id}/files/{args.path.lstrip('/')}", token=token)
    print(json.dumps({"ok": 200 <= status < 300, "status": status, "path": args.path, "content": resp}, indent=2, default=str))
    return 0 if 200 <= status < 300 else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="forge")
    parser.add_argument("--email", default=DEFAULT_EMAIL)
    parser.add_argument("--password", default=DEFAULT_PASSWORD)
    parser.add_argument("--token", default=None, help="Use this JWT instead of logging in.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("login")
    sub.add_parser("smoke", help="Probe /health, /teams, /projects, /projects/runtimes")

    rp = sub.add_parser("request")
    rp.add_argument("method")
    rp.add_argument("path")
    rp.add_argument("--json", default=None, help="JSON body string")

    ep = sub.add_parser("exec", help="POST /projects/{id}/exec")
    ep.add_argument("project_id", type=int)
    ep.add_argument("command")
    ep.add_argument("--timeout", type=int, default=30)

    fp = sub.add_parser("files", help="GET /projects/{id}/files (tree)")
    fp.add_argument("project_id", type=int)

    readp = sub.add_parser("read", help="GET /projects/{id}/files/{path}")
    readp.add_argument("project_id", type=int)
    readp.add_argument("path")

    args = parser.parse_args(argv)
    return {
        "login": cmd_login,
        "smoke": cmd_smoke,
        "request": cmd_request,
        "exec": cmd_exec,
        "files": cmd_files,
        "read": cmd_read,
    }[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

# SPDX-License-Identifier: LicenseRef-OQL-1.3
"""Simple, opt-out, privacy-respecting census for self-hosted instances.

Design goals:
- Opt-out by default; disable with env var.
- Minimal data: hashed instance id, coarse UTC date, project name.
- Non-blocking and fail-silent.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

_DEFAULT_ENDPOINT = "https://telemetry.namelessnanashi.dev/census"
_PROJECT_NAME = "<PROJECT_NAME>"
_OPTOUT_ENV_VAR = "<PROJECT_ACRONYM>_TELEMETRY_OPTOUT"
_HAS_SCHEDULED_SEND = False
_PERIOD_HOURS = 2  # send every 2 hours (on the hour, UTC)
_HAS_LOGGED_SCHEDULE = False
_HAS_LOGGED_SKIP = False
_HAS_LOGGED_NO_PROJECT = False

_log = logging.getLogger("telemetry")


def _env_truthy(v: Optional[str]) -> bool:
    s = (v or "").strip().lower()
    return s in ("1", "true", "yes", "on", "y", "t")


def _env_falsy(v: Optional[str]) -> bool:
    s = (v or "").strip().lower()
    return s in ("0", "false", "no", "off", "n", "f")


def _env_opt_out() -> bool:
    if _env_truthy(os.getenv(_OPTOUT_ENV_VAR)) or _env_truthy(
        os.getenv("TELEMETRY_OPTOUT")
    ):
        return True
    tel = os.getenv("TELEMETRY")
    if tel is not None and _env_falsy(tel):
        return True
    return False


def _get_endpoint() -> str:
    ep = os.getenv("TELEMETRY_ENDPOINT") or _DEFAULT_ENDPOINT
    return ep


def _get_project_name() -> str:
    return _PROJECT_NAME


def _get_state_file() -> str:
    # Allow overriding the state file path for containerized deployments
    env_file = os.getenv("TELEMETRY_STATE_FILE")
    if env_file:
        try:
            _log.debug("telemetry state file (TELEMETRY_STATE_FILE) -> %s", env_file)
        except Exception:
            pass
        return env_file
    env_dir = os.getenv("TELEMETRY_STATE_DIR")
    if env_dir:
        p = os.path.join(env_dir, ".telemetry_id")
        try:
            _log.debug("telemetry state dir (TELEMETRY_STATE_DIR) -> %s", p)
        except Exception:
            pass
        return p
    return os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", ".telemetry_id")
    )


def _ensure_instance_id() -> str:
    path = _get_state_file()
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                raw = fh.read().strip()
                if raw:
                    try:
                        _log.debug("telemetry id file exists at %s", path)
                    except Exception:
                        pass
                    return raw
        new = str(uuid.uuid4())
        # Ensure parent directory exists when using a custom path/dir
        try:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        except Exception:
            try:
                _log.debug("telemetry could not create parent dir for %s", path)
            except Exception:
                pass
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(new)
        try:
            _log.debug("telemetry created id file at %s", path)
        except Exception:
            pass
        return new
    except Exception:
        try:
            _log.debug(
                "telemetry failed to persist id file at %s; using ephemeral id", path
            )
        except Exception:
            pass
        return str(uuid.uuid4())


def _hash_id(raw: str) -> str:
    h = hashlib.sha256()
    h.update(raw.encode("utf-8"))
    return h.hexdigest()


def _get_version() -> Optional[str]:
    try:
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        vf = os.path.join(repo_root, "VERSION")
        if os.path.exists(vf):
            with open(vf, "r", encoding="utf-8") as fh:
                return fh.read().strip()
    except Exception:
        pass
    return None


def _make_payload() -> dict:
    rid = _ensure_instance_id()
    payload = {
        "id": _hash_id(rid),
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "projectname": _get_project_name(),
        "project": _get_project_name(),
        "count": 1,
    }
    return payload


def _post_sync(url: str, data: bytes, timeout: float = 2.0) -> None:
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            _ = resp.status
    except urllib.error.URLError:
        return
    except Exception:
        return


async def maybe_send_telemetry_async() -> None:
    endpoint = _get_endpoint()
    if not endpoint or _env_opt_out():
        global _HAS_LOGGED_SKIP
        try:
            if not _HAS_LOGGED_SKIP:
                _HAS_LOGGED_SKIP = True
                _log.info(
                    "[telemetry] skipped (endpoint_configured=%s, opted_out=%s)",
                    bool(endpoint),
                    _env_opt_out(),
                )
            else:
                _log.debug(
                    "telemetry skipped (endpoint=%s, opted_out=%s)",
                    bool(endpoint),
                    _env_opt_out(),
                )
        except Exception:
            pass
        return
    # Require explicit project name; skip if missing
    project = _get_project_name()
    if not project:
        global _HAS_LOGGED_NO_PROJECT
        try:
            if not _HAS_LOGGED_NO_PROJECT:
                _HAS_LOGGED_NO_PROJECT = True
                _log.info("[telemetry] skipped (missing PROJECT_NAME)")
            else:
                _log.debug("telemetry skipped (missing PROJECT_NAME)")
        except Exception:
            pass
        return
    data = json.dumps(_make_payload(), separators=(",", ":")).encode("utf-8")
    try:
        loop = asyncio.get_running_loop()
        try:
            _log.debug("telemetry POST -> %s (async, %d bytes)", endpoint, len(data))
        except Exception:
            pass
        await loop.run_in_executor(None, _post_sync, endpoint, data)
    except Exception:
        return


def _seconds_until_next_even_utc_hour() -> float:
    """Return seconds until the next even UTC hour boundary (00,02,...,22).

    If called exactly at an even boundary, schedule for the next even boundary (i.e., +2h),
    to avoid double-sending (startup + boundary).
    """
    now = datetime.now(timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0)
    if now <= base:
        # Exactly on the hour (or extremely close rounding down)
        if base.hour % 2 == 0:
            nxt = base + timedelta(hours=2)
        else:
            nxt = base + timedelta(hours=1)
    else:
        # After the hour; choose next even boundary
        if base.hour % 2 == 0:
            nxt = base + timedelta(hours=2)
        else:
            nxt = base + timedelta(hours=1)
    delta = (nxt - now).total_seconds()
    return max(1.0, delta)


async def _periodic_ping_loop() -> None:
    """Background loop that sends telemetry every 2 hours aligned to UTC even hours."""
    while True:
        try:
            sleep_s = _seconds_until_next_even_utc_hour()
            await asyncio.sleep(sleep_s)
            if _env_opt_out():
                continue
            await maybe_send_telemetry_async()
        except asyncio.CancelledError:
            return
        except Exception:
            # Swallow errors and continue; small backoff to avoid tight loop
            try:
                await asyncio.sleep(60)
            except Exception:
                return


def maybe_send_telemetry_background() -> None:
    global _HAS_SCHEDULED_SEND
    if _HAS_SCHEDULED_SEND:
        return
    _HAS_SCHEDULED_SEND = True
    # Ensure the local instance ID file exists early, even if opted out.
    try:
        path = _get_state_file()
        _ = _ensure_instance_id()
        try:
            _log.info("[telemetry] initialized state file at %s", path)
        except Exception:
            pass
    except Exception:
        pass
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # Fire-and-forget immediate send
            try:
                global _HAS_LOGGED_SCHEDULE
                if not _HAS_LOGGED_SCHEDULE:
                    _HAS_LOGGED_SCHEDULE = True
                    _log.info(
                        "[telemetry] scheduling immediate send and 2h periodic loop (UTC aligned)"
                    )
                else:
                    _log.debug("telemetry scheduling immediate send + periodic loop")
            except Exception:
                pass
            asyncio.ensure_future(maybe_send_telemetry_async())
            # Also schedule a periodic background ping aligned to UTC even hours (once per process)
            try:
                asyncio.ensure_future(_periodic_ping_loop())
            except Exception:
                # If scheduling fails, don't prevent the immediate send
                pass
    except Exception:
        try:
            _post_sync(_get_endpoint(), json.dumps(_make_payload()).encode("utf-8"))
        except Exception:
            pass


__all__ = ("maybe_send_telemetry_background", "maybe_send_telemetry_async")

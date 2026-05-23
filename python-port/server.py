#!/usr/bin/env python3
"""MCP server for Philippe's Pomodoro Focus (AgenticFocus) app.

Exposes safe tools for Hermes/Claude/etc. to interact with the Supabase-backed
Pomodoro Focus application via PostgREST.

Security model:
- Requires an anon key or user JWT in env.
- Uses Philippe's fixed user_id and source='hermes' by default for created tasks.
- Does not print or return secrets.

Sprint 21 Story 23-7 (2026-05-15) — patched for env alias parity with Node Sprint 21:
  - SUPABASE_URL  OR POMODORO_SUPABASE_URL
  - SUPABASE_ANON_KEY OR POMODORO_SUPABASE_ANON_KEY
  - USER_ID OR POMODORO_USER_ID
  - SUPABASE_USER_JWT (optional — if present, used as Authorization Bearer; else fallback anon)
  - Added list_projects tool + Node-style aliases create_day_task / list_today_tasks.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP


def _env(name_primary: str, name_fallback: str | None = None, default: str | None = None) -> str | None:
    """Read env var with backward-compat fallback. Sprint 21 alignment Node Sprint 21."""
    val = os.getenv(name_primary)
    if val:
        return val
    if name_fallback:
        val = os.getenv(name_fallback)
        if val:
            return val
    return default


SUPABASE_URL = (_env("POMODORO_SUPABASE_URL", "SUPABASE_URL",
                     "https://tdaeuvmmbasuqdlmobhl.supabase.co") or "").rstrip("/")
SUPABASE_ANON_KEY = _env("POMODORO_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY")
SUPABASE_USER_JWT = os.getenv("SUPABASE_USER_JWT")  # optional, no alias
USER_ID = _env("POMODORO_USER_ID", "USER_ID",
               "d9dd9a28-ec9c-4a67-9253-f673021c1611")

DAY_TASKS_URL = f"{SUPABASE_URL}/rest/v1/day_tasks"
SUBTASKS_URL = f"{SUPABASE_URL}/rest/v1/subtasks"
PROJECTS_URL = f"{SUPABASE_URL}/rest/v1/projects"

Impact = Literal["low", "medium", "high"]
Urgency = Literal["low", "medium", "high"]
KanbanStatus = Literal["backlog", "todo", "doing", "done"]

mcp = FastMCP("pomodoro-focus")


def _require_key() -> str:
    if not SUPABASE_ANON_KEY:
        raise RuntimeError(
            "Missing POMODORO_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY). "
            "Configure it in the MCP server env."
        )
    return SUPABASE_ANON_KEY


def _headers(prefer: str | None = None) -> dict[str, str]:
    """Build PostgREST headers.

    Auth strategy (Sprint 21 alignment):
      - apikey header: always anon key (PostgREST requires apikey)
      - Authorization Bearer: prefer SUPABASE_USER_JWT (user-scoped, RLS strict),
        fallback to anon key (POC permissive mode).
    """
    anon = _require_key()
    bearer = SUPABASE_USER_JWT or anon
    headers = {
        "apikey": anon,
        "Authorization": f"Bearer {bearer}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def _request_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | list[dict[str, Any]] | None = None,
    prefer: str | None = None,
) -> Any:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=_headers(prefer))
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase HTTP {exc.code}: {body[:1000]}") from exc


def _today() -> str:
    return dt.datetime.now().date().isoformat()


def _epoch_ms() -> int:
    return int(time.time() * 1000)


def _query(params: dict[str, str]) -> str:
    return urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


# ─── Tools ────────────────────────────────────────────────────────────────────

@mcp.tool()
def health_check() -> dict[str, Any]:
    """Check whether the Pomodoro Focus MCP server is configured and can reach Supabase."""
    params = _query({"select": "id", "user_id": f"eq.{USER_ID}", "limit": "1"})
    rows = _request_json(f"{DAY_TASKS_URL}?{params}")
    return {
        "status": "ok",
        "supabase_url": SUPABASE_URL,
        "auth_mode": "user_jwt" if SUPABASE_USER_JWT else "anon",
        "visible_rows_sample": len(rows or []),
    }


@mcp.tool()
def list_tasks(
    date: str | None = None,
    source: str | None = None,
    include_completed: bool = True,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List Pomodoro Focus day tasks for Philippe.

    Args:
        date: YYYY-MM-DD. Defaults to today.
        source: Optional source filter, e.g. 'hermes'. Leave empty to list all visible tasks allowed by RLS.
        include_completed: If false, only returns incomplete tasks.
        limit: Maximum rows, capped to 200.
    """
    params = {
        "select": "id,date,name,planned_pomodoros,completed_pomodoros,is_completed,position,source,note,impact,urgency,story_points,domain_id,project_id",
        "user_id": f"eq.{USER_ID}",
        "date": f"eq.{date or _today()}",
        "order": "position.asc,created_at.asc",
        "limit": str(min(max(limit, 1), 200)),
    }
    if source:
        params["source"] = f"eq.{source}"
    if not include_completed:
        params["is_completed"] = "eq.false"
    return _request_json(f"{DAY_TASKS_URL}?{_query(params)}") or []


@mcp.tool()
def create_task(
    name: str,
    date: str | None = None,
    note: str | None = None,
    pomodoros: int = 1,
    impact: Impact = "medium",
    urgency: Urgency = "medium",
    story_points: int = 0,
    domain_id: str | None = None,
    project_id: str | None = None,
    allow_duplicate: bool = False,
) -> dict[str, Any]:
    """Create a Pomodoro Focus task with duplicate protection for same day/name/source."""
    task_date = date or _today()
    clean_name = (name or "").strip()
    if not clean_name:
        raise ValueError("Task name cannot be empty")

    existing = list_tasks(date=task_date, source="hermes", include_completed=True, limit=200)
    if not allow_duplicate:
        for task in existing:
            if (task.get("name") or "").strip() == clean_name:
                return {"status": "duplicate_skipped", "task": task}

    now = _epoch_ms()
    payload: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "user_id": USER_ID,
        "date": task_date,
        "name": clean_name,
        "planned_pomodoros": max(1, int(pomodoros or 1)),
        "completed_pomodoros": 0,
        "position": len(existing),
        "created_at": now,
        "updated_at": now,
        "is_completed": False,
        "story_points": max(0, int(story_points or 0)),
        "source": "hermes",
        "note": note,
        "impact": impact,
        "urgency": urgency,
    }
    if domain_id:
        payload["domain_id"] = domain_id
    if project_id:
        payload["project_id"] = project_id  # Sprint 20 Mode Projet integration

    created = _request_json(DAY_TASKS_URL, method="POST", payload=payload, prefer="return=representation")
    return {"status": "created", "task": created[0] if created else payload}


@mcp.tool()
def complete_task(task_id: str) -> dict[str, Any]:
    """Mark a visible Pomodoro Focus task as completed.

    Requires an RLS UPDATE policy for Philippe's user_id; otherwise Supabase will reject it.
    """
    now = _epoch_ms()
    payload = {"is_completed": True, "updated_at": now}
    url = f"{DAY_TASKS_URL}?{_query({'id': f'eq.{task_id}', 'user_id': f'eq.{USER_ID}'})}"
    updated = _request_json(url, method="PATCH", payload=payload, prefer="return=representation")
    return {"status": "completed", "task": updated[0] if updated else None}


@mcp.tool()
def add_subtask(task_id: str, title: str, position: int | None = None) -> dict[str, Any]:
    """Add a subtask to an existing Pomodoro Focus task."""
    clean_title = (title or "").strip()
    if not clean_title:
        raise ValueError("Subtask title cannot be empty")

    params = _query({"select": "id,title,position", "task_id": f"eq.{task_id}", "user_id": f"eq.{USER_ID}", "order": "position.asc"})
    existing = _request_json(f"{SUBTASKS_URL}?{params}") or []
    for subtask in existing:
        if (subtask.get("title") or "").strip() == clean_title:
            return {"status": "duplicate_skipped", "subtask": subtask}

    now = _epoch_ms()
    payload = {
        "id": str(uuid.uuid4()),
        "user_id": USER_ID,
        "task_id": task_id,
        "title": clean_title,
        "is_completed": False,
        "position": len(existing) if position is None else int(position),
        "created_at": now,
        "updated_at": now,
    }
    created = _request_json(SUBTASKS_URL, method="POST", payload=payload, prefer="return=representation")
    return {"status": "created", "subtask": created[0] if created else payload}


# ─── Sprint 21 Story 23-6/23-7 additions ─────────────────────────────────────

@mcp.tool()
def list_projects(
    include_archived: bool = False,
    kanban_status: KanbanStatus | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List Philippe's Kanban projects (Mode Projet).

    Args:
        include_archived: Include archived projects (default False).
        kanban_status: Filter by Kanban column (backlog/todo/doing/done). Optional.
        limit: Max projects (capped 500).

    Returns rows with id, name, description, kanban_status, kanban_position,
    target_date, domain_id, is_archived, tag_ids, started_at, finished_at,
    created_at, updated_at.
    """
    params = {
        "select": "id,name,description,kanban_status,kanban_position,target_date,domain_id,is_archived,tag_ids,started_at,finished_at,created_at,updated_at",
        "user_id": f"eq.{USER_ID}",
        "order": "kanban_status,kanban_position",
        "limit": str(min(max(limit, 1), 500)),
    }
    if not include_archived:
        params["is_archived"] = "eq.false"
    if kanban_status:
        params["kanban_status"] = f"eq.{kanban_status}"
    return _request_json(f"{PROJECTS_URL}?{_query(params)}") or []


# ─── Node Sprint 21 naming aliases ───────────────────────────────────────────
# These wrappers expose the same tool semantics under Node-style names, for
# consistency with the Node POC server (mcp-server/src/index.ts). Hermes will
# discover them with prefix mcp_agenticfocus_<name>.

@mcp.tool()
def create_day_task(
    name: str,
    date: str | None = None,
    planned_pomodoros: int = 1,
    project_id: str | None = None,
    domain_id: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Alias for create_task using Node Sprint 21 naming (planned_pomodoros instead of pomodoros)."""
    return create_task(
        name=name,
        date=date,
        note=note,
        pomodoros=planned_pomodoros,
        domain_id=domain_id,
        project_id=project_id,
    )


@mcp.tool()
def list_today_tasks(include_completed: bool = True) -> list[dict[str, Any]]:
    """Alias for list_tasks(date=today) using Node Sprint 21 naming."""
    return list_tasks(date=_today(), include_completed=include_completed, limit=50)


if __name__ == "__main__":
    mcp.run()

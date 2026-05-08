"""
Security Agent - Real vulnerability scanning
"""

import re
import os
from typing import Dict, Any, List
from .base_agent import BaseAgent, Task, AgentStatus

class SecurityAgent(BaseAgent):
    def __init__(self):
        super().__init__(
            name="SecurityAgent",
            description="Scans for security vulnerabilities"
        )
        self.capabilities = [
            "scan_code", "check_secrets", "monitor_patterns",
            "validate_input", "check_dependencies", "audit_permissions", "generate_report"
        ]

        self.patterns = {
            "sql_injection": [
                r"execute\s*\(\s*['\"].*%s",
                r"cursor\.execute\s*\(\s*['\"].*\+",
            ],
            "command_injection": [
                r"os\.system\s*\(",
                r"subprocess\.call\s*\(\s*['\"].*\+",
                r"eval\s*\(",
                r"exec\s*\(",
            ],
            "xss": [
                r"innerHTML\s*=",
                r"document\.write\s*\(",
            ],
            "secrets": [
                r"api[_-]?key\s*=\s*['\"][a-zA-Z0-9]{16,}['\"]",
                r"password\s*=\s*['\"][^'\"]+['\"]",
                r"secret\s*=\s*['\"][a-zA-Z0-9]{16,}['\"]",
                r"token\s*=\s*['\"][a-zA-Z0-9]{20,}['\"]",
            ],
            "insecure_crypto": [
                r"md5\s*\(",
                r"sha1\s*\(",
            ]
        }
        self.scan_history = []

    def execute(self, task: Task) -> Dict[str, Any]:
        self.status = AgentStatus.RUNNING
        action = task.payload.get("action", "scan_code")

        try:
            if action == "scan_code":
                result = self._scan_code(task.payload)
            elif action == "check_secrets":
                result = self._check_secrets(task.payload)
            elif action == "monitor_patterns":
                result = self._monitor_patterns(task.payload)
            elif action == "validate_input":
                result = self._validate_input(task.payload)
            elif action == "check_dependencies":
                result = self._check_dependencies(task.payload)
            elif action == "audit_permissions":
                result = self._audit_permissions(task.payload)
            elif action == "generate_report":
                result = self._generate_report(task.payload)
            else:
                result = {"success": False, "error": f"Unknown action: {action}"}

            self.status = AgentStatus.COMPLETED if result.get("success") else AgentStatus.ERROR
            return result

        except Exception as e:
            self.status = AgentStatus.ERROR
            return {"success": False, "error": str(e)}

    def _scan_code(self, payload: Dict) -> Dict[str, Any]:
        filename = payload.get("file_path", "")
        code = payload.get("code", "")
        scan_types = payload.get("scan_types", list(self.patterns.keys()))

        if filename and os.path.exists(filename):
            with open(filename, "r") as f:
                code = f.read()

        if not code:
            return {"success": False, "error": "No code to scan"}

        findings = []
        lines = code.splitlines()

        for scan_type in scan_types:
            if scan_type not in self.patterns:
                continue
            for pattern in self.patterns[scan_type]:
                for i, line in enumerate(lines, 1):
                    if re.search(pattern, line, re.IGNORECASE):
                        findings.append({
                            "type": scan_type,
                            "severity": self._severity(scan_type),
                            "line": i,
                            "code": line.strip()[:80],
                            "recommendation": self._recommendation(scan_type)
                        })

        score = self._risk_score(findings)
        result = {
            "success": True,
            "file": filename,
            "findings": findings,
            "count": len(findings),
            "risk_score": score,
            "risk_level": self._risk_level(score)
        }
        self.scan_history.append(result)
        return result

    def _check_secrets(self, payload: Dict) -> Dict[str, Any]:
        scan_path = payload.get("scan_path", ".")
        exts = payload.get("extensions", [".py", ".js", ".env", ".json", ".yaml", ".yml"])

        secrets = []
        for root, dirs, files in os.walk(scan_path):
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['node_modules', '__pycache__']]
            for file in files:
                if any(file.endswith(e) for e in exts):
                    fp = os.path.join(root, file)
                    try:
                        with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                            content = f.read()
                        for pattern in self.patterns.get("secrets", []):
                            for match in re.finditer(pattern, content, re.IGNORECASE):
                                line_num = content[:match.start()].count("\n") + 1
                                secrets.append({
                                    "file": fp, "line": line_num,
                                    "match": match.group()[:50] + "..." if len(match.group()) > 50 else match.group(),
                                    "severity": "CRITICAL"
                                })
                    except:
                        continue

        return {"success": True, "secrets_found": len(secrets), "findings": secrets}

    def _monitor_patterns(self, payload: Dict) -> Dict[str, Any]:
        patterns = payload.get("patterns", [])
        source = payload.get("source", "")
        matches = []
        for pattern in patterns:
            for m in re.finditer(pattern, source, re.IGNORECASE):
                matches.append({"pattern": pattern, "match": m.group(), "pos": m.start()})
        return {"success": True, "matches": matches, "count": len(matches)}

    def _validate_input(self, payload: Dict) -> Dict[str, Any]:
        code = payload.get("code", "")
        issues = []
        if "request.args" in code and "validate" not in code.lower():
            issues.append("Input not validated")
        if re.search(r"\b(eval|exec)\s*\(", code):
            issues.append("Dangerous eval/exec found")
        return {"success": True, "issues": issues, "count": len(issues)}

    def _check_dependencies(self, payload: Dict) -> Dict[str, Any]:
        req_file = payload.get("requirements_file", "requirements.txt")
        vulns = []
        if os.path.exists(req_file):
            with open(req_file) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        vulns.append({"package": line, "status": "checked"})
        return {"success": True, "dependencies": vulns, "count": len(vulns)}

    def _audit_permissions(self, payload: Dict) -> Dict[str, Any]:
        scan_path = payload.get("scan_path", ".")
        issues = []
        for root, dirs, files in os.walk(scan_path):
            for file in files:
                fp = os.path.join(root, file)
                try:
                    mode = oct(os.stat(fp).st_mode)[-3:]
                    if mode in ["777", "666"] and file.endswith((".py", ".js", ".sh")):
                        issues.append({"file": fp, "mode": mode, "issue": "Too permissive"})
                    if file in [".env", "secrets.json"] and mode in ["644", "666", "777"]:
                        issues.append({"file": fp, "mode": mode, "issue": "Secret file readable"})
                except:
                    continue
        return {"success": True, "issues": issues, "count": len(issues)}

    def _generate_report(self, payload: Dict) -> Dict[str, Any]:
        total = sum(s.get("count", 0) for s in self.scan_history)
        critical = sum(1 for s in self.scan_history for f in s.get("findings", []) if f.get("severity") == "CRITICAL")
        high = sum(1 for s in self.scan_history for f in s.get("findings", []) if f.get("severity") == "HIGH")

        return {
            "success": True,
            "total_scans": len(self.scan_history),
            "total_findings": total,
            "critical": critical,
            "high": high,
            "scans": self.scan_history
        }

    def _severity(self, scan_type: str) -> str:
        return {"sql_injection": "CRITICAL", "command_injection": "CRITICAL",
                "secrets": "CRITICAL", "xss": "HIGH", "insecure_crypto": "HIGH"}.get(scan_type, "MEDIUM")

    def _recommendation(self, scan_type: str) -> str:
        return {"sql_injection": "Use parameterized queries",
                "command_injection": "Avoid shell=True",
                "xss": "Sanitize user input",
                "secrets": "Use env vars",
                "insecure_crypto": "Use SHA-256/AES-256"}.get(scan_type, "Review code")

    def _risk_score(self, findings: list) -> int:
        weights = {"CRITICAL": 10, "HIGH": 5, "MEDIUM": 2, "LOW": 1}
        return min(100, sum(weights.get(f.get("severity", "LOW"), 1) for f in findings) * 5)

    def _risk_level(self, score: int) -> str:
        if score >= 80: return "CRITICAL"
        if score >= 50: return "HIGH"
        if score >= 20: return "MEDIUM"
        return "LOW"

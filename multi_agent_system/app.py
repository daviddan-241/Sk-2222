"""
Flask Chat App — multi-agent AI chat with streaming, file uploads, terminal, GitHub import.
"""

import io
import json
import os
import queue
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from typing import Dict, Any, Optional

from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from flask_cors import CORS

from agents import CoordinatorAgent

# ── APP SETUP ──
app = Flask(__name__)
CORS(app)

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'uploads')
GIT_DIR    = os.path.join(os.path.dirname(__file__), 'git_imports')
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(GIT_DIR,    exist_ok=True)

# ── GLOBAL AGENT ──
coordinator = CoordinatorAgent()

# ── BACKGROUND TASK BUFFER ──
# Maps task_id → { 'chunks': [...], 'done': bool, 'queue': queue.Queue, 'stopped': bool }
_tasks: Dict[str, Dict[str, Any]] = {}
_tasks_lock = threading.Lock()


def _new_task(task_id: str) -> Dict[str, Any]:
    t = {
        'id':      task_id,
        'chunks':  [],
        'done':    False,
        'stopped': False,
        'queue':   queue.Queue(),
        'created': time.time(),
    }
    with _tasks_lock:
        _tasks[task_id] = t
    # Prune old tasks (keep last 50)
    with _tasks_lock:
        if len(_tasks) > 50:
            oldest = sorted(_tasks.keys(), key=lambda k: _tasks[k]['created'])
            for k in oldest[:-50]:
                del _tasks[k]
    return t


def _run_chat_task(task_id: str, message: str, conversation: list,
                   file_context: Optional[str], image_b64: Optional[str], image_mime: Optional[str]):
    """Run coordinator.chat_stream in a background thread, buffering chunks."""
    t = _tasks.get(task_id)
    if not t:
        return
    try:
        for raw_chunk in coordinator.chat_stream(
            message=message,
            conversation=conversation,
            file_context=file_context,
            image_b64=image_b64,
            image_mime=image_mime,
        ):
            if t['stopped']:
                break
            t['chunks'].append(raw_chunk)
            t['queue'].put(raw_chunk)
    except Exception as e:
        err_chunk = json.dumps({'type': 'content', 'content': f'\n[Error: {e}]'})
        t['chunks'].append(err_chunk)
        t['queue'].put(err_chunk)
    finally:
        t['done'] = True
        t['queue'].put(None)  # sentinel


# ── SSE HELPER ──
def _sse(data: str) -> str:
    return f'data: {data}\n\n'


# ── ROUTES ──
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/status')
def status():
    return jsonify(coordinator.get_system_status())


@app.route('/api/chat/stream', methods=['POST'])
def chat_stream():
    body         = request.get_json(force=True) or {}
    message      = body.get('message', '')
    conversation = body.get('conversation', [])
    file_context = body.get('file_context')
    image_b64    = body.get('image_b64')
    image_mime   = body.get('image_mime')

    if not message:
        return jsonify({'error': 'No message'}), 400

    task_id = uuid.uuid4().hex
    task    = _new_task(task_id)

    # Start background thread
    t = threading.Thread(
        target=_run_chat_task,
        args=(task_id, message, conversation, file_context, image_b64, image_mime),
        daemon=True,
    )
    t.start()

    def generate():
        # Send task_id first so client can reconnect if needed
        yield _sse(json.dumps({'type': 'task_id', 'task_id': task_id}))
        yield _sse(json.dumps({'type': 'agent', 'agent': 'coordinator'}))

        while True:
            try:
                chunk = task['queue'].get(timeout=90)
            except queue.Empty:
                break
            if chunk is None:
                break
            yield _sse(chunk)

        yield _sse(json.dumps({'done': True}))
        yield _sse('[DONE]')

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control':     'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection':        'keep-alive',
        }
    )


@app.route('/api/tasks/<task_id>/stream')
def task_stream(task_id: str):
    """Reconnect to a running or completed task stream."""
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    def generate():
        # First replay already-buffered chunks
        for chunk in list(task['chunks']):
            yield _sse(chunk)
        # If still running, subscribe to new chunks
        if not task['done']:
            local_q: queue.Queue = queue.Queue()

            # Simple subscription: poll task queue by patching
            # We re-stream by polling since we can't easily add a second queue listener.
            # Instead we just wait for task to finish and stream remaining.
            start_idx = len(task['chunks'])
            while not task['done']:
                time.sleep(0.05)
                new_chunks = task['chunks'][start_idx:]
                for c in new_chunks:
                    yield _sse(c)
                start_idx = len(task['chunks'])

        yield _sse(json.dumps({'done': True}))
        yield _sse('[DONE]')

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control':     'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection':        'keep-alive',
        }
    )


@app.route('/api/tasks/<task_id>/stop', methods=['POST'])
def task_stop(task_id: str):
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    task['stopped'] = True
    task['done']    = True
    task['queue'].put(None)
    return jsonify({'ok': True})


@app.route('/api/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file'}), 400

    f        = request.files['file']
    filename = f.filename or 'upload'
    ext      = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    uid      = uuid.uuid4().hex[:8]
    safe     = f'{uid}_{filename}'
    path     = os.path.join(UPLOAD_DIR, safe)
    f.save(path)
    size = os.path.getsize(path)

    IMAGE_EXTS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'}
    TEXT_EXTS  = {'txt', 'md', 'py', 'js', 'ts', 'html', 'css', 'json', 'yaml', 'yml',
                  'csv', 'xml', 'sh', 'bash', 'go', 'rs', 'rb', 'java', 'c', 'cpp', 'h',
                  'sql', 'toml', 'ini', 'cfg', 'env', 'log'}

    if ext in IMAGE_EXTS:
        import base64
        with open(path, 'rb') as fh:
            b64 = base64.b64encode(fh.read()).decode()
        mime_map = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
                    'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml'}
        mime = mime_map.get(ext, 'image/png')
        return jsonify({'success': True, 'type': 'image', 'filename': filename,
                        'b64': b64, 'mime': mime, 'size': size, 'ext': ext})

    if ext == 'zip':
        extract_dir = os.path.join(UPLOAD_DIR, uid + '_extracted')
        os.makedirs(extract_dir, exist_ok=True)
        try:
            with zipfile.ZipFile(path, 'r') as zf:
                zf.extractall(extract_dir)
            content = _read_dir_as_text(extract_dir, max_chars=80000)
            return jsonify({'success': True, 'type': 'zip', 'filename': filename,
                            'content': content, 'size': size, 'ext': ext,
                            'saved_path': path})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    # Text file
    if ext in TEXT_EXTS or size < 500_000:
        try:
            with open(path, 'r', errors='replace') as fh:
                content = fh.read(80000)
            return jsonify({'success': True, 'type': 'text', 'filename': filename,
                            'content': content, 'size': size, 'ext': ext,
                            'saved_path': path})
        except Exception:
            pass

    return jsonify({'success': True, 'type': 'binary', 'filename': filename,
                    'size': size, 'ext': ext, 'saved_path': path,
                    'content': f'[Binary file: {filename}, {size} bytes]'})


def _read_dir_as_text(directory: str, max_chars: int = 80000) -> str:
    parts = []
    total = 0
    TEXT_EXTS = {'.txt', '.md', '.py', '.js', '.ts', '.html', '.css', '.json',
                 '.yaml', '.yml', '.csv', '.xml', '.sh', '.go', '.rs', '.rb',
                 '.java', '.c', '.cpp', '.h', '.sql', '.toml', '.ini', '.cfg',
                 '.env', '.log', '.gitignore', '.dockerfile'}
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules', '__pycache__', '.git')]
        for fname in sorted(files):
            if total >= max_chars:
                break
            fpath = os.path.join(root, fname)
            _, fext = os.path.splitext(fname.lower())
            if fext not in TEXT_EXTS:
                continue
            rel = os.path.relpath(fpath, directory)
            try:
                with open(fpath, 'r', errors='replace') as fh:
                    content = fh.read(10000)
                chunk = f'=== {rel} ===\n{content}'
                parts.append(chunk)
                total += len(chunk)
            except Exception:
                pass
    return '\n\n'.join(parts)


@app.route('/api/shell', methods=['POST'])
def run_shell():
    body    = request.get_json(force=True) or {}
    command = body.get('command', '').strip()
    cwd     = body.get('cwd', '/home/runner/workspace')
    if not command:
        return jsonify({'success': False, 'error': 'No command'}), 400
    try:
        r = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            timeout=60, cwd=cwd
        )
        return jsonify({
            'success':    r.returncode == 0,
            'stdout':     r.stdout,
            'stderr':     r.stderr,
            'returncode': r.returncode,
        })
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'stdout': '', 'stderr': 'Timed out', 'returncode': -1})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/run-code', methods=['POST'])
def run_code():
    body    = request.get_json(force=True) or {}
    code    = body.get('code', '')
    lang    = body.get('lang', 'py')
    if not code:
        return jsonify({'success': False, 'error': 'No code'}), 400

    PY = '/home/runner/workspace/.pythonlibs/bin/python'
    if not os.path.exists(PY):
        PY = 'python3'

    cmd_map = {'py': [PY], 'js': ['node'], 'sh': ['bash']}
    cmd = cmd_map.get(lang, [PY])

    with tempfile.NamedTemporaryFile(suffix='.' + lang, delete=False, mode='w') as f:
        f.write(code)
        tmp = f.name
    try:
        r = subprocess.run(
            cmd + [tmp], capture_output=True, text=True, timeout=30
        )
        return jsonify({
            'success':    r.returncode == 0,
            'stdout':     r.stdout,
            'stderr':     r.stderr,
            'returncode': r.returncode,
            'output':     r.stdout + (('\n' + r.stderr) if r.stderr else ''),
        })
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'stdout': '', 'stderr': 'Timed out (30s)', 'returncode': -1, 'output': 'Timed out'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        try: os.unlink(tmp)
        except: pass


@app.route('/api/run-file', methods=['POST'])
def run_file():
    body = request.get_json(force=True) or {}
    path = body.get('path', '')
    if not path or not os.path.exists(path):
        return jsonify({'success': False, 'error': 'File not found'}), 400
    ext = path.rsplit('.', 1)[-1].lower()
    PY  = '/home/runner/workspace/.pythonlibs/bin/python'
    if not os.path.exists(PY): PY = 'python3'
    cmd_map = {'py': [PY, path], 'js': ['node', path], 'sh': ['bash', path]}
    cmd = cmd_map.get(ext, ['bash', path])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return jsonify({'success': r.returncode == 0, 'stdout': r.stdout,
                        'stderr': r.stderr, 'returncode': r.returncode,
                        'output': r.stdout + (('\n' + r.stderr) if r.stderr else '')})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/import-github', methods=['POST'])
def import_github():
    body = request.get_json(force=True) or {}
    raw  = body.get('url', '').strip()
    if not raw:
        return jsonify({'success': False, 'error': 'No URL provided'}), 400

    # Normalize: accept "user/repo" or full URL
    if raw.startswith('http'):
        url = raw.rstrip('/')
    else:
        url = 'https://github.com/' + raw.strip('/')

    repo_name = url.rstrip('/').split('/')[-1]
    uid       = uuid.uuid4().hex[:8]
    clone_dir = os.path.join(GIT_DIR, f'{uid}_{repo_name}')

    try:
        r = subprocess.run(
            ['git', 'clone', '--depth', '1', url, clone_dir],
            capture_output=True, text=True, timeout=120
        )
        if r.returncode != 0:
            err = r.stderr.strip() or 'Clone failed'
            return jsonify({'success': False, 'error': err}), 400
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': 'Clone timed out (120s)'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

    # Build file tree
    file_tree = []
    for root, dirs, files in os.walk(clone_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in ('node_modules', '__pycache__'))
        rel_root = os.path.relpath(root, clone_dir)
        prefix   = '' if rel_root == '.' else rel_root + '/'
        for fname in sorted(files):
            file_tree.append(prefix + fname)

    context      = _read_dir_as_text(clone_dir, max_chars=120000)
    files_read   = context.count('=== ')
    total_kb     = round(len(context.encode()) / 1024, 1)
    files_total  = len(file_tree)
    files_skipped = max(0, files_total - files_read)

    return jsonify({
        'success':       True,
        'url':           url,
        'repo_name':     repo_name,
        'context':       context,
        'file_tree':     file_tree,
        'files_read':    files_read,
        'files_skipped': files_skipped,
        'total_size_kb': total_kb,
    })


@app.route('/api/generate-zip', methods=['POST'])
def generate_zip():
    body  = request.get_json(force=True) or {}
    files = body.get('files', [])
    if not files:
        return jsonify({'error': 'No files'}), 400

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            name    = f.get('filename', 'file.txt')
            content = f.get('content', '')
            zf.writestr(name, content)
    buf.seek(0)
    return Response(
        buf.read(),
        mimetype='application/zip',
        headers={'Content-Disposition': 'attachment; filename=agent_code.zip'}
    )


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)

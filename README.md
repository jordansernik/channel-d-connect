# Channel D Connect

WebRTC-based remote video support tool. Send a link to a dental practice; they
open it on their phone and share their rear camera + mic, and you (the support
agent) see their feed and talk to them — audio only, no camera of you.

- **Host view** (you, desktop): `/host`
- **Guest view** (practice, phone): `/join/:roomId`

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000/host. Local works over HTTP because browsers allow
camera/mic on `localhost`. **On the public internet you must use HTTPS.**

## Deploy (Render)

1. Push this folder to a GitHub repo.
2. In Render: **New + → Blueprint**, select the repo. It reads `render.yaml`
   and creates the web service (HTTPS is automatic).
3. You get a URL like `https://channel-d-connect.onrender.com`. Open `/host`.

## TURN relay (optional but recommended)

STUN alone connects most calls. For practices behind strict firewalls, add a
TURN relay. Get credentials from a provider (Metered or Cloudflare), then set
these in the Render dashboard (Environment tab):

```
TURN_URLS=turn:...:3478,turns:...:443
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

No redeploy needed for the app logic — the client fetches ICE config at call time.

## Env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `PORT` | no (host sets it) | Server port; defaults to 3000 |
| `TURN_URLS` | no | Comma-separated TURN URLs |
| `TURN_USERNAME` | no | TURN username |
| `TURN_CREDENTIAL` | no | TURN password |

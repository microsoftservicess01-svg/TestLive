Test Live — Colorful & Moderated (Docker-ready)
==============================================

This package contains a simple, colorful "Test Live" streaming MVP with server-side moderation using nsfwjs and TensorFlow-Node.
It's ready to deploy on Render or run via Docker locally.

Files included:
- server.js       : Node + Express + Socket.IO backend with moderation
- frontend/index.html : Colorful responsive UI (yellow + white theme)
- package.json
- Dockerfile
- render.yaml     : Render blueprint
- .env.example    : environment variables to set

Environment variables to set on Render or .env:
- JWT_SECRET : long random secret for JWT
- ADMIN_KEY  : admin access key used during signup
- PORT       : optional (defaults to 3000)

Notes:
- tfjs-node increases image size and build time. First deploy/build may take several minutes.
- Moderation uses an in-memory ban/warning store; use a DB for persistence in production.
- For reliable WebRTC across NATs, add a TURN server (coturn).

Quick local test:
1. Copy .env.example to .env and set JWT_SECRET and ADMIN_KEY
2. docker build -t test-live-colorful .
3. docker run -p 3000:3000 --env-file .env test-live-colorful
4. Open http://localhost:3000

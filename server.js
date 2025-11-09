require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const ADMIN_KEY = process.env.ADMIN_KEY || 'adminkey';

// security headers
app.use((req,res,next)=>{
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy', "camera=(self), microphone=(self), display-capture=()");
  next();
});

app.use(cors());
app.use(express.json({ limit: '6mb' })); // frames are base64, keep limit reasonable

// In-memory stores (demo only). Replace with persistent DB in production.
const users = {}; // id -> { id, passwordHash, createdAt, displayName }
const sockets = {}; // socketId -> userId
let currentBroadcaster = null; // userId who is Live

// moderation state
const userWarnings = {}; // userId -> count
const bannedUsers = {}; // userId -> true

// load nsfw model
let nsfwModel = null;
(async () => {
  try {
    console.log('Loading NSFW model (this may take a few seconds)...');
    nsfwModel = await nsfw.load();
    console.log('NSFW model loaded');
  } catch (e) {
    console.error('Failed loading NSFW model', e);
  }
})();

// Serve frontend static
app.use(express.static(path.join(__dirname, 'frontend')));

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { accessKey, password, displayName } = req.body;
    if (!accessKey || accessKey !== ADMIN_KEY) return res.status(403).json({ error: 'invalid access key' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'password too short' });
    const id = 'user-' + uuidv4().slice(0,8);
    const passwordHash = await bcrypt.hash(password, 10);
    users[id] = { id, passwordHash, createdAt: Date.now(), displayName: displayName || id };
    const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ id, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'signup failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ error: 'missing' });
    const u = users[id];
    if (!u) return res.status(404).json({ error: 'user not found' });
    const ok = await bcrypt.compare(password, u.passwordHash);
    if (!ok) return res.status(401).json({ error: 'bad creds' });
    const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ id, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login failed' });
  }
});

// list users
app.get('/api/users', (req, res) => {
  const list = Object.values(users).map(u => ({ id: u.id, displayName: u.displayName, createdAt: u.createdAt }));
  res.json(list);
});

// moderation endpoint - receives base64 frame
app.post('/api/moderate-frame', async (req, res) => {
  try {
    const auth = req.headers.authorization?.split(' ')[1];
    if (!auth) return res.status(401).json({ error: 'no auth' });
    const { id } = jwt.verify(auth, JWT_SECRET);
    if (bannedUsers[id]) return res.json({ banned: true });

    const { frame } = req.body;
    if (!frame || !nsfwModel) return res.json({ ok: false, modelLoaded: !!nsfwModel });

    // decode base64 frame (expects jpeg/png)
    const imgBuffer = Buffer.from(frame, 'base64');
    const imageTensor = tf.node.decodeImage(imgBuffer, 3);
    const predictions = await nsfwModel.classify(imageTensor);
    imageTensor.dispose();

    // Consider Porn/Hentai/Sexual/Explicit as risky
    const risky = predictions.some(p => (['Porn','Hentai','Sexy'].includes(p.className) && p.probability > 0.6));
    if (risky) {
      userWarnings[id] = (userWarnings[id] || 0) + 1;
      const count = userWarnings[id];
      // send warning to the user via socket (if connected)
      const sockId = Object.keys(sockets).find(sid => sockets[sid] === id);
      if (sockId) io.to(sockId).emit('warning', { id, count });

      if (count >= 3) {
        bannedUsers[id] = true;
        // if the banned user is currently broadcaster, stop the live
        if (currentBroadcaster === id) {
          currentBroadcaster = null;
          io.to('public').emit('stop-live', { id });
        }
        console.log(`User ${id} banned for repeated NSFW content`);
      } else {
        console.log(`Warning ${count}/3 for user ${id}`);
      }
    }

    res.json({ ok: true, risky });
  } catch (e) {
    console.error('moderation error', e);
    res.status(500).json({ error: 'moderation failed' });
  }
});

// socket.io signaling & messaging
io.on('connection', socket => {
  console.log('socket connect', socket.id);

  socket.on('auth', token => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      sockets[socket.id] = payload.id;
      socket.join('public');
      socket.emit('auth-ok', { id: payload.id, displayName: users[payload.id]?.displayName });
      // notify current broadcaster
      if (currentBroadcaster) socket.emit('live-started', { id: currentBroadcaster });
    } catch (e) {
      socket.emit('auth-fail');
    }
  });

  socket.on('public-message', text => {
    const from = sockets[socket.id] || 'anon';
    io.to('public').emit('public-message', { from, text });
  });

  socket.on('go-live', ({ id }) => {
    if (bannedUsers[id]) {
      socket.emit('banned', { id });
      return;
    }
    currentBroadcaster = id;
    io.to('public').emit('live-started', { id });
  });

  socket.on('stop-live', () => {
    currentBroadcaster = null;
    io.to('public').emit('live-stopped');
  });

  socket.on('public-signal', data => {
    socket.to('public').emit('public-signal', { from: sockets[socket.id] || 'anon', ...data });
  });

  socket.on('disconnect', () => {
    delete sockets[socket.id];
  });
});

const start = () => {
  server.listen(PORT, () => console.log('Server listening on', PORT));
};

start();

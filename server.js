const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Base de dados em memória
const rooms = {}; // código -> { idoso, familiar, dados }
const messages = {}; // código -> [mensagens]

// ===== TRADUÇÃO =====
app.get('/', (req, res) => {
  res.json({ status: 'HomeSafe Server running!' });
});

app.post('/translate', async (req, res) => {
  const { text, targetLang } = req.body;
  if (!text || !targetLang) return res.status(400).json({ error: 'Missing parameters' });
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `You are a medical translator for elderly care. Translate to ${targetLang}. Keep it simple and precise for elderly users. Return ONLY the translated text. Text: ${text}` }]
    });
    res.json({ translated: message.content[0].text.trim() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/interpret', async (req, res) => {
  const { text, fromLang, toLang, mode } = req.body;
  if (!text || !fromLang || !toLang) return res.status(400).json({ error: 'Missing parameters' });
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `You are a hospital medical interpreter. Translate from ${fromLang} to ${toLang}. Mode: ${mode || 'patient-to-doctor'}. Be precise for medical context. Return ONLY the translated text. Text: ${text}` }]
    });
    res.json({ translated: message.content[0].text.trim() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== WHISPER =====
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], 'audio.m4a', { type: 'audio/m4a' }),
      model: 'whisper-1',
    });
    res.json({ text: transcription.text });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== LIGAÇÃO FAMILIAR =====
app.post('/family/create', (req, res) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const { profile } = req.body;
  rooms[code] = { idoso: profile, familiares: [], dados: {}, createdAt: new Date() };
  messages[code] = [];
  res.json({ code });
});

app.post('/family/join', (req, res) => {
  const { code, name } = req.body;
  if (!rooms[code]) return res.status(404).json({ error: 'Código inválido!' });
  const familiar = { id: uuidv4(), name, joinedAt: new Date() };
  rooms[code].familiares.push(familiar);
  res.json({ success: true, familiar, idoso: rooms[code].idoso });
});

app.get('/family/status/:code', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Não encontrado' });
  res.json(room);
});

// ===== DADOS DO IDOSO =====
app.post('/family/update', (req, res) => {
  const { code, dados } = req.body;
  if (!rooms[code]) return res.status(404).json({ error: 'Código inválido' });
  rooms[code].dados = { ...rooms[code].dados, ...dados, updatedAt: new Date() };
  res.json({ success: true });
});

app.get('/family/dados/:code', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Não encontrado' });
  res.json(room.dados);
});

// ===== MENSAGENS CHAT =====
app.post('/family/message', (req, res) => {
  const { code, message, sender, senderName } = req.body;
  if (!messages[code]) return res.status(404).json({ error: 'Código inválido' });
  const msg = { id: uuidv4(), message, sender, senderName, timestamp: new Date() };
  messages[code].push(msg);
  if (messages[code].length > 100) messages[code] = messages[code].slice(-100);
  res.json({ success: true, msg });
});

app.get('/family/messages/:code', (req, res) => {
  if (!messages[req.params.code]) return res.status(404).json({ error: 'Não encontrado' });
  res.json(messages[req.params.code]);
});

// ===== SOS ALERTA =====
app.post('/family/sos', (req, res) => {
  const { code, location, profile, type } = req.body;
  if (!rooms[code]) return res.status(404).json({ error: 'Código inválido' });
  rooms[code].dados.lastSOS = { location, profile, type, timestamp: new Date() };
  res.json({ success: true });
});

const server = http.createServer(app);

// ===== WEBSOCKET para chat em tempo real =====
const wss = new WebSocketServer({ server });
const clients = {};

wss.on('connection', (ws, req) => {
  const id = uuidv4();
  clients[id] = ws;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'join') {
        ws.code = msg.code;
        ws.sender = msg.sender;
        ws.senderName = msg.senderName;
      }
      if (msg.type === 'message' && ws.code) {
        const newMsg = { id: uuidv4(), message: msg.message, sender: ws.sender, senderName: ws.senderName, timestamp: new Date() };
        if (!messages[ws.code]) messages[ws.code] = [];
        messages[ws.code].push(newMsg);
        wss.clients.forEach(client => {
          if (client.code === ws.code && client.readyState === 1) {
            client.send(JSON.stringify({ type: 'message', ...newMsg }));
          }
        });
      }
    } catch (e) {}
  });

  ws.on('close', () => { delete clients[id]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`HomeSafe Server running on port ${PORT}`));

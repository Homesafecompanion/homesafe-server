const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => {
  res.json({ status: 'HomeSafe Translation Server running!' });
});

app.post('/translate', async (req, res) => {
  const { text, targetLang, context, mode, fromLang, toLang } = req.body;
  if (!text || !targetLang) {
    return res.status(400).json({ error: 'Missing text or targetLang' });
  }
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a medical interpreter in a hospital setting.
Mode: ${mode || 'patient-to-doctor'}
Translate from ${fromLang || 'pt'} to ${toLang || targetLang}.
This is a medical conversation — be precise and clear.
If patient speaks, translate naturally for the doctor.
If doctor speaks, translate simply for an elderly patient.
Return ONLY the translated text, nothing else.
Text: ${text}`
      }]
    });
    const translated = message.content[0].text.trim();
    res.json({ translated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/interpret', async (req, res) => {
  const { text, fromLang, toLang, mode } = req.body;
  if (!text || !fromLang || !toLang) {
    return res.status(400).json({ error: 'Missing text, fromLang or toLang' });
  }
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: 'You are a medical interpreter. Translate from ' + fromLang + ' to ' + toLang + '. Return ONLY the translated text, nothing else. Text: ' + text
      }]
    });
    const translated = message.content[0].text.trim();
    res.json({ translated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/whisper', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }
  try {
    const { Readable } = require('stream');
    const audioStream = Readable.from(req.file.buffer);
    audioStream.name = 'audio.m4a';

    const transcription = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], 'audio.m4a', { type: req.file.mimetype }),
      model: 'whisper-1',
      language: req.body.language || 'pt',
    });
    res.json({ text: transcription.text });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HomeSafe Server running on port ${PORT}`);
});

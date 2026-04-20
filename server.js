const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/', (req, res) => {
  res.json({ status: 'HomeSafe Translation Server running!' });
});

app.post('/translate', async (req, res) => {
  const { text, targetLang, context } = req.body;
  if (!text || !targetLang) {
    return res.status(400).json({ error: 'Missing text or targetLang' });
  }
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a medical translator specializing in elderly care. 
Translate the following text to ${targetLang}.
Keep it simple and clear for elderly users.
For emergency terms, be extremely precise.
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
    return res.status(400).json({ error: 'Missing parameters' });
  }
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a medical interpreter in a hospital setting.
Mode: ${mode || 'patient-to-doctor'}
Translate from ${fromLang} to ${toLang}.
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HomeSafe Server running on port ${PORT}`);
});

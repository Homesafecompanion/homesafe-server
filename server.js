require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ===== POSTGRESQL =====
const isLocalDb = (process.env.DATABASE_URL || '').includes('localhost');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

let dbReady = false;

pool.on('error', (err) => {
  console.error('[pg] idle client error', err.message);
});

const log = (...parts) => console.log(`[${new Date().toISOString()}]`, ...parts);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS families (
      code        CHAR(8) PRIMARY KEY,
      idoso       JSONB NOT NULL DEFAULT '{}'::jsonb,
      dados       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS familiares (
      id           UUID PRIMARY KEY,
      family_code  CHAR(8) NOT NULL REFERENCES families(code) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_familiares_code ON familiares(family_code);
    CREATE TABLE IF NOT EXISTS messages (
      id           UUID PRIMARY KEY,
      family_code  CHAR(8) NOT NULL REFERENCES families(code) ON DELETE CASCADE,
      message      TEXT NOT NULL,
      sender       TEXT,
      sender_name  TEXT,
      ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_code_ts ON messages(family_code, ts DESC);
    CREATE TABLE IF NOT EXISTS sos_events (
      id           UUID PRIMARY KEY,
      family_code  CHAR(8) NOT NULL REFERENCES families(code) ON DELETE CASCADE,
      type         TEXT,
      location     JSONB,
      profile      JSONB,
      ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sos_events_code_ts ON sos_events(family_code, ts DESC);
  `);

  // ===== MULTI-CARER MIGRATION =====
  // Adds role + status to familiares, promotes the oldest familiar per
  // family to 'primary', and enforces "at most 1 primary per family" via
  // a unique partial index. Idempotent — safe to re-run on every boot.

  // 1) New columns. Defaults chosen so that EVERY incoming row is
  //    'secondary' / 'active'; the UPDATE below then elects the primary
  //    for legacy data. New /family/join inserts will land as 'secondary'
  //    by default — promotion of "first joiner" is a route-level concern
  //    that will be wired up separately, not here.
  await pool.query(`
    ALTER TABLE familiares
      ADD COLUMN IF NOT EXISTS role   TEXT NOT NULL DEFAULT 'secondary';
    ALTER TABLE familiares
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
  `);

  // 2) CHECK constraints.
  // Postgres ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS, so we
  // wrap in DO blocks that skip when the constraint already exists.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'familiares_role_check'
          AND conrelid = 'public.familiares'::regclass
      ) THEN
        ALTER TABLE familiares
          ADD CONSTRAINT familiares_role_check
          CHECK (role IN ('primary', 'secondary', 'viewer'));
      END IF;
    END
    $$;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'familiares_status_check'
          AND conrelid = 'public.familiares'::regclass
      ) THEN
        ALTER TABLE familiares
          ADD CONSTRAINT familiares_status_check
          CHECK (status IN ('active', 'revoked'));
      END IF;
    END
    $$;
  `);

  // 3) Promote the oldest familiar of each family to 'primary',
  //    but ONLY for families that have no primary yet. Keeps the
  //    migration idempotent on re-runs and never overrides a
  //    manual primary chosen later.
  await pool.query(`
    UPDATE familiares
    SET role = 'primary'
    WHERE id IN (
      SELECT DISTINCT ON (family_code) id
      FROM familiares
      WHERE status = 'active'
        AND family_code NOT IN (
          SELECT family_code FROM familiares WHERE role = 'primary'
        )
      ORDER BY family_code, joined_at ASC, id ASC
    );
  `);

  // 4) Enforce "at most 1 primary per family" at the DB level.
  //    Partial unique index = uniqueness applies only to rows where
  //    role='primary'. Other roles are unconstrained.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_primary_per_family
      ON familiares (family_code)
      WHERE role = 'primary';
  `);

  // ===== DEVICE BINDING MIGRATION =====
  // Adds device_id to familiares so the app can bind one carer row to one
  // device. Combined with a partial unique index, this lets us enforce
  // "at most 1 active row per (family_code, device_id)" without breaking
  // legacy rows that have no device_id yet. Idempotent on re-runs.

  // 5) New column. NULLABLE on purpose:
  //    - legacy rows stay NULL (no retroactive backfill)
  //    - requests from older app builds that don't send device_id keep
  //      working — they just insert a row with device_id = NULL
  await pool.query(`
    ALTER TABLE familiares
      ADD COLUMN IF NOT EXISTS device_id TEXT;
  `);

  // 6) Enforce "at most 1 ACTIVE row per (family_code, device_id)".
  //    Partial unique index with TWO filters, both required:
  //
  //    - WHERE device_id IS NOT NULL
  //      Without this, every legacy/no-device row would be treated as a
  //      duplicate of every other NULL row in the same family and the
  //      index would block legitimate inserts. (In Postgres NULLs in a
  //      unique index are technically distinct, but we still want to keep
  //      legacy rows fully outside this constraint as a matter of intent.)
  //
  //    - WHERE status = 'active'
  //      A device may have a history of revoked rows in the same family
  //      (e.g. carer rejoined after being removed). Only the currently
  //      active row must be unique; revoked rows are exempt.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_device_per_family
      ON familiares (family_code, device_id)
      WHERE device_id IS NOT NULL AND status = 'active';
  `);

  dbReady = true;
  log('[db] schema ready');
}

const newCode = () => Math.floor(10000000 + Math.random() * 90000000).toString();

async function familyExists(code) {
  const r = await pool.query('SELECT 1 FROM families WHERE code = $1', [code]);
  return r.rowCount > 0;
}

// ===== HEALTHCHECK =====
app.get('/', async (req, res) => {
  let db = 'unknown';
  try {
    await pool.query('SELECT 1');
    db = 'ok';
  } catch (e) {
    db = 'down';
  }
  res.json({
    status: 'HomeSafe Server running!',
    db,
    uptime: Math.round(process.uptime()),
  });
});


// ===== LEGAL PAGES =====
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});
app.get('/shared.css', (req, res) => {
  res.type('text/css').sendFile(path.join(__dirname, 'public', 'shared.css'));
});

// ===== TRADUÇÃO =====
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
app.post('/family/create', async (req, res, next) => {
  try {
    const { profile } = req.body;
    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ error: 'Missing profile' });
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      try {
        await pool.query(
          'INSERT INTO families (code, idoso) VALUES ($1, $2)',
          [code, profile]
        );
        log('family/create', code);
        return res.json({ code });
      } catch (err) {
        if (err.code === '23505') continue; // unique_violation, retry
        throw err;
      }
    }
    res.status(500).json({ error: 'Could not allocate unique code' });
  } catch (e) { next(e); }
});

app.post('/family/join', async (req, res, next) => {
  try {
    const { code, name, device_id } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'Missing parameters' });

    // Light sanitization. device_id counts as "valid" only if it's a
    // non-empty string; anything else (undefined, null, '', non-string)
    // silently falls back to the legacy no-device path so older app
    // builds that send junk device_id are not rejected.
    const cleanName = name.trim();
    if (!cleanName) return res.status(400).json({ error: 'Missing parameters' });
    const deviceId = (typeof device_id === 'string' && device_id.length > 0)
      ? device_id
      : null;

    // 1) Family must exist.
    const fam = await pool.query('SELECT idoso FROM families WHERE code = $1', [code]);
    if (fam.rowCount === 0) return res.status(404).json({ error: 'Código inválido!' });

    // 2) Decide role: first carer of a family that has no active primary
    //    becomes 'primary'; everyone else lands as 'secondary'. The
    //    uniq_primary_per_family partial index is the final arbiter — if
    //    two concurrent joins both compute targetRole='primary', one of
    //    them will hit 23505. That's the contract established in PARTE 1.
    const primaryCheck = await pool.query(
      `SELECT 1 FROM familiares
       WHERE family_code = $1 AND role = 'primary' AND status = 'active'
       LIMIT 1`,
      [code]
    );
    const targetRole = primaryCheck.rowCount === 0 ? 'primary' : 'secondary';

    let familiar;
    let action;

    if (deviceId) {
      // 3a) Phase A — reactivate a revoked row for the same device, if any.
      const reactivate = await pool.query(
        `UPDATE familiares
         SET status = 'active', name = $1, role = $2
         WHERE family_code = $3 AND device_id = $4 AND status = 'revoked'
         RETURNING id, name, role, status, joined_at AS "joinedAt"`,
        [cleanName, targetRole, code, deviceId]
      );

      if (reactivate.rowCount === 1) {
        familiar = reactivate.rows[0];
        action = 'reactivated';
      } else {
        // 3b) Phase B — no revoked row matched. INSERT, or if an active
        //     row for the same (code, device_id) already exists, update
        //     its name. (xmax = 0) on the returned row tells us whether
        //     this came from a fresh INSERT or from the DO UPDATE branch.
        const newId = uuidv4();
        const upsert = await pool.query(
          `INSERT INTO familiares (id, family_code, name, role, status, device_id)
           VALUES ($1, $2, $3, $4, 'active', $5)
           ON CONFLICT (family_code, device_id)
             WHERE device_id IS NOT NULL AND status = 'active'
           DO UPDATE SET name = EXCLUDED.name
           RETURNING id, name, role, status, joined_at AS "joinedAt",
                    (xmax = 0) AS was_inserted`,
          [newId, code, cleanName, targetRole, deviceId]
        );
        const row = upsert.rows[0];
        action = row.was_inserted ? 'created' : 'updated_active';
        familiar = {
          id: row.id,
          name: row.name,
          role: row.role,
          status: row.status,
          joinedAt: row.joinedAt,
        };
      }
    } else {
      // 4) Legacy path — no device_id. Same behavior as before: always
      //    INSERT a fresh row, no dedup. Old app builds keep working.
      const newId = uuidv4();
      const ins = await pool.query(
        `INSERT INTO familiares (id, family_code, name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, role, status, joined_at AS "joinedAt"`,
        [newId, code, cleanName, targetRole]
      );
      familiar = ins.rows[0];
      action = 'created';
    }

    log('family/join', code, cleanName, action, deviceId || 'no-device');
    res.json({
      success: true,
      familiar,
      idoso: fam.rows[0].idoso,
      action,
    });
  } catch (e) { next(e); }
});

app.get('/family/status/:code', async (req, res, next) => {
  try {
    const code = req.params.code;
    const fam = await pool.query(
      'SELECT idoso, dados, created_at AS "createdAt" FROM families WHERE code = $1',
      [code]
    );
    if (fam.rowCount === 0) return res.status(404).json({ error: 'Não encontrado' });
    const familiares = await pool.query(
      `SELECT id, name, joined_at AS "joinedAt" FROM familiares
       WHERE family_code = $1 ORDER BY joined_at ASC`,
      [code]
    );
    res.json({
      idoso: fam.rows[0].idoso,
      familiares: familiares.rows,
      dados: fam.rows[0].dados,
      createdAt: fam.rows[0].createdAt,
    });
  } catch (e) { next(e); }
});

app.get('/family/carers/:code', async (req, res, next) => {
  try {
    const code = req.params.code;
    const fam = await pool.query('SELECT 1 FROM families WHERE code = $1', [code]);
    if (fam.rowCount === 0) return res.status(404).json({ error: 'family not found' });
    const r = await pool.query(
      `SELECT id, name, role, status, joined_at AS "joined_at"
       FROM familiares
       WHERE family_code = $1
       ORDER BY CASE role
                  WHEN 'primary'   THEN 1
                  WHEN 'secondary' THEN 2
                  WHEN 'viewer'    THEN 3
                  ELSE 4
                END,
                joined_at ASC`,
      [code]
    );
    res.json({ carers: r.rows });
  } catch (e) { next(e); }
});

app.patch('/family/carers/:id/role', async (req, res, next) => {
  try {
    const { role } = req.body;
    if (role !== 'secondary' && role !== 'viewer') {
      return res.status(400).json({ error: "role must be 'secondary' or 'viewer'" });
    }
    const id = req.params.id;
    const cur = await pool.query(
      'SELECT role, status FROM familiares WHERE id = $1',
      [id]
    );
    if (cur.rowCount === 0) {
      return res.status(404).json({ error: 'carer not found' });
    }
    if (cur.rows[0].status === 'revoked') {
      return res.status(400).json({ error: 'cannot change role of revoked carer' });
    }
    if (cur.rows[0].role === 'primary') {
      return res.status(400).json({ error: 'use /family/transfer-primary to change primary role' });
    }
    const upd = await pool.query(
      `UPDATE familiares SET role = $1 WHERE id = $2
       RETURNING id, name, role, status, joined_at AS "joined_at"`,
      [role, id]
    );
    log('family/carers/role', id, role);
    res.json({ carer: upd.rows[0] });
  } catch (e) { next(e); }
});

app.delete('/family/carers/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const cur = await pool.query(
      `SELECT id, name, role, status, joined_at AS "joined_at"
       FROM familiares WHERE id = $1`,
      [id]
    );
    if (cur.rowCount === 0) {
      return res.status(404).json({ error: 'carer not found' });
    }
    if (cur.rows[0].role === 'primary') {
      return res.status(400).json({ error: 'cannot revoke primary carer; use /family/transfer-primary first' });
    }
    if (cur.rows[0].status === 'revoked') {
      return res.json({ carer: cur.rows[0] });
    }
    const upd = await pool.query(
      `UPDATE familiares SET status = 'revoked' WHERE id = $1
       RETURNING id, name, role, status, joined_at AS "joined_at"`,
      [id]
    );
    log('family/carers/revoke', id);
    res.json({ carer: upd.rows[0] });
  } catch (e) { next(e); }
});

app.post('/family/transfer-primary', async (req, res, next) => {
  try {
    const { from_id, to_id } = req.body;
    if (typeof from_id !== 'string' || !from_id || typeof to_id !== 'string' || !to_id) {
      return res.status(400).json({ error: 'from_id and to_id are required' });
    }
    if (from_id === to_id) {
      return res.status(400).json({ error: 'from_id and to_id must be different' });
    }
    const pre = await pool.query(
      'SELECT id, family_code, role, status FROM familiares WHERE id IN ($1, $2)',
      [from_id, to_id]
    );
    if (pre.rowCount < 2) {
      return res.status(404).json({ error: 'one or both carers not found' });
    }
    const from = pre.rows.find(r => r.id === from_id);
    const to   = pre.rows.find(r => r.id === to_id);
    if (from.family_code !== to.family_code) {
      return res.status(400).json({ error: 'carers must belong to the same family' });
    }
    if (from.role !== 'primary') {
      return res.status(400).json({ error: 'from_id is not the current primary' });
    }
    if (from.status !== 'active') {
      return res.status(400).json({ error: 'from_id is not active' });
    }
    if (to.role !== 'secondary') {
      return res.status(400).json({ error: 'to_id must be a secondary carer (viewers cannot be promoted directly to primary)' });
    }
    if (to.status !== 'active') {
      return res.status(400).json({ error: 'to_id is not active' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const demoted = await client.query(
        `UPDATE familiares SET role = 'secondary' WHERE id = $1
         RETURNING id, name, role, status, joined_at AS "joined_at"`,
        [from_id]
      );
      const promoted = await client.query(
        `UPDATE familiares SET role = 'primary' WHERE id = $1
         RETURNING id, name, role, status, joined_at AS "joined_at"`,
        [to_id]
      );
      await client.query('COMMIT');
      log('family/transfer-primary', from_id, '->', to_id);
      res.json({ old_primary: demoted.rows[0], new_primary: promoted.rows[0] });
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (e) { next(e); }
});

// ===== DADOS DO IDOSO =====
app.post('/family/update', async (req, res, next) => {
  try {
    const { code, dados } = req.body;
    if (!code || !dados || typeof dados !== 'object') {
      return res.status(400).json({ error: 'Missing parameters' });
    }
    const merged = { ...dados, updatedAt: new Date().toISOString() };
    const upd = await pool.query(
      `UPDATE families
       SET dados = dados || $1::jsonb, updated_at = NOW()
       WHERE code = $2`,
      [JSON.stringify(merged), code]
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Código inválido' });
    res.json({ success: true });
  } catch (e) { next(e); }
});

app.get('/family/dados/:code', async (req, res, next) => {
  try {
    const r = await pool.query('SELECT dados FROM families WHERE code = $1', [req.params.code]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r.rows[0].dados);
  } catch (e) { next(e); }
});

// ===== MENSAGENS CHAT =====
async function persistMessage(code, message, sender, senderName) {
  const id = uuidv4();
  const r = await pool.query(
    `INSERT INTO messages (id, family_code, message, sender, sender_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, message, sender, sender_name AS "senderName", ts AS "timestamp"`,
    [id, code, message, sender ?? null, senderName ?? null]
  );
  return r.rows[0];
}

app.post('/family/message', async (req, res, next) => {
  try {
    const { code, message, sender, senderName } = req.body;
    if (!code || !message) return res.status(400).json({ error: 'Missing parameters' });
    if (!(await familyExists(code))) return res.status(404).json({ error: 'Código inválido' });
    const msg = await persistMessage(code, message, sender, senderName);
    res.json({ success: true, msg });
  } catch (e) { next(e); }
});

app.get('/family/messages/:code', async (req, res, next) => {
  try {
    const code = req.params.code;
    if (!(await familyExists(code))) return res.status(404).json({ error: 'Não encontrado' });
    const r = await pool.query(
      `SELECT id, message, sender, sender_name AS "senderName", ts AS "timestamp"
       FROM messages WHERE family_code = $1
       ORDER BY ts DESC LIMIT 100`,
      [code]
    );
    res.json(r.rows);
  } catch (e) { next(e); }
});

// ===== SOS ALERTA =====
app.post('/family/sos', async (req, res, next) => {
  try {
    const { code, location, profile, type } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });
    if (!(await familyExists(code))) return res.status(404).json({ error: 'Código inválido' });
    const id = uuidv4();
    const ts = new Date().toISOString();
    await pool.query(
      `INSERT INTO sos_events (id, family_code, type, location, profile)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, code, type ?? null, location ?? null, profile ?? null]
    );
    const lastSOS = { location, profile, type, timestamp: ts };
    await pool.query(
      `UPDATE families
       SET dados = dados || jsonb_build_object('lastSOS', $1::jsonb), updated_at = NOW()
       WHERE code = $2`,
      [JSON.stringify(lastSOS), code]
    );
    log('family/sos', code, type);
    res.json({ success: true });
  } catch (e) { next(e); }
});

app.get('/family/sos/:code', async (req, res, next) => {
  try {
    const code = req.params.code;
    if (!(await familyExists(code))) return res.status(404).json({ error: 'Não encontrado' });
    const r = await pool.query(
      `SELECT id, type, location, profile, ts AS "timestamp"
       FROM sos_events WHERE family_code = $1
       ORDER BY ts DESC LIMIT 100`,
      [code]
    );
    res.json(r.rows);
  } catch (e) { next(e); }
});

// ===== TTS =====
app.post('/speak', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text' });
  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'nova',
      input: text,
      speed: 0.9,
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
  console.error('[err]', req.method, req.path, err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ===== HTTP + WEBSOCKET =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'join') {
        ws.code = msg.code;
        ws.sender = msg.sender;
        ws.senderName = msg.senderName;
      }
      if (msg.type === 'message' && ws.code) {
        if (!(await familyExists(ws.code))) return;
        const persisted = await persistMessage(ws.code, msg.message, ws.sender, ws.senderName);
        wss.clients.forEach((c) => {
          if (c.code === ws.code && c.readyState === 1) {
            c.send(JSON.stringify({ type: 'message', ...persisted }));
          }
        });
      }
    } catch (e) {
      console.error('[ws] error', e.message);
    }
  });
});

const PORT = process.env.PORT || 3000;

initDb().catch((e) => console.error('[db] init failed', e.message));

server.listen(PORT, () => log(`HomeSafe Server running on port ${PORT}`));

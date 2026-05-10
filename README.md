# HomeSafe Server

Backend for the HomeSafe Companion (idoso) and HomeSafe Carer (cuidador) apps.
Provides family pairing, real-time chat, SOS history, telemetry, medical
translation, and TTS/STT.

**Stack:** Node.js + Express + WebSocket + PostgreSQL 17.
**Hosting:** Render (Web Service + Render Postgres).
**Live URL:** https://homesafe-server.onrender.com

---

## Setup local

```bash
git clone https://github.com/Homesafecompanion/homesafe-server.git
cd homesafe-server
npm install
cp .env.example .env
# fill DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY
npm start
```

The server creates all tables automatically on first boot
(`CREATE TABLE IF NOT EXISTS`), so no migration tool is required.

### Environment variables

| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. SSL is enabled automatically unless the host is `localhost`. |
| `ANTHROPIC_API_KEY` | yes (translate) | Used by `/translate` and `/interpret`. |
| `OPENAI_API_KEY` | yes (audio) | Used by `/transcribe` (Whisper) and `/speak` (TTS). |
| `PORT` | no | Defaults to `3000`. |

---

## Database schema

Four tables. Profile and telemetry payloads are stored as `JSONB` to keep the
shape flexible without future migrations.

```sql
families     (code CHAR(8) PK, idoso JSONB, dados JSONB, created_at, updated_at)
familiares   (id UUID PK, family_code → families, name, joined_at)
messages     (id UUID PK, family_code → families, message, sender, sender_name, ts)
sos_events   (id UUID PK, family_code → families, type, location JSONB, profile JSONB, ts)
```

Indexes on `(family_code, ts DESC)` for `messages` and `sos_events`,
plus `family_code` for `familiares`. `ON DELETE CASCADE` on every FK.

---

## Endpoints

### Health

| Method | Path | Response |
|---|---|---|
| GET | `/` | `{ status, db: "ok"\|"down", uptime }` |

### Family

| Method | Path | Body / Params | Response |
|---|---|---|---|
| POST | `/family/create` | `{ profile }` | `{ code }` — 8 digits |
| POST | `/family/join` | `{ code, name }` | `{ success, familiar: {id,name,joinedAt}, idoso }` |
| GET | `/family/status/:code` | — | `{ idoso, familiares[], dados, createdAt }` |
| POST | `/family/update` | `{ code, dados }` | `{ success }` — JSONB shallow merge |
| GET | `/family/dados/:code` | — | `dados` object |
| POST | `/family/message` | `{ code, message, sender, senderName }` | `{ success, msg }` |
| GET | `/family/messages/:code` | — | `[msg, ...]` (last 100, ascending) |
| POST | `/family/sos` | `{ code, location, profile, type }` | `{ success }` |
| GET | `/family/sos/:code` | — | `[event, ...]` (last 100, descending) — full SOS history |

### AI / audio

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/translate` | `{ text, targetLang }` | `{ translated }` |
| POST | `/interpret` | `{ text, fromLang, toLang, mode }` | `{ translated }` |
| POST | `/transcribe` | multipart `audio` field | `{ text }` |
| POST | `/speak` | `{ text }` | `audio/mpeg` |

### WebSocket

`wss://homesafe-server.onrender.com`

```js
ws.send(JSON.stringify({ type: 'join', code, sender, senderName }));
ws.send(JSON.stringify({ type: 'message', message: 'Olá' }));
// receive
{ type: 'message', id, message, sender, senderName, timestamp }
```

Messages received over WebSocket are persisted to the `messages` table before
being broadcast.

---

## Family code format

Codes are **8 digits** (e.g. `12345678`). Stored raw; the frontend formats
visually as `XXXX-XXXX`. On collision (rare), the server retries up to 5 times.

---

## SOS handling

- `POST /family/sos` writes a new row to `sos_events` (full history) **and**
  updates `families.dados.lastSOS` (latest snapshot — kept for app compatibility).
- `GET /family/sos/:code` returns the last 100 events, newest first.

---

## Deploy (Render)

1. Push to `main` → Render auto-deploys.
2. Render Postgres provides `DATABASE_URL` automatically when linked to the
   web service.
3. Free Postgres plan expires after 90 days — provision a new one before then.

---

## Error responses

All errors return JSON: `{ error: "..." }`.

| Code | Meaning |
|---|---|
| 400 | Missing or invalid parameters |
| 404 | Family code not found / route not found |
| 500 | Internal error (DB, upstream API) |

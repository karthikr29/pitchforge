# Voice Session WS Protocol (duplex)

## URL
- `wss://<project>.functions.supabase.co/voice-session-ws`

## Client → Server messages (JSON)
- `{"type":"start","personaId":"...","conversationId":"...","companyId":"..."?}`
- `{"type":"audio","id":"<uuid>","mime":"audio/webm","base64":"<...>"}` small chunks (1–3s)
- `{"type":"stop"}` request graceful stop
- `{"type":"ping"}` keepalive

## Server → Client messages
- `{"type":"status","value":"ready|listening|thinking|speaking"}`
- `{"type":"text","role":"ai","turnId":"<uuid>","text":"..."}` incremental transcript
- `{"type":"tts","id":"<uuid>","mime":"audio/mpeg","base64":"<...>"}` playable chunk
- `{"type":"error","message":"..."}` terminal or recoverable error
- `{"type":"done"}` conversation finished
- `{"type":"pong"}`

## Flow
1) Client sends `start`.
2) Client streams `audio` chunks continuously.
3) Server runs ASR incrementally; emits `text` (AI response chunks) and `tts` audio chunks as ready; updates `status`.
4) Client plays `tts` chunks in order received; shows text as it streams.
5) `stop` or socket close ends session; server sends `done`.


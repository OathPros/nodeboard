# Nodeboard Live

A fast, framework-free graph whiteboard with a Cloudflare Worker + Durable Object multiplayer starter.

## Quick start

```bash
npm install
npm run dev
```

Run starter protocol unit checks with `npm test`.

Open the Wrangler localhost address, click **Collaborate → Create session**, and send the editor link to a second browser window. Use **View-only invitation** for guests who should not edit.

## Deploy

```bash
npx wrangler login
npm run deploy
```

## Files

- `public/index.html` — full original editor plus collaboration UI and client protocol adapter.
- `src/index.js` — Worker routes, SQLite-backed Durable Object, WebSocket auth + sync starter.
- `docs/BUILD_GUIDE.md` — detailed architecture, protocol, security and acceptance matrix.
- `docs/CODEX_START_PROMPT.md` — paste as first prompt to Codex in this repository.

## Status / limitations

This is a **starter, not a production-tested collaborative service**. JavaScript syntax checks have been performed, but a Cloudflare dev deployment and multi-client synchronization tests must be completed. Live undo/redo is deliberately disabled; remote cursors, session ownership, abuse protection, stable class UUID migration, and institutional data review are outstanding. Standalone `index.html` works as a local editor without a server.

import { DurableObject } from 'cloudflare:workers';

const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

// This object is only reachable through the Worker, which verifies the caller's identity.
export class DocumentDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (document_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(document_id,user_id));
      CREATE INDEX IF NOT EXISTS member_user ON members(user_id);
      CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, classes TEXT NOT NULL, created INTEGER NOT NULL);
    `);
  }

  access(documentId, userId) {
    const doc = this.sql.exec('SELECT id,owner,name FROM documents WHERE id=?', documentId).toArray()[0];
    if (!doc) return null;
    const role = doc.owner === userId ? 'owner' : this.sql.exec('SELECT role FROM members WHERE document_id=? AND user_id=?', documentId, userId).toArray()[0]?.role;
    return role ? { ...doc, role } : null;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const input = await request.json();
    const { user, id } = input;
    if (path === '/register') {
      try {
        this.sql.exec('INSERT INTO profiles(id,email) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email', user.id, user.email);
      } catch {
        return reply({ error: 'This email is already associated with another account.' }, 409);
      }
      return reply({ ok: true });
    }
    if (path === '/list') {
      const docs = this.sql.exec(`SELECT d.id,d.name,d.created,CASE WHEN d.owner=? THEN 'owner' ELSE m.role END AS role
        FROM documents d LEFT JOIN members m ON m.document_id=d.id AND m.user_id=?
        WHERE d.owner=? OR m.user_id IS NOT NULL ORDER BY d.created DESC`, user.id, user.id, user.id).toArray();
      return reply({ documents: docs });
    }
    if (path === '/templates-list') {
      const templates = this.sql.exec('SELECT id,name,classes,created FROM templates WHERE owner=? ORDER BY created DESC', user.id).toArray();
      return reply({ templates: templates.map(t => ({ ...t, classes: JSON.parse(t.classes) })) });
    }
    if (path === '/templates-create') {
      this.sql.exec('INSERT INTO templates(id,owner,name,classes,created) VALUES (?,?,?,?,?)', id, user.id, input.name, JSON.stringify(input.classes), Date.now());
      return reply({ id }, 201);
    }
    if (path === '/templates-delete') {
      const result = this.sql.exec('DELETE FROM templates WHERE id=? AND owner=?', id, user.id);
      return result.rowsWritten ? reply({ ok: true }) : reply({ error: 'Template not found' }, 404);
    }
    if (path === '/create') {
      this.sql.exec('INSERT INTO documents(id,owner,name,created) VALUES (?,?,?,?)', id, user.id, input.name, Date.now());
      return reply({ ok: true });
    }
    const doc = this.access(id, user.id);
    if (!doc) return reply({ error: 'Document not found' }, 404);
    if (path === '/access') return reply(doc);
    if (doc.role !== 'owner') return reply({ error: 'Only the owner can manage this document' }, 403);
    if (path === '/members') {
      const members = this.sql.exec('SELECT p.email,m.role FROM members m JOIN profiles p ON p.id=m.user_id WHERE m.document_id=? ORDER BY p.email', id).toArray();
      return reply({ members });
    }
    if (path === '/share') {
      const target = this.sql.exec('SELECT id,email FROM profiles WHERE email=?', input.email).toArray()[0];
      if (!target) return reply({ error: 'That user must sign in to Nodeboard first.' }, 404);
      if (target.id === user.id) return reply({ error: 'You already own this document.' }, 400);
      if (!['viewer', 'editor'].includes(input.role)) return reply({ error: 'Invalid access role' }, 400);
      this.sql.exec('INSERT INTO members(document_id,user_id,role) VALUES (?,?,?) ON CONFLICT(document_id,user_id) DO UPDATE SET role=excluded.role', id, target.id, input.role);
      return reply({ ok: true, userId: target.id });
    }
    if (path === '/unshare') {
      const target = this.sql.exec('SELECT id FROM profiles WHERE email=?', input.email).toArray()[0];
      if (!target) return reply({ error: 'User not found' }, 404);
      this.sql.exec('DELETE FROM members WHERE document_id=? AND user_id=?', id, target.id);
      return reply({ ok: true, userId: target.id });
    }
    if (path === '/rename') {
      this.sql.exec('UPDATE documents SET name=? WHERE id=?', input.name, id);
      return reply({ ok: true });
    }
    if (path === '/delete') {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM members WHERE document_id=?', id);
        this.sql.exec('DELETE FROM documents WHERE id=?', id);
      });
      return reply({ ok: true });
    }
    return reply({ error: 'Not found' }, 404);
  }
}

export class CloudStoreError extends Error {
  constructor(code, message, diagnostics = [], status = 0) {
    super(message);
    this.name = 'CloudStoreError';
    this.code = code;
    this.diagnostics = diagnostics;
    this.status = status;
  }
}

export function createCloudV2Store(getToken, ownerId = null) {
  async function request(path, options = {}) {
    const token = await getToken();
    if (!token) throw new CloudStoreError('UNAUTHORIZED', 'Sign in to access account boards.');
    const root = ownerId ? `/api/v2/shared/${encodeURIComponent(ownerId)}` : '/api/v2/boards';
    const response = await fetch(`${root}${path}`, {
      method: options.method || 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'X-Nodeboard-Protocol': '2',
        'X-Nodeboard-Snapshot': '2',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new CloudStoreError(data.code || 'SERVICE_ERROR', data.error || 'The account board request failed.', data.diagnostics || [], response.status);
    return data;
  }
  return {
    ownerId,
    list(options = {}) {
      const query = new URLSearchParams();
      if (options.after !== undefined) query.set('after', options.after);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.toString();
      return request(suffix ? `?${suffix}` : '');
    },
    create(id, snapshot) { return request('', { method: 'POST', body: { id, snapshot } }); },
    async read(id) {
      try { return await request(`/${encodeURIComponent(id)}`); }
      catch (error) {
        if (error instanceof CloudStoreError && error.code === 'NOT_FOUND') return null;
        throw error;
      }
    },
    apply(id, batch) {
      return request(`/${encodeURIComponent(id)}/operations`, { method: 'POST', body: batch });
    },
    history(id, payload) {
      return request(`/${encodeURIComponent(id)}/history`, {
        method: 'POST', body: payload,
      });
    },
    async exportBackup(id) {
      const board = await this.read(id);
      if (!board) throw new CloudStoreError('NOT_FOUND', 'The board does not exist.');
      return { format: 'nodeboard-local-backup', version: 1, sourceBoardId: id, sourceRevision: board.revision, snapshot: board.snapshot };
    },
    members(id) { return request(`/${encodeURIComponent(id)}/members`); },
    share(id, email, role) { return request(`/${encodeURIComponent(id)}/share`, { method: 'POST', body: { email, role } }); },
    unshare(id, userId) { return request(`/${encodeURIComponent(id)}/unshare`, { method: 'POST', body: { userId } }); },
  };
}

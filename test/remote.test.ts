import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RemoteClient, RemoteError } from '../src/remote.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(routes: Record<string, (url: URL) => Response>) {
  const calls: string[] = [];
  const fetch = async (input: string | URL) => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    const handler = routes[url.pathname];
    return handler ? handler(url) : json({ message: 'nope' }, 404);
  };
  return { fetch, calls };
}

const link = { baseUrl: 'https://friend.example', key: 'SHAREKEY123' };

describe('RemoteClient', () => {
  it('reads shared link info incl. album owner', async () => {
    const { fetch, calls } = mockFetch({
      '/api/shared-links/me': () =>
        json({
          id: 'link-1',
          type: 'ALBUM',
          allowDownload: false,
          showMetadata: true,
          expiresAt: null,
          assets: [],
          album: {
            id: 'album-1',
            albumName: 'Sommer',
            albumUsers: [{ role: 'owner', user: { name: 'Anna', email: 'a@x' } }],
          },
        }),
    });
    const client = new RemoteClient({ allowPrivate: true, timeoutMs: 1000, fetch });
    const info = await client.getLinkInfo(link);
    assert.equal(info.albumId, 'album-1');
    assert.equal(info.albumName, 'Sommer');
    assert.equal(info.ownerName, 'Anna');
    assert.equal(info.allowDownload, false);
    assert.equal(calls[0], '/api/shared-links/me?key=SHAREKEY123');
  });

  it('lists all buckets, skips trashed + duplicates, keeps isImage', async () => {
    const { fetch, calls } = mockFetch({
      '/api/timeline/buckets': (url) => {
        assert.equal(url.searchParams.get('albumId'), 'album-1');
        assert.equal(url.searchParams.get('key'), 'SHAREKEY123');
        assert.equal(url.searchParams.has('visibility'), false);
        return json([
          { timeBucket: '2025-07-01T00:00:00.000Z', count: 2 },
          { timeBucket: '2025-06-01T00:00:00.000Z', count: 2 },
        ]);
      },
      '/api/timeline/bucket': (url) => {
        const tb = url.searchParams.get('timeBucket');
        if (tb === '2025-07-01T00:00:00.000Z') {
          return json({
            id: ['a', 'b'],
            isImage: [true, false],
            isTrashed: [false, false],
            fileCreatedAt: ['2026-08-23T18:00:03.114', '2026-08-23T17:57:50+00:00'],
          });
        }
        return json({ id: ['c', 'a', 'd'], isImage: [true, true, true], isTrashed: [false, false, true] });
      },
    });
    const client = new RemoteClient({ allowPrivate: true, timeoutMs: 1000, fetch });
    const assets = await client.listAlbumAssets(link, 'album-1');
    assert.deepEqual(assets, [
      { id: 'a', isImage: true, fileCreatedAt: '2026-08-23T18:00:03.114Z' },
      { id: 'b', isImage: false, fileCreatedAt: '2026-08-23T17:57:50+00:00' },
      { id: 'c', isImage: true },
    ]);
    assert.equal(calls.length, 3);
  });

  it('supports slug links and individual links', async () => {
    const { fetch, calls } = mockFetch({
      '/api/shared-links/me': () =>
        json({ id: 'l', type: 'INDIVIDUAL', assets: [{ id: 'x', type: 'VIDEO' }], allowDownload: true, showMetadata: true }),
    });
    const client = new RemoteClient({ allowPrivate: true, timeoutMs: 1000, fetch });
    const slugLink = { baseUrl: 'https://friend.example', slug: 'urlaub' };
    const info = await client.getLinkInfo(slugLink);
    assert.deepEqual(await client.listAssets(slugLink, info), [{ id: 'x', isImage: false }]);
    assert.equal(calls[0], '/api/shared-links/me?slug=urlaub');
  });

  it('maps auth errors to readable messages', async () => {
    const { fetch } = mockFetch({
      '/api/shared-links/me': () => json({ message: 'Invalid share key' }, 401),
    });
    const client = new RemoteClient({ allowPrivate: true, timeoutMs: 1000, fetch });
    await assert.rejects(client.getLinkInfo(link), (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.status, 401);
      assert.match(error.message, /ungültig/);
      return true;
    });
  });

  it('blocks private remotes unless allowed', async () => {
    const client = new RemoteClient({ allowPrivate: false, timeoutMs: 1000, fetch: async () => json({}) });
    await assert.rejects(client.getLinkInfo({ baseUrl: 'http://127.0.0.1:2291', key: 'k' }), /private Adresse/);
    await assert.rejects(client.getLinkInfo({ baseUrl: 'http://192.168.1.10', key: 'k' }), /private Adresse/);
  });

  it('re-checks redirect targets', async () => {
    const fetch = async (input: string | URL) => {
      const url = new URL(input);
      if (url.hostname === '1.1.1.1') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
      }
      return json({ ok: true });
    };
    const client = new RemoteClient({ allowPrivate: false, timeoutMs: 1000, fetch });
    await assert.rejects(client.getLinkInfo({ baseUrl: 'http://1.1.1.1', key: 'k' }), /private Adresse/);
  });
});

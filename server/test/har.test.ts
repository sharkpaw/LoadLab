import { describe, expect, test } from 'bun:test';
import { harToWorkflow } from '../src/lib/har';

const entry = (url: string, at: number, opts: any = {}) => ({
  startedDateTime: new Date(Date.parse('2026-01-01T00:00:00Z') + at).toISOString(),
  time: 100,
  request: { method: opts.method ?? 'GET', url, headers: opts.headers ?? [], postData: opts.postData },
  response: { status: opts.status ?? 200, content: { mimeType: opts.mime ?? 'application/json' } },
});

describe('harToWorkflow', () => {
  const har = {
    log: {
      entries: [
        entry('https://shop.example.com/', 0, { mime: 'text/html' }),
        entry('https://shop.example.com/app.js', 50, { mime: 'application/javascript' }),
        entry('https://tracker.other.com/collect', 60),
        entry('https://shop.example.com/api/cart', 5000, {
          method: 'POST',
          headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cookie', value: 'secret' }],
          postData: { mimeType: 'application/json', text: '{"id":1}' },
          status: 201,
        }),
      ],
    },
  };

  test('keeps the site’s requests, drops assets and third parties, adds think time', () => {
    const { definition, stats } = harToWorkflow(har, 'https://shop.example.com', ['shop.example.com']);
    expect(stats).toMatchObject({ total: 4, used: 2, pages: 1, skipped: 2 });
    const [page, think, req] = definition.steps as any[];
    expect(page).toMatchObject({ type: 'page', url: '/', assets: true });
    expect(think.type).toBe('think');
    expect(req).toMatchObject({ type: 'request', method: 'POST', url: '/api/cart', body: { mode: 'json', content: { id: 1 } } });
    expect(req.headers).toEqual({ 'Content-Type': 'application/json' }); // cookies are never copied
    expect(req.checks).toEqual([{ type: 'status', value: 201 }]);
  });

  test('throws when nothing matches the site', () => {
    expect(() => harToWorkflow(har, 'https://other.example.org', ['other.example.org'])).toThrow();
  });
});

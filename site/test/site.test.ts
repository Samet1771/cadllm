// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson as registryCanonicalJson } from '@cadllm/registry';
import { renderMarkdown } from '../lib/markdown.ts';
import { bootStorePage, renderStoreStateHtml } from '../lib/store-app.ts';
import {
  canonicalJson as siteCanonicalJson,
  describePermissionPlain,
  EMBEDDED_REGISTRY_PUBLIC_KEY,
  verifyIndexWebCrypto,
} from '../lib/verify.ts';

const TEST_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const ROOT_DIR = resolve(TEST_DIR, '../..');
const REGISTRY_DIR = join(ROOT_DIR, 'registry');

function loadRealRegistry(): { index: Record<string, unknown>; sig: string; pub: string } {
  const index = JSON.parse(readFileSync(join(REGISTRY_DIR, 'index.json'), 'utf8')) as Record<string, unknown>;
  const sig = readFileSync(join(REGISTRY_DIR, 'index.sig'), 'utf8').trim();
  const pub = readFileSync(join(REGISTRY_DIR, 'registry.pub'), 'utf8').trim();
  return { index, sig, pub };
}

describe('site/lib/markdown', () => {
  it('renders headings, lists, fenced code blocks, tables, links, and escapes HTML', () => {
    const md = [
      '# Main Heading',
      '',
      'Intro with **bold**, *italic*, `inline <script>`, and a [Foundation link](docs/FOUNDATION.md).',
      '',
      '## Table & List',
      '',
      '| Tool | Summary |',
      '|---|---|',
      '| `edit` | apply CNL \\| batch |',
      '',
      '- First item',
      '- Second item with [unsafe](javascript:alert(1))',
      '',
      '```cnl',
      'R1 res 330',
      'D1 led red',
      '```',
    ].join('\n');

    const html = renderMarkdown(md, {
      rewriteLink: href => (href === 'docs/FOUNDATION.md' ? './FOUNDATION.html' : href),
    });

    expect(html).toContain('<h1 id="main-heading">Main Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>inline &lt;script&gt;</code>');
    expect(html).toContain('<a href="./FOUNDATION.html">Foundation link</a>');
    expect(html).toContain('<th>Tool</th><th>Summary</th>');
    expect(html).toContain('<td><code>edit</code></td><td>apply CNL | batch</td>');
    expect(html).toContain('<ul><li>First item</li><li>Second item with unsafe</li></ul>');
    expect(html).toContain('<pre><code class="language-cnl">R1 res 330\nD1 led red</code></pre>');
    expect(html).not.toContain('javascript:');
  });
});

describe('site/lib/verify (WebCrypto Ed25519 & canonicalJson parity)', () => {
  it('matches @cadllm/registry canonicalJson byte-for-byte on real index and nested fixtures', () => {
    const { index } = loadRealRegistry();
    expect(siteCanonicalJson(index)).toBe(registryCanonicalJson(index));

    const complexFixture = {
      z: [3, { b: 'two', a: 'one', ignored: undefined }],
      a: { d: true, c: null, b: 42 },
      m: 'cadllm',
    };
    expect(siteCanonicalJson(complexFixture)).toBe(registryCanonicalJson(complexFixture));
  });

  it('verifies the real registry/index.json and registry/index.sig with WebCrypto Ed25519', async () => {
    const { index, sig, pub } = loadRealRegistry();
    expect(pub).toBe(EMBEDDED_REGISTRY_PUBLIC_KEY);

    const res = await verifyIndexWebCrypto(index, sig, EMBEDDED_REGISTRY_PUBLIC_KEY);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plugins.length).toBeGreaterThanOrEqual(1);
      const sensors = res.plugins.find(p => p.id === 'org.cadllm.example-sensors');
      expect(sensors).toBeDefined();
      expect(sensors?.publisher).toBe('cadllm-examples');
      expect(sensors?.latestVersion.version).toBe('1.0.0');
      expect(sensors?.installCommand).toBe('cadllm plugin install org.cadllm.example-sensors');
      expect(sensors?.plainPermissions[0]?.title).toBe('Read your circuits');
    }

    const view = renderStoreStateHtml(res);
    expect(view.bannerClass).toBe('banner-verified');
    expect(view.verifiedCount).toBe(1);
    expect(view.cardsHtml).toContain('org.cadllm.example-sensors');
    expect(view.cardsHtml).toContain('✓ Ed25519 Verified');
  });

  it('rejects a tampered plugin entry and lists nothing as verified', async () => {
    const { index, sig } = loadRealRegistry();
    const tampered = structuredClone(index) as {
      plugins: { summary: string; versions: { sha256: string; permissions: string[] }[] }[];
    };
    tampered.plugins[0]!.versions[0]!.permissions = ['project:read', 'project:write'];

    const res = await verifyIndexWebCrypto(tampered, sig, EMBEDDED_REGISTRY_PUBLIC_KEY);
    expect(res.ok).toBe(false);
    expect(res.plugins).toEqual([]);

    const view = renderStoreStateHtml(res);
    expect(view.bannerClass).toBe('banner-error');
    expect(view.verifiedCount).toBe(0);
    expect(view.cardsHtml).toBe('');
  });

  it('rejects a tampered index.sig and lists nothing as verified', async () => {
    const { index, sig } = loadRealRegistry();
    // Flip the first character of the base64 signature while keeping valid base64 length
    const firstChar = sig[0] === 'A' ? 'B' : 'A';
    const tamperedSig = `${firstChar}${sig.slice(1)}`;

    const res = await verifyIndexWebCrypto(index, tamperedSig, EMBEDDED_REGISTRY_PUBLIC_KEY);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('index.sig');
    }
    expect(res.plugins).toEqual([]);

    const view = renderStoreStateHtml(res);
    expect(view.bannerClass).toBe('banner-error');
    expect(view.verifiedCount).toBe(0);
    expect(view.cardsHtml).toBe('');
  });

  it('rejects a tampered version signature even if checked against publisher key', async () => {
    const { index, sig } = loadRealRegistry();
    const tampered = structuredClone(index) as {
      plugins: { versions: { signature: string }[] }[];
    };
    const origVerSig = tampered.plugins[0]!.versions[0]!.signature;
    tampered.plugins[0]!.versions[0]!.signature = `${origVerSig[0] === 'A' ? 'B' : 'A'}${origVerSig.slice(1)}`;

    const res = await verifyIndexWebCrypto(tampered, sig, EMBEDDED_REGISTRY_PUBLIC_KEY);
    expect(res.ok).toBe(false);
    expect(res.plugins).toEqual([]);
  });

  it('describes permissions in plain words', () => {
    expect(describePermissionPlain('project:read').title).toBe('Read your circuits');
    expect(describePermissionPlain('project:write').title).toBe('Change your circuits');
    expect(describePermissionPlain('net:api.example.com').title).toBe('Connect to api.example.com');
    expect(describePermissionPlain('fs:read:/tmp/data').title).toBe('Read files in /tmp/data');
    expect(describePermissionPlain('fs:write:/tmp/out').title).toBe('Write files in /tmp/out');
  });

  it('boots the store page DOM with verified cards on valid index and red banner on tampered index', async () => {
    const { index, sig } = loadRealRegistry();
    const origFetch = globalThis.fetch;

    const createMockDoc = () => {
      const els = new Map<
        string,
        {
          innerHTML: string;
          textContent: string | null;
          className: string;
          value?: string;
          hidden: boolean;
          addEventListener: () => void;
        }
      >([
        [
          'store-verification-banner',
          { innerHTML: '', textContent: '', className: '', hidden: true, addEventListener: () => {} },
        ],
        [
          'store-plugin-list',
          { innerHTML: '', textContent: '', className: '', hidden: false, addEventListener: () => {} },
        ],
        [
          'store-search-input',
          { innerHTML: '', textContent: '', className: '', value: '', hidden: false, addEventListener: () => {} },
        ],
      ]);
      return {
        els,
        doc: {
          getElementById(id: string) {
            return els.get(id) ?? null;
          },
        },
      };
    };

    try {
      // 1. Valid index.json + index.sig
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('index.json')) {
          return new Response(JSON.stringify(index), { status: 200 });
        }
        return new Response(sig, { status: 200 });
      }) as typeof fetch;

      const validDom = createMockDoc();
      const validOutcome = await bootStorePage(validDom.doc);
      expect(validOutcome.ok).toBe(true);
      expect(validDom.els.get('store-verification-banner')?.className).toContain('banner-verified');
      expect(validDom.els.get('store-plugin-list')?.innerHTML).toContain('org.cadllm.example-sensors');
      expect(validDom.els.get('store-plugin-list')?.innerHTML).toContain('cadllm plugin install org.cadllm.example-sensors');

      // 2. Tampered index.sig
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('index.json')) {
          return new Response(JSON.stringify(index), { status: 200 });
        }
        const badSig = `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
        return new Response(badSig, { status: 200 });
      }) as typeof fetch;

      const invalidDom = createMockDoc();
      const invalidOutcome = await bootStorePage(invalidDom.doc);
      expect(invalidOutcome.ok).toBe(false);
      expect(invalidDom.els.get('store-verification-banner')?.className).toContain('banner-error');
      expect(invalidDom.els.get('store-plugin-list')?.innerHTML).toBe('');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

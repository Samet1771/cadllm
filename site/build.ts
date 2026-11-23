// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, renderMarkdown } from './lib/markdown.ts';
import { EMBEDDED_REGISTRY_PUBLIC_KEY, verifyIndexWebCrypto } from './lib/verify.ts';

const SITE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const ROOT_DIR = resolve(SITE_DIR, '..');
const DIST_DIR = join(SITE_DIR, 'dist');

const STRICT_STATIC_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

const STRICT_APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";

interface DocEntry {
  sourcePath: string;
  slug: string;
  title: string;
  summary: string;
}

const DOC_ENTRIES: DocEntry[] = [
  {
    sourcePath: 'docs/FOUNDATION.md',
    slug: 'FOUNDATION',
    title: 'Foundation Design',
    summary: 'Core principles, canonical netlist, CNL grammar, 12-tool MCP surface, architecture, plugin contracts, and roadmap.',
  },
  {
    sourcePath: 'docs/M0-PLAN.md',
    slug: 'M0-PLAN',
    title: 'M0 Plan — Engine + MCP',
    summary: 'Core model, CNL parser/printer, part library, 4-state digital sim, MNA DC solver, headless MCP server, and token benchmark.',
  },
  {
    sourcePath: 'docs/M1-PLAN.md',
    slug: 'M1-PLAN',
    title: 'M1 Plan — UI + Live Co-Editing',
    summary: 'Schematic and breadboard SVG renderers, auto-placement, WebSocket + Streamable HTTP server, and React live co-editing UI.',
  },
  {
    sourcePath: 'docs/M2-PLAN.md',
    slug: 'M2-PLAN',
    title: 'M2 Plan — Sim++ (SPICE & Arduino)',
    summary: 'ngspice WASM transient/AC adapter, arduino-cli + avr8js cycle-accurate ATmega328P runner, and mixed-signal co-simulation.',
  },
  {
    sourcePath: 'docs/M3-PLAN.md',
    slug: 'M3-PLAN',
    title: 'M3 Plan — PCB Layout, DRC & Export',
    summary: '28 parametric IPC-7351 footprints, 9-rule PCB DRC, 2-layer A* autorouter, RS-274X X2 Gerbers, Excellon drill, and KiCad 9 export.',
  },
  {
    sourcePath: 'docs/M4-PLAN.md',
    slug: 'M4-PLAN',
    title: 'M4 Plan — Sandboxed Plugins & Registry',
    summary: 'Node 24 --permission process sandbox, preloaded network guard, capability RPC, two-tier Ed25519 signed registry, and UI manager.',
  },
  {
    sourcePath: 'LICENSE-EXCEPTION.md',
    slug: 'LICENSE-EXCEPTION',
    title: 'CadLLM Plugin License Exception',
    summary: 'Draft GPL-3.0 section 7 additional permission allowing plugins using only @cadllm/plugin-api to use any license.',
  },
  {
    sourcePath: 'CONTRIBUTING.md',
    slug: 'CONTRIBUTING',
    title: 'Contributing Guide',
    summary: 'Developer Certificate of Origin (DCO) sign-off, pre-PR verification commands, coding conventions, and license review notes.',
  },
];

function copyDirRecursive(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (st.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

function rewriteDocMarkdownLink(href: string, fromDocsDir: boolean): string {
  const prefix = fromDocsDir ? './' : './docs/';
  const [pathPart, hashPart] = href.split('#');
  const suffix = hashPart ? `#${hashPart}` : '';
  const cleaned = (pathPart ?? '').replace(/^\.\//, '');

  for (const doc of DOC_ENTRIES) {
    const baseName = doc.sourcePath.replace(/^docs\//, '');
    if (cleaned === doc.sourcePath || cleaned === baseName) {
      return `${prefix}${doc.slug}.html${suffix}`;
    }
  }
  if (cleaned === 'registry/README.md') {
    return `${fromDocsDir ? '../registry/' : './registry/'}`;
  }
  return href;
}

function renderShell(opts: {
  title: string;
  rootRel: string;
  activeNav: 'home' | 'app' | 'plugins' | 'docs' | 'registry';
  bodyHtml: string;
  scripts?: string[];
  csp?: string;
}): string {
  const r = opts.rootRel;
  const csp = opts.csp ?? STRICT_STATIC_CSP;
  const scriptTags = (opts.scripts ?? [])
    .map(src => `<script type="module" src="${escapeHtml(src)}"></script>`)
    .join('\n    ');

  const navItem = (key: typeof opts.activeNav, href: string, label: string) =>
    `<a class="nav-link${opts.activeNav === key ? ' active' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(opts.title)} — CadLLM</title>
    <link rel="stylesheet" href="${escapeHtml(r)}/assets/site.css" />
  </head>
  <body>
    <header class="site-header">
      <div class="container header-inner">
        <a class="site-brand" href="${escapeHtml(r)}/index.html">
          <span class="brand-mark">⚡</span>
          <span class="brand-name">CadLLM</span>
          <span class="brand-tag">pre-alpha · M5</span>
        </a>
        <nav class="site-nav" aria-label="Main navigation">
          ${navItem('home', `${r}/index.html`, 'Overview')}
          ${navItem('app', `${r}/app/index.html`, 'Try Web UI (Demo)')}
          ${navItem('plugins', `${r}/plugins/index.html`, 'Plugin Store')}
          ${navItem('docs', `${r}/docs/FOUNDATION.html`, 'Docs')}
          ${navItem('registry', `${r}/registry/index.html`, 'Registry')}
          <a class="nav-link" href="https://github.com/Samet1771/cadllm" rel="noopener noreferrer">GitHub</a>
        </nav>
      </div>
    </header>
    <main class="site-main">
      ${opts.bodyHtml}
    </main>
    <footer class="site-footer">
      <div class="container footer-inner">
        <div>
          <strong>CadLLM</strong> — Open-source AI-first breadboard, schematic &amp; PCB workbench.
          Licensed under <code>GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception</code> (plugin exception is a draft pending legal review).
        </div>
        <div class="footer-links">
          <a href="${escapeHtml(r)}/docs/FOUNDATION.html">Foundation Design</a>
          <a href="${escapeHtml(r)}/plugins/index.html">Plugin Store</a>
          <a href="${escapeHtml(r)}/registry/index.json">registry/index.json</a>
          <a href="${escapeHtml(r)}/docs/CONTRIBUTING.html">Contributing</a>
        </div>
      </div>
    </footer>
    ${scriptTags}
  </body>
</html>
`;
}

function buildLandingPage(): string {
  const cnlExample = `# examples/nand-led.cnl — button -> NAND gate -> LED
BAT1 battery 5V
D1   led red
R1   res 330
R2   res 10k
SW1  button
U1   74hc00

VCC: BAT1.+ U1.VCC U1.1A SW1.1
IN:  SW1.2 U1.1B R2.1
GND: BAT1.- U1.GND D1.K R2.2
Y:   U1.1Y R1.1
LA:  R1.2 D1.A

[tests]
test "nand truth table"
  logic in=SW1 out=U1.1Y
  expect table
    0 -> 1
    1 -> 0

test "led current"
  dc
  expect I(D1) 8m..15m
  expect V(LA) > 1.8`;

  const mcpTranscript = `find q="led"                    -> led  light-emitting diode  2p LED_D5.0mm/LED_D3.0mm  sim:spice
edit  BAT1 battery 5V ; R1 res 150 ; D1 led red
      VCC: BAT1.+ R1.1 ; LA: R1.2 D1.A ; GND: D1.K BAT1.-
                                -> ok rev=1 +BAT1 +D1 +R1 nets: +GND +LA +VCC
sim   run="dc"                  -> V(LA) 2.02  I(D1) 19.8m
edit  ~R1 resistance=220        -> ok rev=2 ~R1
sim   run="dc; expect I(D1) < 20m"
                                -> PASS (1/1)  I(D1) 13.6m < 20m
layout view=pcb                 -> ok rev=3 placed 3 in pcb
layout view=pcb op=route        -> ok rev=4 routed 3/3 nets (0 unrouted)
export format=fab               -> led-pcb-fab.zip (7 Gerbers, 2 Excellon drills, BOM, PnP)`;

  const installCommands = `# 1. Clone and verify (Node.js 24+)
npm install
npm run check                  # typecheck + full Vitest suite
npm run bench                  # MCP token benchmark

# 2. Run headless circuit unit tests
node packages/cli/src/main.ts test examples/nand-led.cnl
node packages/cli/src/main.ts test examples/blink.cnl

# 3. Start live Web UI + Streamable HTTP MCP server
npm run build -w @cadllm/ui
node packages/cli/src/main.ts serve examples/nand-led.cnl

# 4. Attach Claude Code or any MCP client to the live workspace
claude mcp add cadllm -- node /path/to/CadLLm/packages/cli/src/main.ts mcp

# 5. Install Ed25519-signed plugins from the registry
node packages/cli/src/main.ts plugin search --index https://samet1771.github.io/cadllm/registry/
node packages/cli/src/main.ts plugin install org.cadllm.example-sensors`;

  const bodyHtml = `
    <section class="hero">
      <div class="container">
        <div class="hero-eyebrow">AI-First Open-Source Electronics Workbench</div>
        <h1 class="hero-title">Build, simulate, route &amp; test circuits over MCP and in the browser.</h1>
        <p class="hero-subtitle">
          CadLLM unifies breadboard prototyping, ANSI schematics, 2-layer PCB layout, SPICE + Arduino simulation,
          and sandboxed plugins around one token-cheap circuit language (<strong>CNL</strong>).
          AI agents drive it headlessly in ~140 tokens per task; humans co-edit live in the browser UI.
        </p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="./app/index.html">Try Web UI in Browser (Demo Mode) →</a>
          <a class="btn" href="./plugins/index.html">Browse Verified Plugin Store</a>
          <a class="btn" href="./docs/FOUNDATION.html">Read Foundation Design</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <h2 class="section-title">Why CadLLM</h2>
        <div class="feature-grid">
          <div class="feature-card">
            <h3>1. Token-Cheap MCP (12 Tools)</h3>
            <p>
              One compact text grammar (CNL) for project files, reads, atomic edit batches, and structural diffs.
              Total MCP tool schema is ~1.3k tokens; building and verifying a 5 V LED circuit takes 5 calls and ~140 tokens.
            </p>
          </div>
          <div class="feature-card">
            <h3>2. One Netlist, Three Views</h3>
            <p>
              Canonical netlist with synchronized Breadboard, Schematic, and PCB views.
              Pure TypeScript SVG renderers work identically in the browser UI and headless MCP <code>render</code> tool.
            </p>
          </div>
          <div class="feature-card">
            <h3>3. Digital, SPICE &amp; Arduino Co-Sim</h3>
            <p>
              4-state event-driven digital logic, Modified Nodal Analysis DC solver, ngspice WASM transient/AC,
              and cycle-accurate ATmega328P (<code>avr8js</code> + <code>arduino-cli</code>) with embedded unit tests.
            </p>
          </div>
          <div class="feature-card">
            <h3>4. PCB Autorouting, DRC &amp; Fab Export</h3>
            <p>
              28 parametric IPC-7351 footprints, 9-rule DRC, deterministic 2-layer A* autorouter with vias and rip-up,
              RS-274X X2 Gerbers, Excellon PTH/NPTH drill files, BOM/PnP CSVs, and KiCad 9 export.
            </p>
          </div>
          <div class="feature-card">
            <h3>5. Live Human + AI Co-Editing</h3>
            <p>
              <code>cadllm serve</code> hosts the browser UI and attaches to stdio MCP sessions automatically.
              AI mutations highlight in real time with toast attribution and shared undo/redo history.
            </p>
          </div>
          <div class="feature-card">
            <h3>6. Sandboxed Plugins &amp; Signed Store</h3>
            <p>
              Code plugins run in isolated <code>node --permission</code> child processes with a preloaded network guard.
              Packages are signed with a two-tier Ed25519 trust chain and verified in both CLI and browser.
            </p>
          </div>
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container">
        <h2 class="section-title">Circuit Netlist Language (CNL) &amp; MCP in Action</h2>
        <div class="code-split">
          <div class="code-panel">
            <div class="code-panel-head">Project File &amp; Unit Tests (<code>examples/nand-led.cnl</code>)</div>
            <pre><code>${escapeHtml(cnlExample)}</code></pre>
          </div>
          <div class="code-panel">
            <div class="code-panel-head">5-Call Agent Session over MCP</div>
            <pre><code>${escapeHtml(mcpTranscript)}</code></pre>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <h2 class="section-title">Quick Start &amp; Commands</h2>
        <pre><code>${escapeHtml(installCommands)}</code></pre>
        <div class="quick-links-grid">
          <a class="quick-link-card" href="./app/index.html">
            <strong>Interactive Demo App (<code>/app/</code>)</strong>
            <span>Explore Arduino Blink, Button-LED, 74HC00 NAND, and routed PCB in the serverless browser UI.</span>
          </a>
          <a class="quick-link-card" href="./plugins/index.html">
            <strong>Verified Plugin Store (<code>/plugins/</code>)</strong>
            <span>Inspect registry packages verified live in your browser via WebCrypto Ed25519.</span>
          </a>
          <a class="quick-link-card" href="./docs/FOUNDATION.html">
            <strong>Architecture &amp; Milestone Plans (<code>/docs/</code>)</strong>
            <span>Read FOUNDATION.md and M0–M4 implementation plans and benchmark measurements.</span>
          </a>
          <a class="quick-link-card" href="./registry/index.html">
            <strong>Raw Registry Endpoint (<code>/registry/</code>)</strong>
            <span>Static <code>index.json</code>, <code>index.sig</code>, public keys, and deterministic <code>.cnlplugin</code> archives.</span>
          </a>
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title: 'AI-First Circuit Designer & Simulator',
    rootRel: '.',
    activeNav: 'home',
    bodyHtml,
  });
}

function buildPluginsStorePage(): string {
  const bodyHtml = `
    <section class="section">
      <div class="container">
        <div class="page-head">
          <div>
            <div class="hero-eyebrow">Two-Tier Ed25519 Trust Model</div>
            <h1 class="page-title">CadLLM Plugin Store</h1>
            <p class="page-lead">
              Every page load fetches <a href="../registry/index.json"><code>registry/index.json</code></a> and
              <a href="../registry/index.sig"><code>registry/index.sig</code></a> and verifies both the root registry signature
              and each publisher's version signature in your browser using <strong>WebCrypto Ed25519</strong> over canonical JSON.
            </p>
          </div>
        </div>

        <div id="store-verification-banner" class="verification-banner banner-loading" role="status">
          Verifying <code>registry/index.json</code> and <code>registry/index.sig</code> with WebCrypto Ed25519…
        </div>

        <noscript>
          <div class="verification-banner banner-error">
            JavaScript is required to run in-browser WebCrypto Ed25519 signature verification.
          </div>
        </noscript>

        <div class="store-toolbar">
          <input
            id="store-search-input"
            class="store-search-input"
            type="search"
            placeholder="Filter verified plugins by name, ID, summary, publisher, or license…"
            aria-label="Filter verified plugins"
          />
          <div class="store-key-box">
            <span class="section-mini-label">Embedded Root Registry Public Key (Ed25519 SPKI):</span>
            <code>MCowBQYDK2VwAyEA2Cy/9gOCq9K9KLo3cueaY56N4SNy+zNXCKMn2je64jI=</code>
          </div>
        </div>

        <div id="store-plugin-list" class="store-plugin-list" aria-live="polite"></div>

        <div class="store-trust-notes">
          <h2>How Verification &amp; Sandboxing Work</h2>
          <ul>
            <li>
              <strong>Root Registry Signature (<code>index.sig</code> &amp; <code>keys.signature</code>):</strong>
              Signed offline by the registry root key (<a href="../registry/registry.pub"><code>registry.pub</code></a>)
              over the canonical JSON (recursively sorted keys, zero whitespace) of <code>index.json</code> and the publisher key map.
            </li>
            <li>
              <strong>Publisher Package Signature:</strong>
              Each version entry (<code>version, engine, url, sha256, size, permissions, contributes</code>) is signed by the
              publisher's Ed25519 key (<a href="../registry/publishers/cadllm-examples.pub"><code>publishers/cadllm-examples.pub</code></a>).
            </li>
            <li>
              <strong>Zero Implicit Grants:</strong>
              Installing a plugin checks SHA-256, archive byte size, and zip-slip safety, and extracts into
              <code>~/.cadllm/plugins/&lt;id&gt;/&lt;version&gt;/</code> without granting any permissions automatically.
            </li>
            <li>
              <strong>Use This Registry From the CLI:</strong>
              <pre><code>cadllm plugin search --index https://samet1771.github.io/cadllm/registry/
cadllm plugin install org.cadllm.example-sensors --index https://samet1771.github.io/cadllm/registry/</code></pre>
            </li>
          </ul>
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title: 'Plugin Store',
    rootRel: '..',
    activeNav: 'plugins',
    bodyHtml,
    scripts: ['../assets/store-app.js'],
  });
}

function buildRegistryIndexPage(): string {
  const bodyHtml = `
    <section class="section">
      <div class="container">
        <div class="hero-eyebrow">Static CLI Registry Endpoint</div>
        <h1 class="page-title">CadLLM Plugin Registry (<code>/registry/</code>)</h1>
        <p class="page-lead">
          Point the CadLLM CLI at this directory URL to search and install Ed25519-signed plugins directly from GitHub Pages.
        </p>
        <pre><code>node packages/cli/src/main.ts plugin search --index https://samet1771.github.io/cadllm/registry/
node packages/cli/src/main.ts plugin install org.cadllm.example-sensors --index https://samet1771.github.io/cadllm/registry/</code></pre>

        <h2>Published Registry Files</h2>
        <ul>
          <li><a href="./index.json"><code>index.json</code></a> — Canonical signed plugin catalog and publisher Ed25519 key bindings</li>
          <li><a href="./index.sig"><code>index.sig</code></a> — Detached Ed25519 signature over canonical <code>index.json</code></li>
          <li><a href="./registry.pub"><code>registry.pub</code></a> — Root registry Ed25519 public key (SPKI PEM)</li>
          <li><a href="./publishers/cadllm-examples.pub"><code>publishers/cadllm-examples.pub</code></a> — Example publisher Ed25519 public key</li>
          <li><a href="./packages/org.cadllm.example-sensors-1.0.0.cnlplugin"><code>packages/org.cadllm.example-sensors-1.0.0.cnlplugin</code></a> — Deterministic signed plugin package</li>
          <li><a href="./README.md"><code>README.md</code></a> — Registry trust model &amp; publishing walkthrough</li>
        </ul>
      </div>
    </section>
  `;

  return renderShell({
    title: 'Registry Files',
    rootRel: '..',
    activeNav: 'registry',
    bodyHtml,
  });
}

function buildDocsIndexPage(): string {
  const cards = DOC_ENTRIES.map(
    d => `<a class="quick-link-card" href="./${escapeHtml(d.slug)}.html">
      <strong>${escapeHtml(d.title)} (<code>${escapeHtml(d.sourcePath)}</code>)</strong>
      <span>${escapeHtml(d.summary)}</span>
    </a>`,
  ).join('\n');

  const bodyHtml = `
    <section class="section">
      <div class="container">
        <div class="hero-eyebrow">Design &amp; Engineering Plans</div>
        <h1 class="page-title">CadLLM Documentation</h1>
        <div class="quick-links-grid">
          ${cards}
        </div>
      </div>
    </section>
  `;

  return renderShell({
    title: 'Documentation',
    rootRel: '..',
    activeNav: 'docs',
    bodyHtml,
  });
}

function buildDocPage(entry: DocEntry): string {
  const fullPath = join(ROOT_DIR, entry.sourcePath);
  const rawMd = readFileSync(fullPath, 'utf8');
  const htmlContent = renderMarkdown(rawMd, {
    rewriteLink: href => rewriteDocMarkdownLink(href, true),
  });

  const sidebarLinks = DOC_ENTRIES.map(
    d =>
      `<li><a class="docs-nav-link${d.slug === entry.slug ? ' active' : ''}" href="./${escapeHtml(d.slug)}.html">${escapeHtml(d.title)}</a></li>`,
  ).join('\n');

  const bodyHtml = `
    <section class="section">
      <div class="container docs-layout">
        <aside class="docs-sidebar" aria-label="Documentation navigation">
          <div class="docs-sidebar-title">Documents</div>
          <ul class="docs-nav-list">
            ${sidebarLinks}
          </ul>
        </aside>
        <article class="docs-content markdown-body">
          ${htmlContent}
        </article>
      </div>
    </section>
  `;

  return renderShell({
    title: entry.title,
    rootRel: '..',
    activeNav: 'docs',
    bodyHtml,
  });
}

function buildSiteCss(): string {
  return `/* SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception */
:root {
  --bg: #f6f8fa;
  --surface: #ffffff;
  --surface-alt: #eef2f6;
  --border: #d0d7de;
  --text: #1f2328;
  --text-muted: #59636e;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --accent-soft: rgba(37, 99, 235, 0.1);
  --ok-bg: #dafbe1;
  --ok-border: #2da44e;
  --ok-text: #116329;
  --err-bg: #ffebe9;
  --err-border: #cf222e;
  --err-text: #82071e;
  --warn-bg: #fff8c5;
  --warn-border: #d4a72c;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-alt: #21262d;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --accent-hover: #79c0ff;
    --accent-soft: rgba(88, 166, 255, 0.15);
    --ok-bg: rgba(46, 160, 67, 0.18);
    --ok-border: #3fb950;
    --ok-text: #7ee787;
    --err-bg: rgba(248, 81, 73, 0.18);
    --err-border: #f85149;
    --err-text: #ffa198;
    --warn-bg: rgba(210, 153, 34, 0.18);
    --warn-border: #d29922;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.6;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

code, pre {
  font-family: var(--font-mono);
  font-size: 0.9em;
}

code {
  background: var(--surface-alt);
  padding: 0.15em 0.4em;
  border-radius: 4px;
}

pre {
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  line-height: 1.45;
  margin: 12px 0;
}

pre code {
  background: none;
  padding: 0;
}

.container {
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 20px;
}

.site-header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 58px;
  gap: 16px;
  flex-wrap: wrap;
}

.site-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-weight: 700;
  font-size: 17px;
  text-decoration: none;
}

.brand-tag {
  font-size: 11.5px;
  font-weight: 500;
  font-family: var(--font-mono);
  color: var(--text-muted);
  background: var(--surface-alt);
  border: 1px solid var(--border);
  padding: 1px 7px;
  border-radius: 999px;
}

.site-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.nav-link {
  color: var(--text-muted);
  padding: 5px 11px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
}

.nav-link:hover, .nav-link.active {
  color: var(--text);
  background: var(--surface-alt);
  text-decoration: none;
}

.hero {
  padding: 54px 0 42px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.hero-eyebrow {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent);
  margin-bottom: 8px;
}

.hero-title {
  font-size: 34px;
  line-height: 1.2;
  margin: 0 0 14px;
  max-width: 840px;
}

.hero-subtitle {
  font-size: 17px;
  color: var(--text-muted);
  max-width: 820px;
  margin: 0 0 24px;
}

.hero-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  font-size: 14px;
  text-decoration: none;
  cursor: pointer;
}

.btn:hover {
  background: var(--surface-alt);
  text-decoration: none;
}

.btn-sm {
  padding: 5px 11px;
  font-size: 13px;
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

.btn-primary:hover {
  background: var(--accent-hover);
  color: #ffffff;
}

.section {
  padding: 40px 0;
}

.section-alt {
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.section-title {
  font-size: 24px;
  margin: 0 0 20px;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
  gap: 16px;
}

.feature-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px 20px;
}

.feature-card h3 {
  margin: 0 0 8px;
  font-size: 16.5px;
}

.feature-card p {
  margin: 0;
  color: var(--text-muted);
  font-size: 14px;
}

.code-split {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 16px;
}

.code-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.code-panel-head {
  padding: 8px 14px;
  background: var(--surface-alt);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
}

.code-panel pre {
  margin: 0;
  border: none;
  border-radius: 0;
}

.quick-links-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 14px;
  margin-top: 20px;
}

.quick-link-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
}

.quick-link-card:hover {
  border-color: var(--accent);
  text-decoration: none;
}

.quick-link-card span {
  font-size: 13.5px;
  color: var(--text-muted);
}

/* Store Page */
.page-title {
  margin: 0 0 10px;
  font-size: 30px;
}

.page-lead {
  margin: 0 0 20px;
  color: var(--text-muted);
  max-width: 860px;
}

.verification-banner {
  padding: 14px 18px;
  border-radius: 8px;
  border: 1.5px solid var(--border);
  margin-bottom: 20px;
  font-size: 14.5px;
}

.banner-loading {
  background: var(--surface-alt);
}

.banner-verified {
  background: var(--ok-bg);
  border-color: var(--ok-border);
  color: var(--ok-text);
}

.banner-error {
  background: var(--err-bg);
  border-color: var(--err-border);
  color: var(--err-text);
}

.store-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 20px;
}

.store-search-input {
  width: 100%;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 14.5px;
}

.store-key-box {
  font-size: 12.5px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.store-plugin-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.store-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.store-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.store-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.store-plugin-name {
  margin: 0;
  font-size: 20px;
}

.store-plugin-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 4px;
}

.store-plugin-summary {
  margin: 0;
  font-size: 15px;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--surface-alt);
  border: 1px solid var(--border);
}

.badge-verified {
  background: var(--ok-bg);
  border-color: var(--ok-border);
  color: var(--ok-text);
}

.badge-contrib {
  font-family: var(--font-mono);
}

.store-badges-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.section-mini-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.store-perms-box, .store-install-box {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}

.perm-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.perm-item {
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.perm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13.5px;
}

.perm-detail {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 2px;
}

.install-cmd {
  margin: 6px 0;
}

.store-integrity {
  font-size: 12px;
  color: var(--text-muted);
}

.store-trust-notes {
  margin-top: 36px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}

/* Docs Layout */
.docs-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 28px;
  align-items: start;
}

@media (max-width: 820px) {
  .docs-layout {
    grid-template-columns: 1fr;
  }
}

.docs-sidebar {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  position: sticky;
  top: 76px;
}

.docs-sidebar-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.docs-nav-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.docs-nav-link {
  display: block;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 13.5px;
}

.docs-nav-link.active, .docs-nav-link:hover {
  background: var(--surface-alt);
  color: var(--text);
  text-decoration: none;
  font-weight: 600;
}

.docs-content {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 28px 34px;
  min-width: 0;
}

.markdown-body h1 {
  margin-top: 0;
  font-size: 28px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 10px;
}

.markdown-body h2 {
  margin-top: 28px;
  font-size: 21px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}

.markdown-body h3 {
  margin-top: 22px;
  font-size: 17px;
}

.table-wrap {
  overflow-x: auto;
  margin: 14px 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
}

th, td {
  border: 1px solid var(--border);
  padding: 8px 11px;
  text-align: left;
}

th {
  background: var(--surface-alt);
  font-weight: 600;
}

blockquote {
  margin: 14px 0;
  padding: 10px 16px;
  border-left: 4px solid var(--accent);
  background: var(--surface-alt);
  border-radius: 0 6px 6px 0;
}

blockquote p {
  margin: 0;
}

.alert-title {
  font-weight: 700;
  font-size: 12.5px;
  margin-bottom: 4px;
}

.alert-important, .alert-warning, .alert-caution {
  border-left-color: var(--warn-border);
  background: var(--warn-bg);
}

.site-footer {
  border-top: 1px solid var(--border);
  background: var(--surface);
  padding: 24px 0;
  margin-top: 40px;
  font-size: 13px;
  color: var(--text-muted);
}

.footer-inner {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.footer-links {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
`;
}

function transpileTsModuleForBrowser(tsFilePath: string): string {
  const source = readFileSync(tsFilePath, 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  return stripped.replace(/(from\s+['"]\.[^'"]+)\.ts(['"])/g, '$1.js$2');
}

function buildDemoUiIntoSite(): void {
  const uiDir = join(ROOT_DIR, 'packages', 'ui');
  const appOutDir = join(DIST_DIR, 'app');
  const viteBin = join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

  if (existsSync(viteBin)) {
    const res = spawnSync(
      process.execPath,
      [viteBin, 'build', '--base=./', '--outDir', appOutDir, '--emptyOutDir'],
      {
        cwd: uiDir,
        env: { ...process.env, VITE_DEMO: '1' },
        stdio: 'inherit',
      },
    );
    if (res.status !== 0) {
      throw new Error(`vite build for /app/ failed with exit code ${res.status}`);
    }
  } else {
    const existingUiDist = join(uiDir, 'dist');
    if (!existsSync(existingUiDist)) {
      throw new Error('packages/ui/dist not found and vite binary is unavailable');
    }
    copyDirRecursive(existingUiDist, appOutDir);
  }

  const appIndexPath = join(appOutDir, 'index.html');
  if (existsSync(appIndexPath)) {
    let html = readFileSync(appIndexPath, 'utf8');
    if (!html.includes('http-equiv="Content-Security-Policy"')) {
      html = html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(STRICT_APP_CSP)}" />`,
      );
      writeFileSync(appIndexPath, html, 'utf8');
    }
  }
}

export async function buildSite(): Promise<void> {
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(join(DIST_DIR, 'assets'), { recursive: true });
  mkdirSync(join(DIST_DIR, 'plugins'), { recursive: true });
  mkdirSync(join(DIST_DIR, 'docs'), { recursive: true });
  mkdirSync(join(DIST_DIR, 'registry'), { recursive: true });

  writeFileSync(join(DIST_DIR, '.nojekyll'), '', 'utf8');

  // 1. Copy raw registry files to site/dist/registry/
  const srcRegistryDir = join(ROOT_DIR, 'registry');
  copyDirRecursive(srcRegistryDir, join(DIST_DIR, 'registry'));
  writeFileSync(join(DIST_DIR, 'registry', 'index.html'), buildRegistryIndexPage(), 'utf8');

  // 2. Self-verify the copied registry index and signature with WebCrypto Ed25519
  const copiedIndex = JSON.parse(readFileSync(join(DIST_DIR, 'registry', 'index.json'), 'utf8')) as unknown;
  const copiedSig = readFileSync(join(DIST_DIR, 'registry', 'index.sig'), 'utf8');
  const copiedPub = readFileSync(join(DIST_DIR, 'registry', 'registry.pub'), 'utf8').trim();
  if (copiedPub !== EMBEDDED_REGISTRY_PUBLIC_KEY.trim()) {
    throw new Error('EMBEDDED_REGISTRY_PUBLIC_KEY in site/lib/verify.ts does not match registry/registry.pub');
  }
  const verifyRes = await verifyIndexWebCrypto(copiedIndex, copiedSig, EMBEDDED_REGISTRY_PUBLIC_KEY);
  if (!verifyRes.ok) {
    throw new Error(`Registry signature verification failed during site build: ${verifyRes.error}`);
  }

  // 3. Emit assets (CSS + type-stripped browser ES modules)
  writeFileSync(join(DIST_DIR, 'assets', 'site.css'), buildSiteCss(), 'utf8');
  writeFileSync(
    join(DIST_DIR, 'assets', 'verify.js'),
    transpileTsModuleForBrowser(join(SITE_DIR, 'lib', 'verify.ts')),
    'utf8',
  );
  writeFileSync(
    join(DIST_DIR, 'assets', 'store-app.js'),
    transpileTsModuleForBrowser(join(SITE_DIR, 'lib', 'store-app.ts')),
    'utf8',
  );

  // 4. Build landing page and plugin store page
  writeFileSync(join(DIST_DIR, 'index.html'), buildLandingPage(), 'utf8');
  writeFileSync(join(DIST_DIR, 'plugins', 'index.html'), buildPluginsStorePage(), 'utf8');

  // 5. Build docs pages (both canonical uppercase and lowercase aliases for case-sensitive servers)
  writeFileSync(join(DIST_DIR, 'docs', 'index.html'), buildDocsIndexPage(), 'utf8');
  for (const entry of DOC_ENTRIES) {
    if (!existsSync(join(ROOT_DIR, entry.sourcePath))) continue;
    const html = buildDocPage(entry);
    writeFileSync(join(DIST_DIR, 'docs', `${entry.slug}.html`), html, 'utf8');
    const lowerSlug = entry.slug.toLowerCase();
    if (lowerSlug !== entry.slug) {
      writeFileSync(join(DIST_DIR, 'docs', `${lowerSlug}.html`), html, 'utf8');
    }
  }

  // 6. Build @cadllm/ui in demo mode (VITE_DEMO=1) into site/dist/app/
  buildDemoUiIntoSite();

  console.log(
    `Built CadLLM Pages site in ${DIST_DIR} (${verifyRes.plugins.length} verified registry plugin(s), ${DOC_ENTRIES.length} docs pages, and /app/ demo UI).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSite();
}

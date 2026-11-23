// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import {
  EMBEDDED_REGISTRY_PUBLIC_KEY,
  verifyIndexWebCrypto,
  type VerifiedStorePlugin,
  type VerifyRegistryOutcome,
} from './verify.ts';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function renderPluginCardHtml(plugin: VerifiedStorePlugin, registryRelBase = '../registry'): string {
  const v = plugin.latestVersion;
  const pkgHref = v.url ? `${registryRelBase}/${v.url.replace(/^\/+/, '')}` : '#';
  const shortSha = v.sha256 ? `${v.sha256.slice(0, 16)}…` : 'n/a';

  const contribBadges = v.contributes
    .map(c => `<span class="badge badge-contrib">${escapeHtml(c)}</span>`)
    .join('');

  const permsHtml =
    plugin.plainPermissions.length === 0
      ? '<div class="perm-empty">No special permissions requested (data-only plugin).</div>'
      : `<ul class="perm-list">${plugin.plainPermissions
          .map(
            p =>
              `<li class="perm-item perm-risk-${escapeHtml(p.risk)}">
                <div class="perm-head">
                  <strong>${escapeHtml(p.title)}</strong>
                  <code>${escapeHtml(p.permission)}</code>
                </div>
                <div class="perm-detail">${escapeHtml(p.detail)}</div>
              </li>`,
          )
          .join('')}</ul>`;

  return `<article class="store-card" data-plugin-id="${escapeHtml(plugin.id)}">
    <div class="store-card-header">
      <div>
        <div class="store-title-row">
          <h3 class="store-plugin-name">${escapeHtml(plugin.name)}</h3>
          <span class="badge badge-verified" title="Ed25519 registry and publisher signatures verified in browser via WebCrypto">✓ Ed25519 Verified</span>
        </div>
        <div class="store-plugin-meta">
          <code>${escapeHtml(plugin.id)}</code>
          <span>·</span>
          <span>v${escapeHtml(v.version)}</span>
          <span>·</span>
          <span>Publisher: <strong>${escapeHtml(plugin.publisher)}</strong></span>
          <span>·</span>
          <span>License: <strong>${escapeHtml(plugin.license)}</strong></span>
          <span>·</span>
          <span>Engine: <code>${escapeHtml(v.engine)}</code></span>
        </div>
      </div>
      <a class="btn btn-sm" href="${escapeHtml(pkgHref)}" download>Download .cnlplugin (${escapeHtml(formatBytes(v.size))})</a>
    </div>

    <p class="store-plugin-summary">${escapeHtml(plugin.summary)}</p>

    <div class="store-badges-row">
      <span class="section-mini-label">Contributes:</span>
      ${contribBadges || '<span class="badge">none</span>'}
    </div>

    <div class="store-perms-box">
      <div class="section-mini-label">Requested Permissions (never granted automatically on install)</div>
      ${permsHtml}
    </div>

    <div class="store-install-box">
      <div class="section-mini-label">Install via CLI</div>
      <pre class="install-cmd"><code>${escapeHtml(plugin.installCommand)}</code></pre>
      <div class="store-integrity">
        <span>SHA-256: <code title="${escapeHtml(v.sha256)}">${escapeHtml(shortSha)}</code></span>
      </div>
    </div>
  </article>`;
}

export function renderStoreStateHtml(outcome: VerifyRegistryOutcome, filterQuery = ''): {
  bannerClass: 'banner-verified' | 'banner-error';
  bannerHtml: string;
  cardsHtml: string;
  verifiedCount: number;
} {
  if (!outcome.ok) {
    return {
      bannerClass: 'banner-error',
      bannerHtml: `<strong>Signature Verification Failed:</strong> ${escapeHtml(outcome.error)}. No plugins are listed as verified.`,
      cardsHtml: '',
      verifiedCount: 0,
    };
  }

  const q = filterQuery.trim().toLowerCase();
  const filtered = q
    ? outcome.plugins.filter(
        p =>
          p.id.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.summary.toLowerCase().includes(q) ||
          p.publisher.toLowerCase().includes(q) ||
          p.license.toLowerCase().includes(q),
      )
    : outcome.plugins;

  const cardsHtml =
    filtered.length === 0
      ? `<div class="store-empty">No verified plugins match "${escapeHtml(filterQuery)}".</div>`
      : filtered.map(p => renderPluginCardHtml(p)).join('\n');

  return {
    bannerClass: 'banner-verified',
    bannerHtml: `<strong>✓ Registry Verified (WebCrypto Ed25519):</strong> Verified detached <code>index.sig</code>, publisher key bindings, and ${outcome.plugins.length} signed plugin package${outcome.plugins.length === 1 ? '' : 's'} against the embedded root registry key.`,
    cardsHtml,
    verifiedCount: outcome.plugins.length,
  };
}

interface MinimalElement {
  innerHTML: string;
  textContent: string | null;
  className: string;
  value?: string;
  hidden: boolean;
  addEventListener(type: string, listener: () => void): void;
}

interface MinimalDocument {
  getElementById(id: string): MinimalElement | null;
}

export async function bootStorePage(
  doc?: MinimalDocument,
  indexUrl = '../registry/index.json',
  sigUrl = '../registry/index.sig',
): Promise<VerifyRegistryOutcome> {
  const targetDoc =
    doc ?? (globalThis as unknown as { document?: MinimalDocument }).document;
  const bannerEl = targetDoc?.getElementById('store-verification-banner') ?? null;
  const listEl = targetDoc?.getElementById('store-plugin-list') ?? null;
  const searchEl = targetDoc?.getElementById('store-search-input') ?? null;

  let outcome: VerifyRegistryOutcome;
  try {
    const [indexRes, sigRes] = await Promise.all([fetch(indexUrl), fetch(sigUrl)]);
    if (!indexRes.ok) {
      throw new Error(`HTTP ${indexRes.status} fetching ${indexUrl}`);
    }
    if (!sigRes.ok) {
      throw new Error(`HTTP ${sigRes.status} fetching ${sigUrl}`);
    }
    const [indexJson, sigText] = await Promise.all([indexRes.json(), sigRes.text()]);
    outcome = await verifyIndexWebCrypto(indexJson, sigText, EMBEDDED_REGISTRY_PUBLIC_KEY);
  } catch (err) {
    outcome = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      plugins: [],
    };
  }

  const updateDom = (query: string) => {
    const view = renderStoreStateHtml(outcome, query);
    if (bannerEl) {
      bannerEl.className = `verification-banner ${view.bannerClass}`;
      bannerEl.innerHTML = view.bannerHtml;
      bannerEl.hidden = false;
    }
    if (listEl) {
      listEl.innerHTML = view.cardsHtml;
    }
  };

  updateDom(searchEl?.value ?? '');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      updateDom(searchEl.value ?? '');
    });
  }

  return outcome;
}

// Auto-boot when loaded in a browser document with #store-verification-banner.
const maybeBrowserDoc = (globalThis as unknown as { document?: MinimalDocument }).document;
if (maybeBrowserDoc && maybeBrowserDoc.getElementById('store-verification-banner')) {
  void bootStorePage(maybeBrowserDoc);
}

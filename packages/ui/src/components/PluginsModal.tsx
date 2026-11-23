// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useMemo, useState } from 'react';
import {
  createInitialGrantSelection,
  describePermission,
  filterRegistryPlugins,
  latestRegistryVersion,
} from '../lib/plugins.ts';
import type { PluginStatusItem, RegistryPluginItem } from '../lib/types.ts';

type PluginsTab = 'installed' | 'browse';

interface PluginsModalProps {
  open: boolean;
  installed: PluginStatusItem[];
  indexEntries: RegistryPluginItem[];
  loadingInstalled: boolean;
  loadingIndex: boolean;
  indexError?: string;
  busyPluginId?: string;
  onClose: () => void;
  onRefreshInstalled: () => void;
  onRefreshIndex: () => void;
  onInstall: (id: string, range: string | undefined, grantedPermissions: string[]) => Promise<void>;
  onGrant: (id: string, permissions: string[]) => Promise<void>;
  onRevoke: (id: string, permissions: string[]) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onOpenPanel: (pluginId: string, panelId: string, title: string) => void;
}

export function PluginsModal({
  open,
  installed,
  indexEntries,
  loadingInstalled,
  loadingIndex,
  indexError,
  busyPluginId,
  onClose,
  onRefreshInstalled,
  onRefreshIndex,
  onInstall,
  onGrant,
  onRevoke,
  onRemove,
  onOpenPanel,
}: PluginsModalProps) {
  const [tab, setTab] = useState<PluginsTab>('installed');
  const [search, setSearch] = useState('');
  const [reviewTarget, setReviewTarget] = useState<RegistryPluginItem | null>(null);
  const [reviewChecked, setReviewChecked] = useState<Record<string, boolean>>({});
  const [confirmRemove, setConfirmRemove] = useState<PluginStatusItem | null>(null);

  const installedIds = useMemo(() => new Set(installed.map(p => p.id)), [installed]);
  const filteredIndex = useMemo(() => filterRegistryPlugins(indexEntries, search), [indexEntries, search]);

  if (!open) return null;

  const openInstallReview = (entry: RegistryPluginItem) => {
    const latest = latestRegistryVersion(entry);
    setReviewTarget(entry);
    setReviewChecked(createInitialGrantSelection(latest?.permissions ?? []));
  };

  const confirmInstall = async () => {
    if (!reviewTarget) return;
    const latest = latestRegistryVersion(reviewTarget);
    const chosen = (latest?.permissions ?? []).filter(p => Boolean(reviewChecked[p]));
    const targetId = reviewTarget.id;
    const range = latest?.version;
    setReviewTarget(null);
    await onInstall(targetId, range, chosen);
    setTab('installed');
  };

  const confirmUninstall = async () => {
    if (!confirmRemove) return;
    const targetId = confirmRemove.id;
    setConfirmRemove(null);
    await onRemove(targetId);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Plugins Manager">
      <div className="modal-card plugins-modal">
        <div className="modal-header">
          <div className="plugins-header-left">
            <span className="modal-title">Plugins</span>
            <div className="view-tabs">
              <button
                type="button"
                className={`view-tab ${tab === 'installed' ? 'active' : ''}`}
                onClick={() => setTab('installed')}
              >
                Installed ({installed.length})
              </button>
              <button
                type="button"
                className={`view-tab ${tab === 'browse' ? 'active' : ''}`}
                onClick={() => {
                  setTab('browse');
                  if (indexEntries.length === 0 && !loadingIndex) onRefreshIndex();
                }}
              >
                Browse
              </button>
            </div>
          </div>
          <div className="btn-group">
            <button
              type="button"
              className="btn btn-sm"
              onClick={tab === 'installed' ? onRefreshInstalled : onRefreshIndex}
              disabled={tab === 'installed' ? loadingInstalled : loadingIndex}
            >
              Refresh
            </button>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="modal-body plugins-body">
          {tab === 'installed' ? (
            loadingInstalled && installed.length === 0 ? (
              <div className="empty-hint">Loading installed plugins…</div>
            ) : installed.length === 0 ? (
              <div className="empty-hint">
                No plugins installed yet. Switch to <strong>Browse</strong> to install one from the registry.
              </div>
            ) : (
              <div className="plugin-list">
                {installed.map(plugin => {
                  const isBusy = busyPluginId === plugin.id;
                  const grantedSet = new Set(plugin.grantedPermissions);
                  const panels = plugin.contributes.panels ?? [];
                  return (
                    <div key={plugin.id} className="plugin-card">
                      <div className="plugin-card-head">
                        <div className="plugin-card-title-wrap">
                          <span className="plugin-name">{plugin.name}</span>
                          <span className="plugin-meta-mono">{plugin.id}@{plugin.version}</span>
                          <span className={`plugin-state-badge state-${plugin.state}`}>
                            {plugin.state === 'loaded' ? 'Loaded' : 'Failed'}
                          </span>
                        </div>
                        <div className="btn-group">
                          {plugin.state === 'loaded' && panels.map(panel => (
                            <button
                              key={panel.id}
                              type="button"
                              className="btn btn-sm btn-accent"
                              onClick={() => onOpenPanel(plugin.id, panel.id, panel.title)}
                            >
                              Open {panel.title}
                            </button>
                          ))}
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={isBusy}
                            onClick={() => setConfirmRemove(plugin)}
                          >
                            Uninstall
                          </button>
                        </div>
                      </div>

                      {plugin.summary && <div className="plugin-summary">{plugin.summary}</div>}
                      <div className="plugin-badges">
                        <span className="plugin-badge">License: {plugin.license}</span>
                        {plugin.publisher && <span className="plugin-badge">Publisher: {plugin.publisher}</span>}
                        {plugin.contributions.map(kind => (
                          <span key={kind} className="plugin-badge badge-contrib">{kind}</span>
                        ))}
                      </div>

                      {plugin.state === 'failed' && plugin.error && (
                        <div className="plugin-error-box">
                          <strong>Load failed:</strong> {plugin.error}
                        </div>
                      )}

                      <div className="plugin-perms-section">
                        <div className="section-label">Permissions</div>
                        {plugin.requestedPermissions.length === 0 ? (
                          <div className="plugin-no-perms">No special permissions requested.</div>
                        ) : (
                          <div className="plugin-perm-list">
                            {plugin.requestedPermissions.map(perm => {
                              const desc = describePermission(perm);
                              const granted = grantedSet.has(perm);
                              return (
                                <label key={perm} className="plugin-perm-row">
                                  <input
                                    type="checkbox"
                                    checked={granted}
                                    disabled={isBusy}
                                    onChange={e => {
                                      if (e.target.checked) void onGrant(plugin.id, [perm]);
                                      else void onRevoke(plugin.id, [perm]);
                                    }}
                                  />
                                  <div className="plugin-perm-text">
                                    <div className="plugin-perm-title">
                                      <span>{desc.title}</span>
                                      <code className="plugin-perm-code">{perm}</code>
                                    </div>
                                    <div className="plugin-perm-detail">{desc.detail}</div>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="browse-pane">
              <div className="browse-search">
                <input
                  className="input"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search registry plugins by name, id, summary, publisher…"
                  aria-label="Search registry plugins"
                />
              </div>
              {indexError && (
                <div className="plugin-error-box">{indexError}</div>
              )}
              {loadingIndex && indexEntries.length === 0 ? (
                <div className="empty-hint">Loading registry index…</div>
              ) : filteredIndex.length === 0 ? (
                <div className="empty-hint">
                  {indexEntries.length === 0 ? 'Registry index is empty.' : `No plugins match "${search}".`}
                </div>
              ) : (
                <div className="plugin-list">
                  {filteredIndex.map(entry => {
                    const latest = latestRegistryVersion(entry);
                    const isInstalled = installedIds.has(entry.id);
                    const isBusy = busyPluginId === entry.id;
                    return (
                      <div key={entry.id} className="plugin-card">
                        <div className="plugin-card-head">
                          <div className="plugin-card-title-wrap">
                            <span className="plugin-name">{entry.name}</span>
                            <span className="plugin-meta-mono">
                              {entry.id}{latest ? `@${latest.version}` : ''}
                            </span>
                          </div>
                          {isInstalled ? (
                            <span className="plugin-state-badge state-loaded">Installed</span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={!latest || isBusy}
                              onClick={() => openInstallReview(entry)}
                            >
                              Install…
                            </button>
                          )}
                        </div>
                        <div className="plugin-summary">{entry.summary}</div>
                        <div className="plugin-badges">
                          <span className="plugin-badge">Publisher: {entry.publisher}</span>
                          {entry.license && <span className="plugin-badge">License: {entry.license}</span>}
                          {latest && (
                            <span className="plugin-badge">
                              {latest.permissions.length === 0
                                ? 'No permissions'
                                : `${latest.permissions.length} permission${latest.permissions.length === 1 ? '' : 's'}`}
                            </span>
                          )}
                          {latest?.contributes.map(kind => (
                            <span key={kind} className="plugin-badge badge-contrib">{kind}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {reviewTarget && (
        <div className="modal-backdrop modal-nested" role="dialog" aria-modal="true" aria-label="Review Plugin Permissions">
          <div className="modal-card confirm-modal">
            <div className="modal-header">
              <span className="modal-title">Permission Review — {reviewTarget.name}</span>
            </div>
            <div className="modal-body">
              <p className="confirm-lead">
                Installing <code>{reviewTarget.id}</code>
                {latestRegistryVersion(reviewTarget) ? `@${latestRegistryVersion(reviewTarget)!.version}` : ''} by{' '}
                <strong>{reviewTarget.publisher}</strong>.
              </p>
              <p className="confirm-sub">
                Choose which requested permissions to grant now. All permissions start unchecked; you can grant or revoke them later.
              </p>
              {(latestRegistryVersion(reviewTarget)?.permissions ?? []).length === 0 ? (
                <div className="plugin-no-perms">This plugin requests no special permissions.</div>
              ) : (
                <div className="plugin-perm-list">
                  {(latestRegistryVersion(reviewTarget)?.permissions ?? []).map(perm => {
                    const desc = describePermission(perm);
                    return (
                      <label key={perm} className="plugin-perm-row">
                        <input
                          type="checkbox"
                          checked={Boolean(reviewChecked[perm])}
                          onChange={e =>
                            setReviewChecked(prev => ({ ...prev, [perm]: e.target.checked }))
                          }
                        />
                        <div className="plugin-perm-text">
                          <div className="plugin-perm-title">
                            <span>{desc.title}</span>
                            <code className="plugin-perm-code">{perm}</code>
                          </div>
                          <div className="plugin-perm-detail">{desc.detail}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setReviewTarget(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void confirmInstall()}>
                Install
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRemove && (
        <div className="modal-backdrop modal-nested" role="dialog" aria-modal="true" aria-label="Confirm Uninstall">
          <div className="modal-card confirm-modal">
            <div className="modal-header">
              <span className="modal-title">Uninstall Plugin</span>
            </div>
            <div className="modal-body">
              <p className="confirm-lead">
                Remove <strong>{confirmRemove.name}</strong> (<code>{confirmRemove.id}@{confirmRemove.version}</code>)?
              </p>
              <p className="confirm-sub">
                Its parts, tools, checks, and panels will be unloaded from the workspace.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setConfirmRemove(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void confirmUninstall()}>
                Uninstall
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

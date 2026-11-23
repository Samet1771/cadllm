// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPanelSrcDoc, createPanelMessageHandler } from '../lib/panelHost.ts';

export interface ActivePluginPanel {
  pluginId: string;
  pluginName: string;
  panelId: string;
  title: string;
  html: string;
}

interface PendingEditPrompt {
  cnl: string;
  resolve: (approved: boolean) => void;
}

interface PluginPanelHostProps {
  panel: ActivePluginPanel;
  grantedPermissions: string[];
  onReadProject: (opts: { detail?: 0 | 1 | 2; select?: string }) => Promise<string>;
  onApplyPluginEdit: (pluginId: string, cnl: string) => Promise<string>;
  onReload: () => void;
  onClose: () => void;
}

export function PluginPanelHost({
  panel,
  grantedPermissions,
  onReadProject,
  onApplyPluginEdit,
  onReload,
  onClose,
}: PluginPanelHostProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEditPrompt | null>(null);

  const grantedRef = useRef(grantedPermissions);
  grantedRef.current = grantedPermissions;
  const readRef = useRef(onReadProject);
  readRef.current = onReadProject;
  const applyRef = useRef(onApplyPluginEdit);
  applyRef.current = onApplyPluginEdit;
  const pluginIdRef = useRef(panel.pluginId);
  pluginIdRef.current = panel.pluginId;
  const pendingRef = useRef<PendingEditPrompt | null>(null);

  const srcdoc = useMemo(() => buildPanelSrcDoc(panel.html), [panel.html]);

  useEffect(() => {
    const handler = createPanelMessageHandler({
      getContentWindow: () => iframeRef.current?.contentWindow ?? null,
      getGrantedPermissions: () => grantedRef.current,
      readProject: opts => readRef.current(opts),
      requestEditConfirmation: cnl =>
        new Promise<boolean>(resolve => {
          const prompt: PendingEditPrompt = { cnl, resolve };
          pendingRef.current = prompt;
          setPendingEdit(prompt);
        }),
      applyEdit: cnl => applyRef.current(pluginIdRef.current, cnl),
    });

    const onWindowMessage = (ev: MessageEvent) => {
      void handler({ source: ev.source, origin: ev.origin, data: ev.data });
    };
    window.addEventListener('message', onWindowMessage);
    return () => {
      window.removeEventListener('message', onWindowMessage);
      if (pendingRef.current) {
        pendingRef.current.resolve(false);
        pendingRef.current = null;
        setPendingEdit(null);
      }
    };
  }, [panel.pluginId, panel.panelId, srcdoc]);

  const finishConfirm = (approved: boolean) => {
    const cur = pendingRef.current;
    pendingRef.current = null;
    setPendingEdit(null);
    cur?.resolve(approved);
  };

  const canRead = grantedPermissions.includes('project:read');
  const canWrite = grantedPermissions.includes('project:write');

  return (
    <aside className="plugin-panel-dock" aria-label={`Plugin panel: ${panel.title}`}>
      <div className="panel-header">
        <div className="plugin-panel-title-wrap">
          <span className="panel-title">{panel.title}</span>
          <span className="muted-tag">{panel.pluginId}</span>
        </div>
        <div className="btn-group">
          <span className={`plugin-cap-pill ${canRead ? 'cap-on' : 'cap-off'}`} title="project:read permission">
            read: {canRead ? 'on' : 'off'}
          </span>
          <span className={`plugin-cap-pill ${canWrite ? 'cap-on' : 'cap-off'}`} title="project:write permission">
            write: {canWrite ? 'on' : 'off'}
          </span>
          <button type="button" className="btn btn-sm" onClick={onReload} title="Reload panel">
            Reload
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose} title="Close panel">
            ×
          </button>
        </div>
      </div>

      <iframe
        ref={iframeRef}
        className="plugin-panel-iframe"
        title={`${panel.pluginName}: ${panel.title}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcdoc}
      />

      {pendingEdit && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm Plugin Edit">
          <div className="modal-card confirm-modal">
            <div className="modal-header">
              <span className="modal-title">Confirm Plugin Edit</span>
            </div>
            <div className="modal-body">
              <p className="confirm-lead">
                Plugin <strong>{panel.pluginName}</strong> (<code>{panel.pluginId}</code>) wants to apply this CNL edit:
              </p>
              <pre className="confirm-cnl-pre">{pendingEdit.cnl}</pre>
              {!canWrite && (
                <div className="plugin-error-box">
                  <code>project:write</code> permission is currently revoked.
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => finishConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canWrite}
                onClick={() => finishConfirm(true)}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

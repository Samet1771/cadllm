// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useState, type FormEvent } from 'react';
import type { ConnectionStatus, ProjectSummary, ThemePreference } from '../lib/types.ts';

interface TopBarProps {
  projectName: string;
  rev: number;
  projects: ProjectSummary[];
  status: ConnectionStatus;
  themePref: ThemePreference;
  isDemo: boolean;
  pluginCount?: number;
  availablePanels?: { pluginId: string; pluginName: string; panelId: string; title: string }[];
  onOpenPlugins?: () => void;
  onOpenPanel?: (pluginId: string, panelId: string, title: string) => void;
  onThemePrefChange: (pref: ThemePreference) => void;
  onSelectProject: (name: string) => void;
  onNewProject: (name?: string) => void;
  onOpenProject: (path: string) => void;
  onSaveProject: (path?: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onReconnect: () => void;
  onSimulateAiEdit?: () => void;
}

type ModalAction = 'new' | 'open' | 'save' | null;

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'Live',
  connecting: 'Connecting…',
  disconnected: 'Offline',
  demo: 'Demo Mode',
};

export function TopBar({
  projectName,
  rev,
  projects,
  status,
  themePref,
  isDemo,
  pluginCount = 0,
  availablePanels = [],
  onOpenPlugins,
  onOpenPanel,
  onThemePrefChange,
  onSelectProject,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onUndo,
  onRedo,
  onAutoLayout,
  onReconnect,
  onSimulateAiEdit,
}: TopBarProps) {
  const [action, setAction] = useState<ModalAction>(null);
  const [inputVal, setInputVal] = useState('');

  const submitAction = (e: FormEvent) => {
    e.preventDefault();
    const val = inputVal.trim();
    if (action === 'new') onNewProject(val || undefined);
    else if (action === 'open' && val) onOpenProject(val);
    else if (action === 'save') onSaveProject(val || undefined);
    setAction(null);
    setInputVal('');
  };

  const startAction = (next: ModalAction, initial = '') => {
    setAction(cur => (cur === next ? null : next));
    setInputVal(initial);
  };

  return (
    <header className="topbar">
      <div className="topbar-group">
        <span className="brand">CadLLM</span>
        <div className="divider" />
        <label className="sr-only" htmlFor="project-select">Project</label>
        <select
          id="project-select"
          className="select"
          value={projectName}
          onChange={e => onSelectProject(e.target.value)}
          title="Switch active project"
        >
          {projects.length === 0 && <option value={projectName}>{projectName}</option>}
          {projects.map(p => (
            <option key={p.name} value={p.name}>
              {p.name} (rev {p.rev})
            </option>
          ))}
        </select>
        <span className="rev-pill" title="Current circuit revision">rev {rev}</span>

        <div className="btn-group">
          <button type="button" className="btn" onClick={() => startAction('new')}>New</button>
          <button type="button" className="btn" onClick={() => startAction('open')}>Open</button>
          <button type="button" className="btn" onClick={() => onSaveProject()} onContextMenu={e => { e.preventDefault(); startAction('save', `${projectName}.cnl`); }} title="Save project (right-click for Save As)">
            Save
          </button>
        </div>

        {action && (
          <form className="inline-prompt" onSubmit={submitAction}>
            <input
              autoFocus
              className="input input-sm"
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              placeholder={
                action === 'new'
                  ? 'Project name (optional)'
                  : action === 'open'
                    ? 'Path to .cnl file'
                    : 'Save path (.cnl)'
              }
            />
            <button type="submit" className="btn btn-primary">OK</button>
            <button type="button" className="btn" onClick={() => setAction(null)}>Cancel</button>
          </form>
        )}
      </div>

      <div className="topbar-group">
        <div className="btn-group">
          <button type="button" className="btn" onClick={onUndo} title="Undo (Ctrl+Z)">Undo</button>
          <button type="button" className="btn" onClick={onRedo} title="Redo (Ctrl+Y)">Redo</button>
        </div>
        <button type="button" className="btn btn-accent" onClick={onAutoLayout} title="Auto-place current view">
          Auto Layout
        </button>
        {onOpenPlugins && (
          <button type="button" className="btn" onClick={onOpenPlugins} title="Manage installed plugins and registry">
            Plugins{pluginCount > 0 ? ` (${pluginCount})` : ''}
          </button>
        )}
        {availablePanels.length > 0 && onOpenPanel && (
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => {
              const first = availablePanels[0]!;
              onOpenPanel(first.pluginId, first.panelId, first.title);
            }}
            title={`Open plugin panel: ${availablePanels[0]!.title}`}
          >
            Panel: {availablePanels[0]!.title}
          </button>
        )}
        {isDemo && onSimulateAiEdit && (
          <button type="button" className="btn" onClick={onSimulateAiEdit} title="Trigger a sample AI edit to preview live co-editing">
            Simulate AI Edit
          </button>
        )}
      </div>

      <div className="topbar-group">
        <select
          aria-label="Theme"
          className="select select-sm"
          value={themePref}
          onChange={e => onThemePrefChange(e.target.value as ThemePreference)}
          title="Color theme"
        >
          <option value="system">Theme: Auto</option>
          <option value="light">Theme: Light</option>
          <option value="dark">Theme: Dark</option>
        </select>
        <button
          type="button"
          className={`status-pill status-${status}`}
          onClick={status === 'disconnected' ? onReconnect : undefined}
          title={status === 'disconnected' ? 'Click to reconnect' : `Connection: ${STATUS_LABEL[status]}`}
        >
          <span className="status-dot" />
          {STATUS_LABEL[status]}
        </button>
      </div>
    </header>
  );
}

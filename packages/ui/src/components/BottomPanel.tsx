// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useState, type FormEvent } from 'react';
import type { ActivityEntry } from '../lib/types.ts';

interface BottomPanelProps {
  checkOutput: string;
  simOutput: string;
  simRunning: boolean;
  activity: ActivityEntry[];
  onRunSim: (run: string) => void;
  onRunCheck: () => void;
}

export function BottomPanel({
  checkOutput,
  simOutput,
  simRunning,
  activity,
  onRunSim,
  onRunCheck,
}: BottomPanelProps) {
  const [tab, setTab] = useState<'console' | 'activity'>('console');
  const [simInput, setSimInput] = useState('dc');

  const submitSim = (e: FormEvent) => {
    e.preventDefault();
    const cmd = simInput.trim();
    if (!cmd) return;
    onRunSim(cmd);
  };

  return (
    <footer className="bottom-panel">
      <div className="bottom-header">
        <div className="view-tabs">
          <button
            type="button"
            className={`view-tab ${tab === 'console' ? 'active' : ''}`}
            onClick={() => setTab('console')}
          >
            Sim &amp; Check
          </button>
          <button
            type="button"
            className={`view-tab ${tab === 'activity' ? 'active' : ''}`}
            onClick={() => setTab('activity')}
          >
            Activity ({activity.length})
          </button>
        </div>

        {tab === 'console' && (
          <form className="sim-bar" onSubmit={submitSim}>
            <input
              className="input input-sm sim-input"
              value={simInput}
              onChange={e => setSimInput(e.target.value)}
              placeholder='sim command: dc · logic in=SW1 out=Y · test'
              aria-label="Simulation command"
            />
            <button type="submit" className="btn btn-sm btn-primary" disabled={simRunning}>
              {simRunning ? 'Running…' : 'Run'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => { setSimInput('dc'); onRunSim('dc'); }}>
              dc
            </button>
            <button type="button" className="btn btn-sm" onClick={() => { setSimInput('test'); onRunSim('test'); }}>
              test
            </button>
            <button type="button" className="btn btn-sm" onClick={onRunCheck}>
              Check
            </button>
          </form>
        )}
      </div>

      {tab === 'console' ? (
        <div className="console-split">
          <div className="console-col">
            <div className="console-col-title">Check</div>
            <pre className="console-pre">{checkOutput || 'No check output yet.'}</pre>
          </div>
          <div className="console-col">
            <div className="console-col-title">Simulation</div>
            <pre className="console-pre">{simOutput || 'Enter a sim command (dc, logic …, test) and press Run.'}</pre>
          </div>
        </div>
      ) : (
        <div className="activity-list">
          {activity.length === 0 ? (
            <div className="empty-hint">No workspace activity yet.</div>
          ) : (
            activity.map(entry => (
              <div key={entry.id} className={`activity-row activity-${entry.kind ?? 'change'}`}>
                <span className="activity-time">{entry.time}</span>
                <span className={`activity-source source-${entry.source}`}>{entry.source}</span>
                {entry.rev !== undefined && <span className="activity-rev">rev {entry.rev}</span>}
                <span className="activity-text">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </footer>
  );
}

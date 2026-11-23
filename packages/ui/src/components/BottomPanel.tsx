// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useState, type FormEvent } from 'react';
import type { DrcIssue } from '@cadllm/pcb';
import type { ParsedSimTrace } from '../lib/sim.ts';
import type { ActivityEntry, ExtToolSummary } from '../lib/types.ts';

export type BottomTab = 'console' | 'drc' | 'serial' | 'activity';

interface BottomPanelProps {
  activeTab?: BottomTab;
  onTabChange?: (tab: BottomTab) => void;
  checkOutput: string;
  drcIssues: DrcIssue[];
  drcPending?: boolean;
  onFocusDrcIssue?: (issue: DrcIssue) => void;
  simOutput: string;
  simRunning: boolean;
  extTools?: ExtToolSummary[];
  activity: ActivityEntry[];
  hasMcu: boolean;
  buttonRefs: string[];
  runDuration: string;
  runPress: string;
  runProbes: string;
  defaultProbes: string[];
  trace: ParsedSimTrace | null;
  playTime: number;
  isPlaying: boolean;
  loopPlay: boolean;
  playSpeed: number;
  pressMode: boolean;
  manualPressed: Set<string>;
  onRunDurationChange: (v: string) => void;
  onRunPressChange: (v: string) => void;
  onRunProbesChange: (v: string) => void;
  onRunTransient: () => void;
  onRunSim: (run: string) => void;
  onRunCheck: () => void;
  onShowConsoleHelp?: () => void;
  onPlayToggle: () => void;
  onStopPlayback: () => void;
  onSeek: (t: number) => void;
  onLoopChange: (loop: boolean) => void;
  onSpeedChange: (speed: number) => void;
  onPressModeChange: (enabled: boolean) => void;
  onManualPress: (ref: string, down: boolean) => void;
}

export function BottomPanel({
  activeTab,
  onTabChange,
  checkOutput,
  drcIssues,
  drcPending = false,
  onFocusDrcIssue,
  simOutput,
  simRunning,
  extTools = [],
  activity,
  hasMcu,
  buttonRefs,
  runDuration,
  runPress,
  runProbes,
  defaultProbes,
  trace,
  playTime,
  isPlaying,
  loopPlay,
  playSpeed,
  pressMode,
  manualPressed,
  onRunDurationChange,
  onRunPressChange,
  onRunProbesChange,
  onRunTransient,
  onRunSim,
  onRunCheck,
  onShowConsoleHelp,
  onPlayToggle,
  onStopPlayback,
  onSeek,
  onLoopChange,
  onSpeedChange,
  onPressModeChange,
  onManualPress,
}: BottomPanelProps) {
  const [localTab, setLocalTab] = useState<BottomTab>('console');
  const tab = activeTab ?? localTab;
  const setTab = (next: BottomTab) => {
    setLocalTab(next);
    onTabChange?.(next);
  };
  const [simInput, setSimInput] = useState('dc');

  const serialEntries = trace ? Object.entries(trace.serial) : [];
  const drcErrs = drcIssues.filter(i => i.level === 'error').length;
  const drcWarns = drcIssues.length - drcErrs;

  const submitSim = (e: FormEvent) => {
    e.preventDefault();
    const cmd = simInput.trim();
    if (!cmd) return;
    onRunSim(cmd);
  };

  const togglePressSnippet = (ref: string) => {
    const tokens = runPress.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const has = tokens.some(t => t.toUpperCase().startsWith(`${ref.toUpperCase()}@`) || t.toUpperCase() === ref.toUpperCase());
    const next = has
      ? tokens.filter(t => !t.toUpperCase().startsWith(`${ref.toUpperCase()}@`) && t.toUpperCase() !== ref.toUpperCase())
      : [...tokens, `${ref}@0.5s-1.5s`];
    onRunPressChange(next.join(','));
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
            className={`view-tab ${tab === 'drc' ? 'active' : ''}`}
            onClick={() => setTab('drc')}
          >
            DRC{drcPending ? ' (pending)' : ` (${drcIssues.length})`}
          </button>
          <button
            type="button"
            className={`view-tab ${tab === 'serial' ? 'active' : ''}`}
            onClick={() => setTab('serial')}
          >
            Serial{serialEntries.length > 0 ? ` (${serialEntries.length})` : ''}
          </button>
          <button
            type="button"
            className={`view-tab ${tab === 'activity' ? 'active' : ''}`}
            onClick={() => setTab('activity')}
          >
            Activity ({activity.length})
          </button>
        </div>

        {tab === 'drc' && (
          <div className="drc-header-actions">
            <span className={`drc-summary ${drcErrs > 0 ? 'drc-has-err' : drcWarns > 0 ? 'drc-has-warn' : 'drc-clean'}`}>
              {drcPending ? 'PCB DRC pending (M3 WP2)' : `${drcErrs} err · ${drcWarns} warn`}
            </span>
            <button type="button" className="btn btn-sm" onClick={onRunCheck}>
              Re-check
            </button>
          </div>
        )}

        {tab === 'console' && (
          <div className="sim-controls-wrap">
            <form
              className="run-bar"
              onSubmit={e => {
                e.preventDefault();
                onRunTransient();
              }}
            >
              <label className="run-field">
                <span className="run-lbl">Dur</span>
                <input
                  className="input input-sm run-dur"
                  value={runDuration}
                  onChange={e => onRunDurationChange(e.target.value)}
                  placeholder="4s"
                  aria-label="Run duration"
                />
              </label>
              <label className="run-field">
                <span className="run-lbl">Press</span>
                <input
                  className="input input-sm run-press"
                  value={runPress}
                  onChange={e => onRunPressChange(e.target.value)}
                  placeholder="SW1@0.5s-1.0s"
                  aria-label="Button press schedule"
                />
              </label>
              <label className="run-field">
                <span className="run-lbl">Probes</span>
                <input
                  className="input input-sm run-probes"
                  value={runProbes}
                  onChange={e => onRunProbesChange(e.target.value)}
                  placeholder={defaultProbes.join(',') || 'D13'}
                  aria-label="Simulation probes"
                />
              </label>
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={simRunning}
                title={hasMcu ? 'Compile & run MCU mixed-signal simulation' : 'Run simulation'}
              >
                {simRunning ? 'Running…' : 'Run Sim'}
              </button>
              {buttonRefs.length > 0 && (
                <>
                  <button
                    type="button"
                    className={`btn btn-sm ${pressMode ? 'btn-accent' : ''}`}
                    onClick={() => onPressModeChange(!pressMode)}
                    title="Click buttons directly on the canvas to press them"
                  >
                    {pressMode ? 'Press Mode: On' : 'Press Mode'}
                  </button>
                  {buttonRefs.map(ref => {
                    const down = manualPressed.has(ref.toUpperCase());
                    return (
                      <button
                        key={ref}
                        type="button"
                        className={`btn btn-sm ${down ? 'btn-primary' : ''}`}
                        onPointerDown={() => onManualPress(ref, true)}
                        onPointerUp={() => onManualPress(ref, false)}
                        onPointerLeave={() => { if (down) onManualPress(ref, false); }}
                        onClick={e => { if (e.shiftKey) togglePressSnippet(ref); }}
                        title={`Hold to press ${ref} live (Shift+Click to add ${ref}@0.5s-1.5s)`}
                      >
                        {ref}
                      </button>
                    );
                  })}
                </>
              )}
            </form>

            <form className="sim-bar" onSubmit={submitSim}>
              <input
                className="input input-sm sim-input"
                value={simInput}
                onChange={e => setSimInput(e.target.value)}
                placeholder='sim command: dc · logic in=SW1 out=Y · test · ext list'
                aria-label="Simulation command"
              />
              <button type="submit" className="btn btn-sm" disabled={simRunning}>
                Eval
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
              {onShowConsoleHelp && (
                <button type="button" className="btn btn-sm" onClick={onShowConsoleHelp} title="Show simulation and ext plugin tool help">
                  Help
                </button>
              )}
            </form>
          </div>
        )}
      </div>

      {trace && tab === 'console' && (
        <div className="playback-bar">
          <button type="button" className="btn btn-sm btn-primary" onClick={onPlayToggle}>
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onStopPlayback}>
            Reset
          </button>
          <label className="playback-check">
            <input
              type="checkbox"
              checked={loopPlay}
              onChange={e => onLoopChange(e.target.checked)}
            />
            Loop
          </label>
          <select
            aria-label="Playback speed"
            className="select select-sm"
            value={String(playSpeed)}
            onChange={e => onSpeedChange(Number(e.target.value))}
          >
            <option value="0.5">0.5×</option>
            <option value="1">1×</option>
            <option value="2">2×</option>
          </select>
          <input
            type="range"
            className="playback-scrubber"
            min={0}
            max={Math.max(trace.duration, 0.001)}
            step={Math.max(trace.duration / 400, 0.001)}
            value={Math.min(playTime, Math.max(trace.duration, 0.001))}
            onChange={e => onSeek(Number(e.target.value))}
            aria-label="Simulation timeline scrubber"
          />
          <span className="playback-time">
            t = {playTime.toFixed(2)}s / {trace.duration.toFixed(2)}s
          </span>
        </div>
      )}

      {tab === 'console' ? (
        <div className="console-split">
          <div className="console-col">
            <div className="console-col-title">Check</div>
            <pre className="console-pre">{checkOutput || 'No check output yet.'}</pre>
          </div>
          <div className="console-col">
            <div className="console-col-title">Simulation</div>
            <pre className="console-pre">
              {simOutput ||
                [
                  'Use Run Sim (or dc / logic / test / help) to simulate.',
                  extTools.length > 0
                    ? `Plugin tools (ext): ${extTools.map(t => `${t.name} (${t.pluginId}@${t.version})`).join(' · ')}`
                    : 'Plugin tools (ext): none installed.',
                ].join('\n')}
            </pre>
          </div>
        </div>
      ) : tab === 'drc' ? (
        <div className="drc-list">
          {drcPending ? (
            <div className="empty-hint">
              PCB DRC checks will appear automatically once M3 WP2 (`@cadllm/pcb` `drc`) lands.
              {checkOutput ? `\n\n${checkOutput}` : ''}
            </div>
          ) : drcIssues.length === 0 ? (
            <div className="empty-hint drc-clean-msg">0 DRC issues — board is clean!</div>
          ) : (
            drcIssues.map((issue, idx) => (
              <button
                key={`${issue.code}-${idx}`}
                type="button"
                className={`drc-row drc-${issue.level}`}
                onClick={() => onFocusDrcIssue?.(issue)}
                title="Click to highlight and zoom to this issue on the PCB"
              >
                <span className={`drc-level level-${issue.level}`}>{issue.level === 'error' ? 'ERR' : 'WARN'}</span>
                <span className="drc-code">{issue.code}</span>
                <span className="drc-msg">{issue.message}</span>
                {issue.at.length > 0 && (
                  <span className="drc-at">{issue.at.join(' ')}</span>
                )}
              </button>
            ))
          )}
        </div>
      ) : tab === 'serial' ? (
        <div className="serial-pane">
          {serialEntries.length === 0 ? (
            <div className="empty-hint">No Serial output captured yet. Run an MCU sketch that uses Serial.print/println.</div>
          ) : (
            <pre className="console-pre">
              {serialEntries.map(([ref, text]) => `[${ref}]\n${text}`).join('\n\n')}
            </pre>
          )}
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

// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useEffect, useState } from 'react';
import { pinKey, type Component, type PartDef, type Query } from '@cadllm/core';
import type { ViewId } from '@cadllm/views';

interface InspectorProps {
  query: Query;
  activeView: ViewId;
  selectedRef: string | undefined;
  cnlText: string;
  cnlDirty: boolean;
  projectHeader: string;
  onCnlChange: (text: string) => void;
  onApplyCnl: () => void;
  onSyncCnl: () => void;
  onPatchProp: (ref: string, key: string, value: string) => void;
  onRotate: (ref: string) => void;
  onDelete: (ref: string) => void;
  onDisconnectPin: (netName: string, pinLabel: string) => void;
}

function ComponentInspector({
  comp,
  part,
  query,
  activeView,
  onPatchProp,
  onRotate,
  onDelete,
  onDisconnectPin,
}: {
  comp: Component;
  part: PartDef | undefined;
  query: Query;
  activeView: ViewId;
  onPatchProp: (ref: string, key: string, value: string) => void;
  onRotate: (ref: string) => void;
  onDelete: (ref: string) => void;
  onDisconnectPin: (netName: string, pinLabel: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setDrafts({});
  }, [comp.id, comp.props]);

  const propEntries = (() => {
    const keys = new Set<string>([
      ...Object.keys(part?.props ?? {}),
      ...Object.keys(comp.props),
    ]);
    return [...keys].map(k => ({
      key: k,
      def: part?.props?.[k],
      value: comp.props[k] ?? part?.props?.[k]?.default ?? '',
    }));
  })();

  const commitProp = (key: string, currentVal: string) => {
    const next = drafts[key];
    if (next === undefined || next === currentVal) return;
    onPatchProp(comp.ref, key, next);
  };

  return (
    <div className="inspector-body">
      <div className="inspector-comp-head">
        <div>
          <div className="inspector-ref">{comp.ref}</div>
          <div className="inspector-part">
            {comp.part}
            {part ? ` · ${part.name}` : ''}
          </div>
        </div>
        <div className="btn-group">
          {activeView === 'sch' && (
            <button type="button" className="btn btn-sm" onClick={() => onRotate(comp.ref)} title="Rotate 90° (R)">
              Rotate
            </button>
          )}
          <button type="button" className="btn btn-sm btn-danger" onClick={() => onDelete(comp.ref)} title="Delete component (Del)">
            Delete
          </button>
        </div>
      </div>

      <div className="place-badges">
        <span className="place-badge">@sch: {comp.place.sch ?? 'unplaced'}</span>
        <span className="place-badge">@bb: {comp.place.bb ?? 'unplaced'}</span>
      </div>

      {propEntries.length > 0 && (
        <div className="inspector-section">
          <div className="section-label">Properties</div>
          <div className="props-grid">
            {propEntries.map(({ key, def, value }) => {
              const draft = drafts[key] ?? value;
              return (
                <label key={key} className="prop-row">
                  <span className="prop-key" title={def?.description}>
                    {key}
                    {def?.unit ? ` (${def.unit})` : ''}
                  </span>
                  {def?.type === 'enum' && def.options ? (
                    <select
                      className="select select-sm"
                      value={value}
                      onChange={e => onPatchProp(comp.ref, key, e.target.value)}
                    >
                      {def.options.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : def?.type === 'bool' ? (
                    <select
                      className="select select-sm"
                      value={value}
                      onChange={e => onPatchProp(comp.ref, key, e.target.value)}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="input input-sm"
                      value={draft}
                      onChange={e => setDrafts(prev => ({ ...prev, [key]: e.target.value }))}
                      onBlur={() => commitProp(key, value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                          commitProp(key, value);
                        }
                      }}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {part && part.pins.length > 0 && (
        <div className="inspector-section">
          <div className="section-label">Pins ({part.pins.length})</div>
          <div className="pin-list">
            {part.pins.map(pin => {
              const pk = pinKey(comp.id, pin.id);
              const net = query.netOfPin(pk);
              const label = query.pinLabel(pk);
              return (
                <div key={pin.id} className="pin-row">
                  <span className="pin-name">{pin.id === pin.name ? pin.name : `${pin.id}:${pin.name}`}</span>
                  {net ? (
                    <span className="pin-net">
                      <span>{net.name}</span>
                      <button
                        type="button"
                        className="pin-disconnect"
                        title={`Disconnect ${label} from ${net.name}`}
                        onClick={() => onDisconnectPin(net.name, label)}
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <span className="pin-unconnected">nc</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function Inspector({
  query,
  activeView,
  selectedRef,
  cnlText,
  cnlDirty,
  projectHeader,
  onCnlChange,
  onApplyCnl,
  onSyncCnl,
  onPatchProp,
  onRotate,
  onDelete,
  onDisconnectPin,
}: InspectorProps) {
  const comp = selectedRef ? query.component(selectedRef) : undefined;
  const part = comp ? query.parts.get(comp.part) : undefined;

  return (
    <aside className="panel panel-right">
      <section className="inspector-pane">
        <div className="panel-header">
          <span className="panel-title">Inspector</span>
          {comp && <span className="muted-tag">{comp.ref}</span>}
        </div>
        {comp ? (
          <ComponentInspector
            comp={comp}
            part={part}
            query={query}
            activeView={activeView}
            onPatchProp={onPatchProp}
            onRotate={onRotate}
            onDelete={onDelete}
            onDisconnectPin={onDisconnectPin}
          />
        ) : (
          <div className="empty-hint">
            Click a component on the canvas to inspect properties and pins.
          </div>
        )}
      </section>

      <section className="cnl-pane">
        <div className="panel-header">
          <span className="panel-title">CNL</span>
          <span className="muted-tag">{projectHeader}</span>
          <div className="btn-group">
            {cnlDirty && (
              <button type="button" className="btn btn-sm" onClick={onSyncCnl} title="Reload circuit text">
                Sync
              </button>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={onApplyCnl} title="Apply CNL edit (Ctrl+Enter)">
              Apply
            </button>
          </div>
        </div>
        <textarea
          className="cnl-editor"
          spellCheck={false}
          value={cnlText}
          onChange={e => onCnlChange(e.target.value)}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              onApplyCnl();
            }
          }}
          placeholder={'# Add/edit parts & nets:\nR1 res 330 @sch:10,6\n~R1 resistance=470\nVCC: BAT1.+ R1.1'}
          aria-label="CNL text editor"
        />
      </section>
    </aside>
  );
}

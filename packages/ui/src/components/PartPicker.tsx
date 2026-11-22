// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { FindHit } from '../lib/parts.ts';

interface PartPickerProps {
  query: string;
  hits: FindHit[];
  loading: boolean;
  emptyMessage?: string;
  onQueryChange: (q: string) => void;
  onAddPart: (hit: FindHit) => void;
}

export function PartPicker({
  query,
  hits,
  loading,
  emptyMessage,
  onQueryChange,
  onAddPart,
}: PartPickerProps) {
  return (
    <aside className="panel panel-left">
      <div className="panel-header">
        <span className="panel-title">Parts</span>
        {loading && <span className="muted-tag">…</span>}
      </div>
      <div className="search-box">
        <input
          type="search"
          className="input"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          placeholder="Find parts (res, led, 74hc…)"
          aria-label="Search parts"
        />
      </div>
      <div className="part-list">
        {hits.length === 0 ? (
          <div className="empty-hint">{emptyMessage ?? 'No matching parts'}</div>
        ) : (
          hits.map(hit => (
            <button
              key={hit.id}
              type="button"
              className="part-item"
              onClick={() => onAddPart(hit)}
              title={`Click to add ${hit.id} to circuit`}
            >
              <div className="part-item-top">
                <span className="part-id">{hit.id}</span>
                <span className="part-pins">{hit.pins}</span>
              </div>
              <div className="part-summary">{hit.summary}</div>
              {hit.sim && <div className="part-sim">{hit.sim}</div>}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

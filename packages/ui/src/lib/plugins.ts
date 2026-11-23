// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { ExtToolSummary, PluginStatusItem, RegistryPluginItem, RegistryVersionItem } from './types.ts';

export interface PermissionDescription {
  permission: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
}

/** Translate a CadLLM plugin permission token into plain human words for UI review dialogs. */
export function describePermission(perm: string): PermissionDescription {
  const trimmed = perm.trim();
  if (trimmed === 'project:read') {
    return {
      permission: trimmed,
      title: 'Read your circuits',
      detail: 'Allows the plugin to inspect components, nets, and placements in the active project.',
      risk: 'low',
    };
  }
  if (trimmed === 'project:write') {
    return {
      permission: trimmed,
      title: 'Change your circuits',
      detail: 'Allows the plugin to propose or apply edits to your components, wiring, and layouts.',
      risk: 'medium',
    };
  }
  if (trimmed.startsWith('net:')) {
    const host = trimmed.slice(4).trim() || '(unknown host)';
    return {
      permission: trimmed,
      title: `Connect to ${host}`,
      detail: `Allows the plugin process to open network connections to ${host}.`,
      risk: 'medium',
    };
  }
  if (trimmed.startsWith('fs:read:')) {
    const target = trimmed.slice(8).trim() || '(path)';
    return {
      permission: trimmed,
      title: `Read files in ${target}`,
      detail: `Allows the plugin to read files from ${target} on your machine.`,
      risk: 'medium',
    };
  }
  if (trimmed.startsWith('fs:write:')) {
    const target = trimmed.slice(9).trim() || '(path)';
    return {
      permission: trimmed,
      title: `Write files in ${target}`,
      detail: `Allows the plugin to create or modify files in ${target} on your machine.`,
      risk: 'high',
    };
  }
  return {
    permission: trimmed,
    title: `Custom permission (${trimmed})`,
    detail: `Grants the "${trimmed}" capability to this plugin.`,
    risk: 'high',
  };
}

/** Build initial permission checkbox state for install review: every requested permission starts unchecked. */
export function createInitialGrantSelection(requestedPermissions: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const perm of requestedPermissions) {
    out[perm] = false;
  }
  return out;
}

/** Return the newest version entry in a registry plugin item. */
export function latestRegistryVersion(entry: RegistryPluginItem): RegistryVersionItem | undefined {
  return entry.versions[entry.versions.length - 1];
}

/** Filter registry index entries by search query against id, name, summary, or publisher. */
export function filterRegistryPlugins(
  entries: readonly RegistryPluginItem[],
  query: string,
): RegistryPluginItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter(e =>
    e.id.toLowerCase().includes(q) ||
    e.name.toLowerCase().includes(q) ||
    e.summary.toLowerCase().includes(q) ||
    e.publisher.toLowerCase().includes(q),
  );
}

/** Parse `ext op=list` output lines (`<name>  <summary>  (<pluginId>@<version>)`). */
export function parseExtListOutput(text: string): ExtToolSummary[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'no plugin tools installed') return [];
  const tools: ExtToolSummary[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s{2,}(.+?)\s{2,}\(([^@)\s]+)@([^)\s]+)\)$/);
    if (m) {
      tools.push({
        name: m[1]!,
        summary: m[2]!.trim(),
        pluginId: m[3]!,
        version: m[4]!,
      });
    }
  }
  return tools;
}

/** Collect all panels contributed by currently loaded plugins. */
export function listAvailablePanels(
  plugins: readonly PluginStatusItem[],
): { pluginId: string; pluginName: string; panelId: string; title: string }[] {
  const out: { pluginId: string; pluginName: string; panelId: string; title: string }[] = [];
  for (const plugin of plugins) {
    if (plugin.state !== 'loaded') continue;
    for (const panel of plugin.contributes.panels ?? []) {
      out.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        panelId: panel.id,
        title: panel.title,
      });
    }
  }
  return out;
}

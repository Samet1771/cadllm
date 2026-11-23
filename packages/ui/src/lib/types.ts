// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { ChangeSource, Circuit, Delta, PartDef } from '@cadllm/core';

export interface ProjectSummary {
  name: string;
  rev: number;
  source?: string;
}

export interface StateResponse {
  project: string;
  rev: number;
  projects: ProjectSummary[];
  circuit: Circuit;
  parts: Record<string, PartDef>;
}

export interface ChangedNotification {
  project: string;
  rev: number;
  source: ChangeSource;
  label?: string;
  delta: Delta;
  summary: string;
}

export interface ProjectsNotification {
  names: string[];
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'demo';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface ActivityEntry {
  id: number;
  time: string;
  rev?: number;
  source: ChangeSource | 'ui';
  text: string;
  kind?: 'change' | 'info' | 'error';
}

export interface ToastMessage {
  id: number;
  text: string;
  source: ChangeSource | 'ui';
}

export type ContributionKind = 'parts' | 'models' | 'tools' | 'checks' | 'panels';

export interface PluginPanelContribution {
  id: string;
  title: string;
  main: string;
}

export interface PluginToolContribution {
  name: string;
  summary: string;
}

export interface PluginCheckContribution {
  id: string;
  summary?: string;
}

export interface PluginContributes {
  parts?: string;
  models?: { id: string; kind: string; file?: string; main?: string }[];
  tools?: PluginToolContribution[];
  checks?: PluginCheckContribution[];
  panels?: PluginPanelContribution[];
}

export interface PluginStatusItem {
  id: string;
  name: string;
  version: string;
  summary?: string;
  publisher?: string;
  license: string;
  state: 'loaded' | 'failed';
  error?: string;
  requestedPermissions: string[];
  grantedPermissions: string[];
  contributions: ContributionKind[];
  contributes: PluginContributes;
}

export interface RegistryVersionItem {
  version: string;
  engine: string;
  url: string;
  sha256: string;
  size: number;
  permissions: string[];
  contributes: ContributionKind[];
  signature: string;
}

export interface RegistryPluginItem {
  id: string;
  name: string;
  summary: string;
  publisher: string;
  license?: string;
  versions: RegistryVersionItem[];
}

export interface PluginPanelPayload {
  id: string;
  panel: string;
  title: string;
  html: string;
}

export interface ExtToolSummary {
  name: string;
  summary: string;
  pluginId: string;
  version: string;
}

/** Minimal RPC surface shared by the WebSocket client and the ?demo adapter. */
export interface RpcApi {
  call<T = string>(method: string, params?: Record<string, unknown>): Promise<T>;
  state(): Promise<StateResponse>;
  library(): Promise<PartDef[]>;
}

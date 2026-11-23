// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuActionHandlers {
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
  onQuit(): void;
  onMcpInfo(): void;
  onAbout(): void;
}

export interface MenuTemplateOptions {
  isMac?: boolean;
}

/** Build the Electron application menu template with File > New/Open/Save/Save As/Quit. */
export function buildMenuTemplate(
  actions: MenuActionHandlers,
  opts: MenuTemplateOptions = {},
): MenuItemConstructorOptions[] {
  const isMac = opts.isMac ?? false;

  const fileMenu: MenuItemConstructorOptions = {
    label: '&File',
    submenu: [
      {
        label: 'New Circuit',
        accelerator: 'CmdOrCtrl+N',
        click: () => actions.onNew(),
      },
      {
        label: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        click: () => actions.onOpen(),
      },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        click: () => actions.onSave(),
      },
      {
        label: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => actions.onSaveAs(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        accelerator: isMac ? 'Cmd+Q' : 'Alt+F4',
        click: () => actions.onQuit(),
      },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: '&Edit',
    submenu: [
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: '&View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: '&Help',
    submenu: [
      {
        label: 'MCP Server Status…',
        click: () => actions.onMcpInfo(),
      },
      { type: 'separator' },
      {
        label: 'About CadLLM',
        click: () => actions.onAbout(),
      },
    ],
  };

  return [fileMenu, editMenu, viewMenu, helpMenu];
}

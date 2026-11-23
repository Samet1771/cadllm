// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('cadllmDesktop', Object.freeze({
  isDesktop: true,
}));

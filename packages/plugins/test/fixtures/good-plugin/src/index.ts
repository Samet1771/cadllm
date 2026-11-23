// SPDX-License-Identifier: MIT
import { connect, definePlugin } from '@cadllm/plugin-api';

definePlugin({
  activate(cadllm) {
    cadllm.log('info', 'good-plugin activated');
  },
  tools: {
    async summarize_circuit(_args, cadllm) {
      const cnl = await cadllm.project.read({ detail: 0 });
      return `summary:${cnl}`;
    },
    async add_test_res(args, cadllm) {
      const val = typeof args.resistance === 'string' ? args.resistance : '4k7';
      return cadllm.project.edit(`R99 res ${val}`);
    },
    async ping_local(args) {
      const url = String(args.url ?? '');
      const res = await fetch(url);
      return await res.text();
    },
    async lookup_part(args, cadllm) {
      const id = String(args.id ?? '');
      const part = await cadllm.parts.get(id);
      return part ? `${part.id}:${part.name}` : 'missing';
    },
  },
  checks: {
    async no_bare_led(cadllm) {
      const cnl = await cadllm.project.read({ detail: 1 });
      const hasLed = /\bled\b/.test(cnl);
      const hasRes = /\bres\b/.test(cnl);
      if (hasLed && !hasRes) {
        return [{ level: 'warn', message: 'LED has no series resistor', at: ['D1'] }];
      }
      return [];
    },
  },
});

connect();

// SPDX-License-Identifier: MIT
import { connect, definePlugin } from '@cadllm/plugin-api';

definePlugin({
  tools: {
    summarize_circuit() {
      return 'collider:ok';
    },
  },
});

connect();

import { systemInfo } from '../system.js';

export function registerSystemTools(register) {
  register({
    name: 'system_info',
    title: 'Inspect the Termux/Android environment',
    description:
      'Return device model, Android version, Termux paths, CPU/memory/load, storage usage, network interfaces and availability of common tools (node, python, git, tmux, Termux:API).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {},
    handler: async () => JSON.stringify(await systemInfo(), null, 2),
  });
}

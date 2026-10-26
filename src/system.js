import fsp from 'node:fs/promises';
import os from 'node:os';

import { commandExists, runProcess } from './exec.js';

async function getProp(name) {
  if (!commandExists('getprop')) return null;
  const result = await runProcess('getprop', [name], {
    timeoutMs: 3000,
    maxBytes: 4096,
  });
  if (!result.ok) return null;
  const value = result.stdout.trim();
  return value || null;
}

async function diskInfo(target) {
  try {
    const stat = await fsp.statfs(target, { bigint: true });
    const bsize = Number(stat.bsize);
    const total = Number(stat.blocks) * bsize;
    const free = Number(stat.bfree) * bsize;
    const available = Number(stat.bavail) * bsize;
    return {
      path: target,
      totalBytes: total,
      freeBytes: free,
      availableBytes: available,
      usedPercent: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : null,
    };
  } catch (error) {
    return { path: target, error: error.message };
  }
}

export async function systemInfo() {
  const [
    model,
    brand,
    manufacturer,
    device,
    androidRelease,
    sdk,
    abi,
    fingerprint,
    kernel,
  ] = await Promise.all([
    getProp('ro.product.model'),
    getProp('ro.product.brand'),
    getProp('ro.product.manufacturer'),
    getProp('ro.product.device'),
    getProp('ro.build.version.release'),
    getProp('ro.build.version.sdk'),
    getProp('ro.product.cpu.abi'),
    getProp('ro.build.fingerprint'),
    getProp('ro.kernel.version'),
  ]);

  const home = os.homedir();
  const [diskHome, diskStorage] = await Promise.all([
    diskInfo(home),
    fsp.access('/storage/emulated/0').then(() => diskInfo('/storage/emulated/0')).catch(() => null),
  ]);

  const interfaces = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      interfaces.push({
        name,
        address: address.address,
        family: address.family,
        internal: address.internal,
        mac: address.mac,
        cidr: address.cidr,
      });
    }
  }

  const toolNames = [
    'bash',
    'node',
    'npm',
    'python',
    'git',
    'curl',
    'rg',
    'pkg',
    'tmux',
    'script',
    'termux-clipboard-get',
    'termux-battery-status',
    'termux-notification',
    'termux-wake-lock',
  ];

  return {
    generatedAt: new Date().toISOString(),
    server: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
    },
    device: {
      model,
      brand,
      manufacturer,
      device,
      androidRelease,
      sdk,
      abi,
      fingerprint,
      kernel,
    },
    termux: {
      home,
      prefix: process.env.PREFIX || null,
      tmpdir: os.tmpdir(),
      shell: process.env.SHELL || null,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      isTermux: Boolean(process.env.PREFIX && process.env.PREFIX.includes('com.termux')),
    },
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || null,
      loadAvg: os.loadavg(),
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      uptimeSec: Math.round(os.uptime()),
    },
    storage: {
      home: diskHome,
      shared: diskStorage,
    },
    network: interfaces,
    tools: Object.fromEntries(toolNames.map((name) => [name, commandExists(name)])),
  };
}

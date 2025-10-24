#!/usr/bin/env node
import { spawn } from 'node:child_process';

const processes = [
  { name: 'web-preview', command: 'npm', args: ['run', '-w', 'apps/web', 'preview'] },
  { name: 'worker-dev', command: 'wrangler', args: ['dev'] },
];

const running = new Set();
let shuttingDown = false;

function startProcess(spec) {
  const child = spawn(spec.command, spec.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  running.add(child);
  child.on('exit', (code, signal) => {
    running.delete(child);
    if (!shuttingDown) {
      console.log(`\n${spec.name} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}. Shutting down remaining processes.`);
      shutdown();
      if (code) {
        process.exitCode = code;
      }
    } else if (!running.size) {
      process.exit(0);
    }
  });
  child.on('error', (error) => {
    console.error(`${spec.name} failed to start:`, error);
    shutdown();
    process.exit(1);
  });
  return child;
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of running) {
    if (child.exitCode == null && child.signalCode == null) {
      if (process.platform === 'win32') {
        child.kill();
      } else {
        child.kill('SIGINT');
        setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) {
            child.kill('SIGTERM');
          }
        }, 1000);
      }
    }
  }
}

process.on('SIGINT', () => {
  shutdown();
});

process.on('SIGTERM', () => {
  shutdown();
});

for (const spec of processes) {
  startProcess(spec);
}

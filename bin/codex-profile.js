#!/usr/bin/env node
import { configureCodexTerminal } from '../src/server/codex-terminal.mjs';
import { isAbsolute } from 'node:path';

const [action, ...args] = process.argv.slice(2);
try {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--shell': 'shell', '--store': 'store', '--rc': 'rc' }[args[i]];
    if (!key || !args[i + 1] || Object.hasOwn(options, key)) throw new Error('Use: codex-profile.js install|uninstall --shell zsh|bash|powershell|powershell5 [--store directory] [--rc shell-profile]');
    options[key] = args[i + 1];
  }
  if (!options.shell || (options.store && !isAbsolute(options.store)) || (options.rc && !isAbsolute(options.rc))) throw new Error('Shell is required; store and profile paths must be absolute.');
  const result = await configureCodexTerminal(action, options);
  console.log(result.action === 'install'
    ? 'Codex account selection enabled. Open a new terminal to use it. An explicit CODEX_HOME takes priority.'
    : 'Codex account selection removed. Open a new terminal to use the original command.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
import { configureCodexTerminal } from '../src/server/codex-terminal.mjs';

const [action, flag, shell] = process.argv.slice(2);
try {
  if (flag !== '--shell' || !shell || process.argv.length !== 5) throw new Error('Use: codex-profile.js install|uninstall --shell zsh|bash|powershell|powershell5');
  const result = await configureCodexTerminal(action, { shell });
  console.log(result.action === 'install'
    ? 'Codex account selection enabled. Open a new terminal to use it. An explicit CODEX_HOME takes priority.'
    : 'Codex account selection removed. Open a new terminal to use the original command.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

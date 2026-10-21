// Classify shell operations without evaluating shell syntax or retaining arguments.
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_./:+-]{1,100}$/.test(value) ? value : null;
const basename = value => value.split(/[\\/]/).at(-1).replace(/\.exe$/i, '');
const takesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);

function shellWords(command) {
  const segments = [[]]; let token = '', quote = '', escaped = false;
  const word = () => { if (token) segments.at(-1).push(token); token = ''; };
  for (const ch of command.slice(0, 32768)) {
    if (escaped) { token += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; else token += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (ch === '\n') { word(); segments.push([]); } else word(); }
    else if (';&|'.includes(ch)) { word(); if (segments.at(-1).length) segments.push([]); }
    else token += ch;
  }
  word();
  return { segments: segments.filter(s => s.length), uncertain: !!quote || escaped || /\$\(|`|<<|\b(?:if|for|while|case|function)\b/.test(command) };
}
function operation(words, depth = 0) {
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++;
  if (words[i] === 'env') { i++; while (words[i]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++; }
  if (words[i] === 'sudo') { i++; if (words[i] === '-u') i += 2; }
  if (words[i] === 'timeout') { i++; while (words[i]?.startsWith('-')) i++; i++; }
  const exe = safe(words[i]); if (!exe) return 'shell (unclassified)';
  const program = basename(exe); const args = words.slice(i + 1);
  if (['sh', 'bash', 'zsh', 'pwsh', 'powershell'].includes(program) && depth < 2) {
    const at = args.findIndex(a => /^-(?:[a-z]*c|Command)$/i.test(a));
    if (at >= 0 && args[at + 1]) return shellOperations(args[at + 1], depth + 1);
  }
  if (program === 'git') {
    let j = 0;
    while (args[j]?.startsWith('-')) { const a = args[j++]; if (takesValue.has(a)) j++; }
    const sub = safe(args[j]); return sub && /^[a-z][a-z-]*$/.test(sub) ? `git ${sub}` : 'git';
  }
  if (['npm', 'pnpm', 'yarn', 'bun', 'dotnet', 'cargo', 'docker', 'kubectl', 'gh', 'uv'].includes(program)) {
    const sub = args.find(a => !a.startsWith('-'));
    if (!safe(sub) || !/^[a-z][a-z-]*$/.test(sub)) return program;
    const at = args.indexOf(sub);
    if (['run', 'run-script'].includes(sub) && safe(args[at + 1])) return `${program} run ${args[at + 1]}`;
    if (program === 'docker' && ['compose', 'container', 'image'].includes(sub) && /^[a-z][a-z-]*$/.test(args[at + 1] ?? '')) return `${program} ${sub} ${args[at + 1]}`;
    return `${program} ${sub}`;
  }
  return safe(program) ?? 'shell (unclassified)';
}
export function shellOperations(command, depth = 0) {
  const { segments, uncertain } = shellWords(command);
  if (uncertain || !segments.length || segments.length > 32) return ['shell (unclassified)'];
  return [...new Set(segments.flatMap(words => operation(words, depth)))].slice(0, 16);
}
export function auditOperations(name, input) {
  const tool = safe(name) ?? 'tool (unclassified)';
  if (['exec', 'functions.exec'].includes(name) && typeof input?.script === 'string') return { tool, operations: scriptOperations(input.script), shell: true, wrapped: true };
  if (/^(?:Bash|Shell|exec_command|run|shell_command|functions\.exec_command|mcp__.*__exec_command)$/i.test(name ?? '')) {
    const command = input?.command ?? input?.cmd;
    if (typeof command === 'string' && command.length <= 32768) return { tool, operations: shellOperations(command), shell: true };
    return { tool, operations: ['shell (unclassified)'], shell: true };
  }
  return { tool, operations: [tool], shell: false };
}

// Tokenize the wrapper without running it. Strings/comments cannot masquerade
// as tools calls; only literal cmd values are classified as shell operations.
export function scriptOperations(script) {
  if (typeof script !== 'string' || script.length > 32768) return ['exec (unclassified)'];
  const tokens = []; let i = 0;
  while (i < script.length) {
    const c = script[i];
    if (/\s/.test(c)) { i++; continue; }
    if (script.slice(i, i + 2) === '//') { i = script.indexOf('\n', i); if (i < 0) break; continue; }
    if (script.slice(i, i + 2) === '/*') { const end = script.indexOf('*/', i + 2); if (end < 0) break; i = end + 2; continue; }
    if (['"', "'", '`'].includes(c)) {
      const quote = c; i++; let value = '', valid = true, closed = false;
      while (i < script.length) {
        const ch = script[i++];
        if (ch === quote) { closed = true; break; }
        if (quote === '`' && ch === '$' && script[i] === '{') valid = false;
        if (ch !== '\\') { value += ch; continue; }
        const escaped = script[i++];
        if (escaped === undefined) { valid = false; break; }
        const simple = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'", '`': '`' };
        if (Object.hasOwn(simple, escaped)) value += simple[escaped];
        else if (escaped === '\n') continue;
        else valid = false;
      }
      tokens.push({ kind: 'string', value: valid && closed ? value : null }); continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(script.slice(i));
    if (id) { tokens.push({ kind: 'id', value: id[0] }); i += id[0].length; }
    else { tokens.push({ kind: 'punct', value: c }); i++; }
  }
  const operations = [];
  for (let j = 0; j < tokens.length - 4; j++) {
    if (tokens[j].kind !== 'id' || tokens[j].value !== 'tools' || tokens[j + 1].value !== '.' || tokens[j + 2].kind !== 'id' || tokens[j + 3].value !== '(') continue;
    const method = tokens[j + 2].value;
    if (method !== 'exec_command') { operations.push(safe(method) ?? 'tool (unclassified)'); continue; }
    let cmd = null, depth = 0;
    if (tokens[j + 4].value === '{') {
      for (let k = j + 4; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.kind === 'punct' && t.value === '{') depth++;
        if (t.kind === 'punct' && t.value === '}' && --depth <= 0) break;
        if (depth === 1 && t.value === 'cmd' && ['id', 'string'].includes(t.kind) && tokens[k + 1]?.value === ':' && tokens[k + 2]?.kind === 'string'
            && [',', '}'].includes(tokens[k + 3]?.value)) { cmd = tokens[k + 2].value; break; }
      }
    }
    operations.push(...(cmd === null ? ['shell (unclassified)'] : shellOperations(cmd)));
  }
  return operations.length ? [...new Set(operations)].slice(0, 16) : ['exec (unclassified)'];
}

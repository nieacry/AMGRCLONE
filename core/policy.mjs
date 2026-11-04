export const MODES = ['online', 'local'];

export function validateRemotePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\r\n\0]/.test(value) || value.startsWith('/') || value.split('/').some(p => p === '.' || p === '..' || p === '')) {
    if (value === '') return value;
    throw new Error('err.path');
  }
  return value;
}

export function contains(parent, child) { return parent === '' || parent === child || child.startsWith(parent + '/'); }

export function mappingError(remotePath,reason,otherPath='') {
  return Object.assign(new Error('err.mapping'),{nativePath:remotePath,nativeStage:reason,nativeOtherPath:otherPath});
}

export function validateLocalMapping(remotePath, platform) {
  validateRemotePath(remotePath);
  if (platform === 'win32') for(const component of remotePath.split('/')) {
    if(/[<>:"|?*\x01-\x1f]/.test(component))throw mappingError(remotePath,'err.mappingCharacters');
    if(component.length>255)throw mappingError(remotePath,'err.mappingLength');
    if(/[. ]$/.test(component))throw mappingError(remotePath,'err.mappingEnding');
    if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component))throw mappingError(remotePath,'err.mappingReserved');
  }
  return remotePath;
}

export function effectivePolicy(path, rules) {
  let result = { selected: false, mode: 'online' };
  const parents = Object.keys(rules).filter(p => contains(p, path)).sort((a, b) => a.length - b.length);
  for (const parent of parents) result = { ...result, ...rules[parent] };
  return result;
}

export function validateSettings(input) {
  if (!input || typeof input.localRoot !== 'string' || input.localRoot.length > 4096 || !input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules)) throw new Error('err.settings');
  if (Object.keys(input.rules).length > 10000) throw new Error('err.rules');
  const rules = Object.create(null);
  for (const [path, rule] of Object.entries(input.rules)) {
    validateRemotePath(path);
    if (!rule || !['file', 'folder'].includes(rule.kind) || typeof rule.selected !== 'boolean' || !MODES.includes(rule.mode)) throw new Error('err.rules');
    rules[path] = { selected: rule.selected, mode: rule.mode, kind: rule.kind };
    if (typeof rule.itemId === 'string' && rule.itemId.length < 512) rules[path].itemId = rule.itemId;
  }
  return { localRoot: input.localRoot, rules };
}

// Fail closed: bisync must never traverse a branch containing online-only overrides.
export function makePlan(settings) {
  const { rules, localRoot } = validateSettings(settings);
  const jobs = [], deferred = [];
  const candidates = Object.keys(rules).filter(p => rules[p].selected).sort((a,b) => a.length - b.length);
  for (const path of candidates) {
    const policy = effectivePolicy(path, rules);
    if (jobs.some(j => contains(j.path, path))) continue;
    if (!path || path.split('/').some(p => p.toLowerCase() === '.amg-backups' || p.startsWith('.amg-access-'))) { deferred.push({path, reason:'deferred_reserved'}); continue; }
    if (policy.mode === 'online') { deferred.push({ path, reason: 'deferred_online' }); continue; }
    if (rules[path].kind === 'file') { deferred.push({ path, reason: 'deferred_file' }); continue; }
    const exception = Object.keys(rules).find(p => p !== path && contains(path, p) && (!rules[p].selected || rules[p].mode === 'online'));
    if (exception !== undefined) { deferred.push({ path, reason: 'deferred_exception' }); continue; }
    jobs.push({ path, localRoot, initialization: true });
  }
  return { jobs, deferred };
}

export function bisyncArgs(remotePath, localPath, workdir) {
  return ['bisync', remotePath, localPath, '--dry-run', '--resync', '--resync-mode', 'path1', '--workdir', workdir,
    '--conflict-resolve', 'none', '--max-delete', '10', '--verbose'];
}

export function parseAuthorization(output) {
  // rclone emits explanatory text around a single-line JSON token.
  for (const line of output.split(/\r?\n/)) {
    try {
      const data = JSON.parse(line.trim());
      if (typeof data.access_token === 'string' && typeof data.refresh_token === 'string' && data.access_token && data.refresh_token) return JSON.stringify(data);
    } catch { /* Not a token line. */ }
  }
  throw new Error('err.oauth');
}

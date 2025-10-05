window.DEBUG_IMAGES = window.DEBUG_IMAGES ?? false;

(function setupImageDebugging() {
  if (window.__IMAGE_DEBUG_PATCHED__) return;
  window.__IMAGE_DEBUG_PATCHED__ = true;

  const logPrefixes = [
    '📦',
    '✅',
    '🖼️',
    '🔄',
    '🌐',
    '📡',
    '🔗',
    '🧹',
    '🔌',
    '🔍',
    '👀',
    '🔭',
    '👁️',
    '🎯'
  ];
  const warnPrefixes = ['⚠️', '❌'];

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);

  const shouldSuppress = (prefixes, args) => {
    if (window.DEBUG_IMAGES) return false;
    const [first] = args;
    return typeof first === 'string' && prefixes.some(prefix => first.startsWith(prefix));
  };

  console.log = (...args) => {
    if (shouldSuppress(logPrefixes, args)) return;
    originalLog(...args);
  };

  console.warn = (...args) => {
    if (shouldSuppress(warnPrefixes, args)) return;
    originalWarn(...args);
  };
})();

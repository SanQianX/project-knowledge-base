const CHANNEL = 'project-knowledge:open-external';

function registerExternalLink({ ipcMain, shell, isAllowedUrl }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain.handle is required');
  }
  if (!shell || typeof shell.openExternal !== 'function') {
    throw new Error('shell.openExternal is required');
  }
  if (typeof isAllowedUrl !== 'function') {
    throw new Error('isAllowedUrl is required');
  }

  ipcMain.handle(CHANNEL, async (_event, requestedUrl) => {
    const url = String(requestedUrl || '').trim();
    if (!isAllowedUrl(url)) {
      return { ok: false, code: 'url_not_allowed', error: 'Only HTTP and HTTPS links can be opened.' };
    }
    try {
      await shell.openExternal(url, { activate: true });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: 'open_external_failed',
        error: error && error.message || 'The system browser could not be opened.',
      };
    }
  });

  return () => ipcMain.removeHandler(CHANNEL);
}

module.exports = { CHANNEL, registerExternalLink };

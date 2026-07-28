import { app, BrowserWindow, protocol, net, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { registerIpc } from './main/ipc/register-ipc';
import { resolveLocalFileProtocolPath } from './main/files/local-file-protocol';

if (process.platform === 'darwin' && process.arch === 'arm64') {
  // Anchor Sharp's libvips runtime so Electron Forge's webpack asset relocation
  // packages the dylib next to Sharp's native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@img/sharp-libvips-darwin-arm64/lib');
}

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (squirrelStartup) {
  app.quit();
}

app.setName('Image Puma');

let mainWindow: BrowserWindow | null = null;

const requestedDevRestartExitCode = Number(process.env.IMAGE_PUMA_DEV_RESTART_CODE || 250);
const devRestartExitCode = Number.isInteger(requestedDevRestartExitCode)
  ? requestedDevRestartExitCode
  : 250;
const devRestartFile = process.env.IMAGE_PUMA_DEV_RESTART_FILE;
const isDevWatchMode = process.env.IMAGE_PUMA_DEV_WATCH === '1';

function requestDevRestart() {
  if (devRestartFile) {
    writeFileSync(devRestartFile, String(Date.now()));
  }
  app.exit(devRestartExitCode);
}

function installApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
        label: app.name,
        submenu: [
          { role: 'about' as const },
          { type: 'separator' as const },
          {
            label: 'Quit Image Puma',
            accelerator: 'Command+Q',
            click: () => app.quit(),
          },
        ],
      }]
      : []),
    {
      label: 'File',
      submenu: [
        isMac
          ? { role: 'close' as const }
          : {
            label: 'Quit',
            accelerator: 'Ctrl+Q',
            click: () => app.quit(),
          },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        { type: 'separator' as const },
        { role: 'front' as const },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installWindowShortcuts(window: BrowserWindow) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.alt) return;

    const key = input.key.toLowerCase();
    const commandOrControl = process.platform === 'darwin'
      ? input.meta && !input.control
      : input.control && !input.meta;

    if (commandOrControl && key === 'q') {
      event.preventDefault();
      app.quit();
      return;
    }

    if (!isDevWatchMode) return;
    if (!(input.meta || input.control)) return;
    if (key !== 'r') return;

    event.preventDefault();
    requestDevRestart();
  });
}

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0e0e10',
    show: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  installWindowShortcuts(mainWindow);

  let hasShown = false;
  const showMainWindow = () => {
    if (!mainWindow || hasShown) return;
    hasShown = true;
    mainWindow.show();
  };

  mainWindow.once('ready-to-show', showMainWindow);
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  setTimeout(showMainWindow, 3000);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

registerIpc(() => mainWindow);

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  installApplicationMenu();
  protocol.handle('local-file', (request) => {
    const filePath = resolveLocalFileProtocolPath(request.url);
    return net.fetch(pathToFileURL(filePath).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

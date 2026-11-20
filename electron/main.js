const { app, BrowserWindow } = require('electron');
const path = require('path');
// পুরনো GPU-তেও যেন GPU দিয়েই চলে (সফটওয়্যার রেন্ডারিং ধীর)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
function create() {
  const win = new BrowserWindow({ width: 1280, height: 720, fullscreen: true, show: false, autoHideMenuBar: true, backgroundColor: '#16301f', webPreferences: { backgroundThrottling: false } });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (i.key === 'Escape' && win.isFullScreen()) { win.setFullScreen(false); }
  });
  win.loadFile(path.join(__dirname, '../dist/index.html'));
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());

const { app, BrowserWindow } = require('electron');
const path = require('path');
function create() {
  const win = new BrowserWindow({ width: 1280, height: 720, autoHideMenuBar: true, backgroundColor: '#16301f' });
  win.loadFile(path.join(__dirname, '../dist/index.html'));
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());

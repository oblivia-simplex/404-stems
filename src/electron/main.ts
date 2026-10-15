// Desktop app: runs the stem exporter's server in-process and shows its UI in a window.
import { app, BrowserWindow, dialog, shell } from "electron";
import * as fs from "fs";
import * as os from "os";
import { startServer, RunningServer } from "../server.js";

// A fixed port keeps the page's origin stable, so stem groups and settings saved in the
// window's storage survive restarts. Falls back to any free port if it's taken.
const PREFERRED_PORT = 40404;
const SD_CARD = "/Volumes/SP404MKII";

let server: RunningServer | undefined;
let win: BrowserWindow | undefined;

async function chooseFolder(start: string): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = {
    defaultPath: fs.existsSync(start) ? start : os.homedir(),
    properties: ["openDirectory", "createDirectory"],
  };
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return r.canceled ? undefined : r.filePaths[0];
}

async function launch() {
  const opts = {
    root: fs.existsSync(SD_CARD) ? SD_CARD : os.homedir(),
    chooseFolder,
    reveal: (file: string) => (fs.existsSync(file) && fs.statSync(file).isDirectory() ? shell.openPath(file) : shell.showItemInFolder(file)),
  };
  server = await startServer({ ...opts, port: PREFERRED_PORT }).catch(() => startServer({ ...opts, port: 0 }));

  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: "SP-404 Stems",
    backgroundColor: "#2b2d2f",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links to anything other than the app itself open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(server!.url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => (win = undefined));
  await win.loadURL(server.url);
}

app.whenReady().then(launch);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => void server?.close());

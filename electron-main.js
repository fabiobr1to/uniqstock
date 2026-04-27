const { app, BrowserWindow, shell, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

let mainWindow = null;
let updateCheckInProgress = false;
let backendServer = null;
let serverUrl = "";

function obterPortaLivre() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function esperarServidor(url, timeoutMs = 15000) {
  const inicio = Date.now();

  return new Promise((resolve, reject) => {
    const tentar = () => {
      const req = http.get(`${url}/api/status`, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        if (Date.now() - inicio > timeoutMs) {
          reject(new Error("Servidor não iniciou no tempo esperado."));
          return;
        }
        setTimeout(tentar, 300);
      });

      req.on("error", () => {
        if (Date.now() - inicio > timeoutMs) {
          reject(new Error("Servidor não iniciou no tempo esperado."));
          return;
        }
        setTimeout(tentar, 300);
      });
    };

    tentar();
  });
}

function iniciarServidorDesktop(url) {
  return new Promise((resolve, reject) => {
    let finalizado = false;
    const finalizar = (handler, valor) => {
      if (finalizado) return;
      finalizado = true;
      backendServer?.off?.("error", onError);
      handler(valor);
    };
    const onError = (error) => finalizar(reject, error);

    backendServer = require(path.join(__dirname, "server.js"));
    backendServer?.once?.("error", onError);

    esperarServidor(url)
      .then(() => finalizar(resolve, backendServer))
      .catch((error) => finalizar(reject, error));
  });
}

function criarJanela() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, "build", "uniqcode.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`${serverUrl}/login.html`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

function configurarAtualizacaoAutomatica() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", async (info) => {
    const versao = info?.version || "nova";
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Baixar agora", "Depois"],
      defaultId: 0,
      cancelId: 1,
      title: "Atualização disponível",
      message: `Nova versão disponível (${versao}).`,
      detail: "Deseja baixar e instalar a atualização agora?"
    });

    if (response === 0) {
      autoUpdater.downloadUpdate().catch((err) => {
        dialog.showMessageBox({
          type: "error",
          title: "Falha ao baixar atualização",
          message: "Não foi possível baixar a atualização.",
          detail: err?.message || String(err)
        });
      });
    }
  });

  autoUpdater.on("update-downloaded", async () => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Reiniciar agora", "Mais tarde"],
      defaultId: 0,
      cancelId: 1,
      title: "Atualização pronta",
      message: "A atualização foi baixada com sucesso.",
      detail: "Reinicie o UniqStock para concluir a instalação."
    });

    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[autoUpdater] erro:", err?.message || err);
  });

  const verificar = async () => {
    if (updateCheckInProgress) return;
    updateCheckInProgress = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      console.error("[autoUpdater] checkForUpdates falhou:", err?.message || err);
    } finally {
      updateCheckInProgress = false;
    }
  };

  setTimeout(verificar, 10000);
  setInterval(verificar, 6 * 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  const runtimeDir = path.join(app.getPath("userData"), "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  process.env.UNIQSTOCK_RUNTIME_DIR = runtimeDir;
  process.env.UNIQSTOCK_APP_PACKAGED = app.isPackaged ? "1" : "0";
  process.env.PORT = String(await obterPortaLivre());
  serverUrl = `http://127.0.0.1:${process.env.PORT}`;

  try {
    // Inicia o backend dentro do processo do app desktop.
    await iniciarServidorDesktop(serverUrl);
  } catch (error) {
    dialog.showErrorBox(
      "Falha ao iniciar o UniqStock",
      error?.message || String(error)
    );
    app.quit();
    return;
  }

  criarJanela();
  configurarAtualizacaoAutomatica();
});

app.on("window-all-closed", () => {
  if (backendServer?.close) {
    try {
      backendServer.close();
    } catch (_) {}
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    criarJanela();
  }
});

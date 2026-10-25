var chromeHandle;
var runtime;

function install() {}
function uninstall() {}

async function startup({ rootURI }) {
  if (rootURI.startsWith("jar:")) {
    const archive = Services.io.newURI(rootURI).QueryInterface(Components.interfaces.nsIJARURI).JARFile.QueryInterface(Components.interfaces.nsIFileURL).file;
    Services.obs.notifyObservers(archive, "flush-cache-entry");
  }
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
  const aom = Components.classes["@mozilla.org/addons/addon-manager-startup;1"].getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aom.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [["content", "zob-bridge", rootURI + "content/"]]);
  const win = Zotero.getMainWindow();
  const scope = { Zotero, Services, Components, ChromeUtils, IOUtils: win.IOUtils, PathUtils: win.PathUtils, structuredClone: win.structuredClone.bind(win), TextDecoder: win.TextDecoder };
  scope.globalThis = scope;
  for (const file of ["paper-metadata.js", "reading-layout.js", "core.js", "adapter.js", "store.js", "annotations.js", "runtime.js"]) {
    Services.scriptloader.loadSubScriptWithOptions(rootURI + "content/" + file, { target: scope, charset: "UTF-8", ignoreCache: true });
  }
  runtime = new scope.ZOBRuntime();
  await runtime.start();
}

async function onMainWindowLoad({ window }) { await runtime?.addWindow(window); }
async function onMainWindowUnload({ window }) { runtime?.removeWindow(window); }

async function shutdown() {
  await runtime?.stop();
  runtime = null;
  chromeHandle?.destruct();
  chromeHandle = null;
}

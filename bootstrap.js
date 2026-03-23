/**
 * ZotSeek - Semantic Search for Zotero - Bootstrap
 * Based on Zotero's official Make It Red example and BetterNotes plugin.
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  Zotero.debug("[ZotSeek Bootstrap] Waiting for initialization...");
  await Zotero.initializationPromise;
  Zotero.debug("[ZotSeek Bootstrap] Zotero initialized");

  // Register chrome content and locale
  Zotero.debug("[ZotSeek Bootstrap] Registering chrome content...");
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotseek", rootURI + "content/"],
    ["locale", "zotseek", "en-US", rootURI + "locale/en-US/"],
    ["locale", "zotseek", "zh-CN", rootURI + "locale/zh-CN/"],
  ]);
  Zotero.debug("[ZotSeek Bootstrap] Chrome content and locale registered");

  // Create context for the plugin script
  // _globalThis allows the script to access this context
  const ctx = {
    rootURI,
    Zotero,
    // Provide document for fake browser environment
    document: Zotero.getMainWindow()?.document,
  };
  ctx._globalThis = ctx;

  // Load the main script
  Zotero.debug("[ZotSeek Bootstrap] Loading main script...");
  try {
    Services.scriptloader.loadSubScript(
      `${rootURI}content/scripts/index.js`,
      ctx
    );
    Zotero.debug("[ZotSeek Bootstrap] Main script loaded");
  } catch (e) {
    Zotero.debug("[ZotSeek Bootstrap] ERROR loading script: " + e);
    Zotero.logError(e);
    return;
  }

  // The script attaches itself to Zotero.ZotSeek
  if (Zotero.ZotSeek) {
    Zotero.debug("[ZotSeek Bootstrap] Calling onStartup...");
    Zotero.ZotSeek.setInfo({ id, version, rootURI });
    await Zotero.ZotSeek.hooks.onStartup();
    Zotero.debug("[ZotSeek Bootstrap] Startup complete");
  } else {
    Zotero.debug("[ZotSeek Bootstrap] ERROR: Zotero.ZotSeek not found!");
  }
}

function onMainWindowLoad({ window: win }) {
  Zotero.ZotSeek?.hooks.onMainWindowLoad(win);
}

function onMainWindowUnload({ window: win }) {
  Zotero.ZotSeek?.hooks.onMainWindowUnload(win);
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  Zotero.ZotSeek?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

/**
 * Uninstall cleanup - removes the ZotSeek database file
 * This ensures no orphaned data remains after plugin removal
 *
 * Only deletes on true uninstall (ADDON_UNINSTALL = 6), not on upgrade/reload
 */
async function uninstall(data, reason) {
  Zotero.debug("[ZotSeek Bootstrap] Uninstall called with reason: " + reason);

  // ADDON_UNINSTALL = 6, only delete database on true uninstall
  // Don't delete on ADDON_UPGRADE (7), ADDON_DOWNGRADE (8), or during dev reloads
  if (reason !== 6) {
    Zotero.debug("[ZotSeek Bootstrap] Skipping cleanup (not a true uninstall)");
    return;
  }

  Zotero.debug("[ZotSeek Bootstrap] Performing uninstall cleanup...");

  try {
    // Delete the ZotSeek database file
    const dbPath = PathUtils.join(Zotero.DataDirectory.dir, "zotseek.sqlite");
    Zotero.debug("[ZotSeek Bootstrap] Deleting database: " + dbPath);

    // Try to detach database first if Zotero.DB is available
    if (Zotero.DB) {
      try {
        await Zotero.DB.queryAsync("DETACH DATABASE zotseek");
        Zotero.debug("[ZotSeek Bootstrap] Database detached");
      } catch (e) {
        // Database may not be attached, that's fine
        Zotero.debug("[ZotSeek Bootstrap] Database not attached (ok): " + e);
      }
    }

    // Delete the database file
    await IOUtils.remove(dbPath, { ignoreAbsent: true });
    Zotero.debug("[ZotSeek Bootstrap] Database file deleted");

    // Also delete any related files (journal, wal, shm)
    await IOUtils.remove(dbPath + "-journal", { ignoreAbsent: true });
    await IOUtils.remove(dbPath + "-wal", { ignoreAbsent: true });
    await IOUtils.remove(dbPath + "-shm", { ignoreAbsent: true });

    // Clear preferences
    const prefBranch = Services.prefs.getBranch("extensions.zotero.zotseek.");
    try {
      prefBranch.deleteBranch("");
      Zotero.debug("[ZotSeek Bootstrap] Preferences cleared");
    } catch (e) {
      Zotero.debug("[ZotSeek Bootstrap] Could not clear preferences: " + e);
    }

    Zotero.debug("[ZotSeek Bootstrap] Uninstall cleanup complete");
  } catch (e) {
    Zotero.debug("[ZotSeek Bootstrap] Uninstall error: " + e);
    Zotero.logError(e);
  }
}

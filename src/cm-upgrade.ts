/**
 * Module for performing automatic CMake upgrades
 */ /** */

import {createLogger} from '@cmt/logging';
import {LatestCMakeInfo} from '@cmt/nag';
import paths from '@cmt/paths';
import {execute} from '@cmt/proc';
import rollbar from '@cmt/rollbar';
import {InvalidVersionString, ProgressHandle, Version, versionLess, versionToString} from '@cmt/util';
import {https} from 'follow-redirects';
import * as fs from 'fs';
import * as url_mod from 'url';
import * as path from 'path';
import * as tmp from 'tmp';
import * as vscode from 'vscode';
import { ClientRequestArgs } from 'http';

const log = createLogger('cm-upgrade');

const UPGRADE_PREFERENCE_KEY = 'cmakeUpgradePreference.1';

interface UpgradeDelay {
  lastNag: number;
}

function upgradePreference(ext: vscode.ExtensionContext): 'never'|UpgradeDelay|undefined {
  return ext.globalState.get(UPGRADE_PREFERENCE_KEY);
}

async function setUpgradePreference(ext: vscode.ExtensionContext, value: 'never'|UpgradeDelay) {
  await ext.globalState.update(UPGRADE_PREFERENCE_KEY, value);
}

async function downloadFile(url: string, opt: {prefix: string, postfix: string}, pr: ProgressHandle) {
  return new Promise<string>((resolve, reject) => {
    tmp.file(
        {mode: 0b111000000, prefix: opt.prefix, postfix: opt.postfix},
        (err, fpath, fd) => {
          if (err) {
            reject(err);
            return;
          }
          try {
            const ostream = fs.createWriteStream(fpath, { fd });
            const reqOptions: ClientRequestArgs = url_mod.parse(url);
            (reqOptions as any).maxBodyLength = 1024 * 1024 * 60;
            const req = https.get(reqOptions, res => {
              if (res.statusCode !== 200) {
                reject(new Error('Non-200 response when downloading new CMake installer'));
                return;
              }

              let totalSize: number = 0;
              try {
                totalSize = parseInt(res.headers['content-length'] || '0');
              } catch (e) {
                // Do nothing. Oh well.
              }

              let prevDownloaded = 0;
              let totalDownloaded = 0;
              res.on('data', data => {
                totalDownloaded = totalDownloaded + data.length;
                if (totalSize !== 0) {
                  const diffPercent = 100 * (totalDownloaded - prevDownloaded) / totalSize;
                  const totalPercent = 100 * totalDownloaded / totalSize;
                  if (diffPercent > 1) {
                    pr.report({
                      increment: diffPercent,
                      message: `${totalPercent.toFixed(0)}%`,
                    });
                    prevDownloaded = totalDownloaded;
                  }
                }
              });
              res.pipe(ostream);
              res.on('end', () => {
                log.info(`Downloaded ${url} to ${fpath}`);
                resolve(fpath);
              });
            });
            req.on('error', e => reject(e));
          } catch (e) { reject(e); }
        },
    );
  });
}

async function installLinux(url: string) {
  const pkexec = await paths.which('pkexec');
  if (!pkexec) {
    vscode.window.showErrorMessage('CMake Tools needs `pkexec` program to run the CMake installer');
    return;
  }
  const filename = path.basename(url, '.sh');
  const installerPath = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${filename}`,
      },
      pr => downloadFile(url, {prefix: filename, postfix: '.sh'}, pr),
  );
  const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running CMake Installer',
      },
      () => {
        const proc = execute(pkexec, [installerPath, '--exclude-subdir', '--prefix=/usr/local']);
        return proc.result;
      },
  );
  if (res.retc === 127) {
    vscode.window.showErrorMessage('Failed to authorize for running the CMake installation.');
  } else if (res.retc === 126) {
    vscode.window.showErrorMessage('You dismissed the request for permission to perform the CMake installation.');
  } else if (res.retc !== 0) {
    log.error(`The CMake installer returned non-zero [${res.retc}]: `, res.stderr);
    vscode.window.showErrorMessage(
        'The CMake installer exited with non-zero. Check the output panel for more information');
  } else {
    const restartNow = 'Restart Now';
    const chosen = await vscode.window.showInformationMessage(
        'The new CMake is successfull installed to /usr/local/bin/cmake. Reload VSCode to complete changes.',
        restartNow,
    );
    if (chosen === restartNow) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
}

export async function maybeUpgradeCMake(ext: vscode.ExtensionContext,
                                        opt: {currentVersion: Version, available: LatestCMakeInfo}) {
  if (process.platform !== 'linux') {
    // Only implemented on Linux so far
    return;
  }
  const pref = upgradePreference(ext);
  if (pref === 'never') {
    // The user never wants to auto-upgrade
    return;
  } else if (pref) {
    // User is delaying the upgrade
    const timeSinceNag = new Date().getTime() - pref.lastNag;
    if (timeSinceNag < (1000 * 60 * 60 * 48)) {
      // Only ask every two days
      return;
    }
  }
  // Check for an upgrade
  let upgradeAvailable: boolean;
  try {
    upgradeAvailable = versionLess(opt.currentVersion, opt.available.version);
  } catch (e) {
    if (!(e instanceof InvalidVersionString)) {
      rollbar.exception('Error comparing CMake versions for potential upgrade', e, opt);
    }
    return null;
  }
  if (!upgradeAvailable) {
    // Nothing to do. Okay.
    return;
  }

  const doTheUpgrade = 'Yes';
  const askMeLater = 'Ask me Later';
  const dontAskAgain = 'Don\'t Ask Me Again';

  const chosen = await vscode.window.showInformationMessage(
      `There is a new version of CMake available. You are running ${versionToString(opt.currentVersion)}, ` +
          `and ${opt.available.version} is available. ` +
          'Would you like CMake Tools to download and install this update automatically?',
      doTheUpgrade,
      askMeLater,
      dontAskAgain,
  );
  if (chosen === undefined) {
    // They didn't make a choice. Ask again the next time we poll.
    return;
  }
  if (chosen === dontAskAgain) {
    await setUpgradePreference(ext, 'never');
    return;
  }
  if (chosen === askMeLater) {
    await setUpgradePreference(ext, {lastNag: new Date().getTime()});
    return;
  }
  console.assert(chosen == doTheUpgrade);
  switch (process.platform) {
  // case 'win32':
  //   await installWindows(opt.available.windowsURL);
  //   break;
  case 'linux':
    await installLinux(opt.available.linuxURL);
    break;
  // case 'darwin':
  //   // TODO
  //   break;
  default:
    // Not sure how we get on this platform... But okay.
    return;
  }
}

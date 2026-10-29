import 'core-js/stable';
import 'regenerator-runtime';

import "webostvjs/webOSTV";

function lunaCall(uri, parameters) {
  return new Promise((resolve, reject) => {
    const s = uri.indexOf("/", 7);
    webOS.service.request(uri.substr(0, s), {
      method: uri.substr(s + 1),
      parameters,
      onSuccess: resolve,
      onFailure: (res) => {
        reject(new Error(JSON.stringify(res)));
      },
    });
  });
}

async function retry(attempt, cb) {
  while (true) {
    try {
      return await cb();
    } catch (err) {
      if (attempt--) {
        log (`... failed (${err.message}), ${attempt} tries left`);
        continue;
      }
      throw err;
    }
  }
}

function log(s) {
  document.querySelector('pre').innerText += `[${new Date()}] ${s}\n`;
}

function logres(res) {
  if (res && res.returnValue === true) {
    if (res.message) {
      log(`... success (${res.message})`);
    } else {
      log('... success');
    }
  } else {
    const error = JSON.stringify(res);
    log(`... failed (${error})`);
    throw new Error(error);
  }
}
(async () => {

  /* We'll do a certain number of luna calls.
     On startup, sometimes these calls fail (bus overload?),
     so we'll retry them 3 times if we get an error.
     Each call usually take between 0 and 10 seconds. */

  try {
  /* Be polite and launch the actual previous input app, if any.
     This'll give back control to the user while we finish our setup
     in the background, as the whole process can be slow due to luna calls
     and the number of other processes competing for CPU on startup. */
    await retry(3, async () => {
      log("Checking last input app...");
      const lastinput = await lunaCall('luna://org.webosbrew.hbchannel.service/exec', {
        command: 'cat /var/lib/eim/lastinput',
      });
      if (lastinput.stdoutString) {
        const lastinputPayload = JSON.parse(lastinput.stdoutString);
        if (lastinputPayload.appId) {
          log(`Last input app: ${lastinputPayload.appId}`);
          if (lastinputPayload.appId !== 'org.webosbrew.autostart') {
            log("Relaunching this app...");
            const res = await lunaCall('luna://com.webos.service.applicationManager/launch', {
              id: lastinputPayload.appId,
            });
            logres(res);
          }
        }
      }
      else {
        log("No app to relaunch.");
      }
    });
  } catch (err) {
    log(`Couldn't start last input app but carrying on:\n${err.stack}`);
  }

  try {
  /* Launch autostart soon in the process because even if we fail later down,
     at least everything will have started (including SSH). */
    await retry(3, async () => {
      log("Launching autostart...");
      const res = await lunaCall('luna://org.webosbrew.hbchannel.service/autostart', {});
      logres(res);
    });
  } catch (err) {
    log(`Couldn't run autostart, but carrying on:\n${err.stack}`);
  }

  /* Now, all that we want is ensuring that we get started on next boot,
     all the logic below is here to ensure this is the case. */

  try {
    /* First, unregister (always succeeds, even if we weren't registered),
       this is needed because we'll get started only on the boot following
       a successful addDevice, and this only succeeds if we're not already in the list. */
    await retry(3, async () => {
      log('Unregistering ourselves as input app...');
      const res = await lunaCall('luna://com.webos.service.eim/deleteDevice', {
        appId: 'org.webosbrew.autostart',
      });
      logres(res);
    });
  } catch (err) {
    log(`Couldn't unregister, but carrying on:\n${err.stack}`);
  }

  try {
    // Register again to ensure we're started on next boot.
    await retry(3, async () => {
      log('Registering ourselves as input app...');
      const res = await lunaCall('luna://com.webos.service.eim/addDevice', {
        appId: 'org.webosbrew.autostart',
        pigImage: '',
        mvpdIcon: '',
        type: 'MVPD_IP', // can be either MVPD_IP or MVPD_RF, required for webOS 3.4 at least
        label: 'Autostart', // required for webOS 3.4 at least
        description: 'webosbrew autostart', // required for webOS 3.4 at least
      });
      logres(res);
    });
  } catch (err) {
    log(`Couldn't register, but carrying on:\n${err.stack}`);
  }

  try {
    /* Now, setup an eim overlay so that any changes done later don't erase our own app
       if /var/lib/webosbrew/eim already exists, keep it that way, changes done in previous
       sessions will live here, so just bind mount it, otherwise create it
       from the /var/lib/eim contents. */
    await retry(3, async () => {
      log('Setting up eim overlay...');
const command = [
  'set -e',

  // Ensure the persistent Homebrew directory exists.
  'mkdir -p /var/lib/webosbrew',

  // Create the EIM overlay only once.
  'if [ ! -d /var/lib/webosbrew/eim ]; then',
  '  cp -a /var/lib/eim /var/lib/webosbrew/eim',
  'fi',

  // Ensure that the copied database exists.
  'test -d /var/lib/webosbrew/eim',
  'test -f /var/lib/webosbrew/eim/eim_db.dat',

  // Activate the overlay if it is not mounted yet.
  'if ! findmnt -n /var/lib/eim >/dev/null 2>&1; then',
  '  mount --bind /var/lib/webosbrew/eim /var/lib/eim',
  'fi',

  // Verify that the expected overlay is mounted.
  'findmnt -n /var/lib/eim',

  'echo "EIM_OVERLAY_OK"',
].join('\n');

const res = await lunaCall(
  'luna://org.webosbrew.hbchannel.service/exec',
  { command }
);

log(`Result: ${res.stdoutString} ${res.stderrString}`);

if (
  res.returnValue === false ||
  !res.stdoutString ||
  !res.stdoutString.includes('EIM_OVERLAY_OK') ||
  !res.stdoutString.includes('/var/lib/webosbrew/eim')
) {
  throw new Error(
    `EIM overlay setup failed: ${JSON.stringify(res)}`
  );
}
    });
  } catch (err) {
    log(`Couldn't setup overlay, stopping here:\n${err.stack}`);
    return;
  }

  try {
    /* This just removes ourselves from the overlay, but we still live in the real /var/lib/eim,
       which guarantees that we'll survive on the next reboot. */
    await retry(3, async () => {
      log('Unregistering ourselves as input app from the overlay...');
      const res = await lunaCall('luna://com.webos.service.eim/deleteDevice', {
        appId: 'org.webosbrew.autostart',
      });
      logres(res);
    });
  } catch (err) {
    log(`Couldn't unregister, but carrying on:\n${err.stack}`);
  }

  log("Done.");

  // %AUTOCLOSE% await new Promise(resolve => setTimeout(resolve, 1000));
  // %AUTOCLOSE% window.close();
})();

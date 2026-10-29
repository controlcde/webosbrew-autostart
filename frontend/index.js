import 'core-js/stable';
import 'regenerator-runtime';

import 'webostvjs/webOSTV';

const APP_ID = 'org.webosbrew.autostart';

const EIM_SOURCE = '/var/lib/eim';
const EIM_OVERLAY = '/var/lib/webosbrew/eim';

const MAX_RETRIES = 3;

function log(message) {
  const output = document.querySelector('pre');
  const line = `[${new Date().toISOString()}] ${message}\n`;

  if (output) {
    output.textContent += line;
  }

  console.log(message);
}

function lunaCall(uri, parameters = {}) {
  return new Promise((resolve, reject) => {
    const separator = uri.indexOf('/', 7);

    if (separator === -1) {
      reject(new Error(`Invalid Luna URI: ${uri}`));
      return;
    }

    webOS.service.request(uri.substring(0, separator), {
      method: uri.substring(separator + 1),
      parameters,

      onSuccess: (response) => {
        if (response && response.returnValue === false) {
          reject(new Error(JSON.stringify(response)));
          return;
        }

        resolve(response);
      },

      onFailure: (response) => {
        reject(new Error(JSON.stringify(response)));
      },
    });
  });
}

async function retry(attempts, callback) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;

      const remaining = attempts - attempt;

      log(
        `Attempt ${attempt}/${attempts} failed: ` +
        `${error.message || error}. ${remaining} tries left.`
      );

      if (remaining > 0) {
        // Give Luna services a moment to recover during startup.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  throw lastError;
}

function logres(response) {
  if (!response || response.returnValue !== true) {
    throw new Error(
      `Luna call failed: ${JSON.stringify(response)}`
    );
  }

  if (response.message) {
    log(`... success (${response.message})`);
  } else {
    log('... success');
  }
}

async function exec(command) {
  const response = await lunaCall(
    'luna://org.webosbrew.hbchannel.service/exec',
    { command }
  );

  const stdout = response.stdoutString || '';
  const stderr = response.stderrString || '';

  if (stdout) {
    log(`stdout:\n${stdout.trim()}`);
  }

  if (stderr) {
    log(`stderr:\n${stderr.trim()}`);
  }

  return response;
}

async function restoreLastInput() {
  await retry(MAX_RETRIES, async () => {
    log('Checking last input app...');

    const response = await exec(
      `cat ${EIM_SOURCE}/lastinput`
    );

    if (!response.stdoutString) {
      log('No previous input found.');
      return;
    }

    const lastInput = JSON.parse(response.stdoutString);

    if (!lastInput.appId) {
      log('Previous input has no appId.');
      return;
    }

    log(`Last input app: ${lastInput.appId}`);

    if (lastInput.appId === APP_ID) {
      log('Skipping relaunch of autostart itself.');
      return;
    }

    log('Relaunching previous input...');

    const launchResponse = await lunaCall(
      'luna://com.webos.service.applicationManager/launch',
      { id: lastInput.appId }
    );

    logres(launchResponse);
  });
}

async function startHomebrew() {
  await retry(MAX_RETRIES, async () => {
    log('Launching Homebrew startup...');

    const response = await lunaCall(
      'luna://org.webosbrew.hbchannel.service/autostart',
      {}
    );

    logres(response);
  });
}

async function deleteInputRegistration() {
  const response = await lunaCall(
    'luna://com.webos.service.eim/deleteDevice',
    { appId: APP_ID }
  );

  logres(response);
}

async function addInputRegistration() {
  const response = await lunaCall(
    'luna://com.webos.service.eim/addDevice',
    {
      appId: APP_ID,
      pigImage: '',
      mvpdIcon: '',
      type: 'MVPD_IP',
      label: 'Autostart',
      description: 'webosbrew autostart',
    }
  );

  logres(response);
}

function buildOverlayCommand() {
  return [
    'set -eu',

    `SOURCE="${EIM_SOURCE}"`,
    `OVERLAY="${EIM_OVERLAY}"`,

    // Create persistent Homebrew storage if necessary.
    'mkdir -p /var/lib/webosbrew',

    // Never overwrite an existing overlay.
    'if [ ! -d "$OVERLAY" ]; then',
    '  echo "Creating persistent EIM overlay..."',
    '  cp -a "$SOURCE" "$OVERLAY"',
    'fi',

    // Validate the copied database before mounting.
    'test -d "$OVERLAY"',
    'test -f "$OVERLAY/eim_db.dat"',

    // A mount may already exist after another app invocation.
    'if findmnt -n "$SOURCE" >/dev/null 2>&1; then',
    '  echo "EIM is already mounted."',
    'else',
    '  echo "Mounting persistent EIM overlay..."',
    '  mount --bind "$OVERLAY" "$SOURCE"',
    'fi',

    // Verify that the mount really points to our overlay.
    'MOUNT_SOURCE="$(findmnt -n -o SOURCE "$SOURCE")"',

    'case "$MOUNT_SOURCE" in',
    '  *"[/var/lib/webosbrew/eim]")',
    '    echo "EIM mount source verified."',
    '    ;;',
    '  *)',
    '    echo "ERROR: Unexpected EIM mount source: $MOUNT_SOURCE" >&2',
    '    exit 1',
    '    ;;',
    'esac',

    // Verify that the database remains accessible.
    'test -f "$SOURCE/eim_db.dat"',

    // Emit the success marker only after all checks pass.
    'echo "EIM_OVERLAY_OK"',
  ].join('\n');
}

async function setupEimOverlay() {
  await retry(MAX_RETRIES, async () => {
    log('Setting up EIM overlay...');

    const response = await exec(buildOverlayCommand());

    const stdout = response.stdoutString || '';

    if (!stdout.includes('EIM_OVERLAY_OK')) {
      throw new Error(
        `EIM overlay setup failed: ${JSON.stringify(response)}`
      );
    }

    log('EIM overlay successfully verified.');
  });
}

async function main() {
  log('webOS Homebrew Autostart 0.1.5');
  log('Starting initialization...');

  /*
   * Restore the previous input early so the user can continue
   * watching TV while the remaining operations run.
   */
  try {
    await restoreLastInput();
  } catch (error) {
    log(
      `Could not restore previous input; continuing:\n${error.stack}`
    );
  }

  /*
   * Start Homebrew as early as possible.
   *
   * This starts SSH and the configured Homebrew services,
   * including Glasshouse.
   */
  try {
    await startHomebrew();
  } catch (error) {
    log(
      `Could not start Homebrew; continuing:\n${error.stack}`
    );
  }

  /*
   * Prepare the next boot.
   *
   * The EIM mechanism requires:
   *
   * 1. Remove the current registration.
   * 2. Register the app again in the real EIM database.
   * 3. Bind-mount the persistent overlay.
   * 4. Remove the registration from the mounted overlay.
   *
   * The real database retains the registration so webOS
   * launches this application again on the next boot.
   */

  try {
    log('Unregistering previous input-app entry...');

    await retry(MAX_RETRIES, deleteInputRegistration);
  } catch (error) {
    log(
      `Could not remove previous registration; continuing:\n` +
      `${error.stack}`
    );
  }

  /*
   * Register the app for the next boot.
   *
   * Unlike the original implementation, failure here is fatal
   * for the EIM setup. We must not delete a registration from
   * the overlay if registration in the real database failed.
   */
  try {
    log('Registering autostart as input app...');

    await retry(MAX_RETRIES, addInputRegistration);
  } catch (error) {
    log(
      `ERROR: Could not register autostart.\n${error.stack}`
    );

    log('Stopping EIM setup to preserve the current state.');
    return;
  }

  /*
   * Create or activate the persistent EIM overlay.
   *
   * Never proceed to the final deleteDevice unless the
   * expected bind mount has been verified.
   */
  try {
    await setupEimOverlay();
  } catch (error) {
    log(
      `ERROR: Could not initialize EIM overlay.\n${error.stack}`
    );

    log('Stopping before deleting the input-app registration.');
    return;
  }

  /*
   * Remove our registration from the mounted overlay.
   *
   * The underlying EIM database still contains the entry,
   * which allows webOS to launch us on the next boot.
   */
  try {
    log('Removing autostart registration from EIM overlay...');

    await retry(MAX_RETRIES, deleteInputRegistration);
  } catch (error) {
    log(
      `ERROR: Could not remove registration from overlay.\n` +
      `${error.stack}`
    );

    return;
  }

  log('Autostart initialization completed successfully.');

  // Give the user a moment to see the success message.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Close the app and return to the previous input.
  log('Closing autostart application...');
  window.close();
}

main().catch((error) => {
  log(`Unexpected fatal error:\n${error.stack || error}`);
});

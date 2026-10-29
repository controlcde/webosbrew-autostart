# webOS Homebrew Autostart

**EIM-based Homebrew startup for rooted LG webOS TVs — maintained fork, v0.1.5.**

This project starts the [webOS Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) startup service automatically when a compatible LG TV boots. The startup service can in turn launch SSH and other Homebrew startup hooks (for example, Glasshouse). The Autostart application then closes and attempts to restore the previous input.

> [!IMPORTANT]
> **Check whether you need this workaround.** The upstream project was marked obsolete because the Homebrew Channel addressed the underlying startup issue in [PR #230](https://github.com/webosbrew/webos-homebrew-channel/pull/230); see also [issue #124](https://github.com/webosbrew/webos-homebrew-channel/issues/124). Prefer the Homebrew Channel's native startup support where it works. This fork remains useful on older installations where Homebrew services only start after manually opening the channel.

## Compatibility and tested setup

| Item | Status |
| --- | --- |
| LG 32LJ610V, webOS 3.x | **Tested successfully** |
| Root obtained with [dejavuln-autoroot](https://github.com/throwaway96/dejavuln-autoroot) | Tested |
| Homebrew Channel startup service | Tested |
| SSH (Dropbear) after power cycle | Tested |
| Glasshouse / Home Assistant after power cycle | Tested |
| App launches and closes automatically | Tested |
| First-time setup on a freshly rooted TV | **Not independently verified** |
| Other models and firmware versions | Not verified by this fork |

**Root access is required.** This is not a general-purpose app for unmodified LG TVs.

## What's improved in v0.1.5

- More explicit checks when preparing the persistent EIM overlay.
- Verification that the expected bind mount is active before changing the overlay registration.
- Improved Luna-call error handling, retries, and on-screen diagnostics.
- Stops EIM setup on critical errors rather than proceeding to an unsafe registration change.
- Automatically closes the app after successful initialization.
- Retains the original behavior of restoring the previous input when possible.

The successful test above was performed on a TV whose EIM setup had previously been completed manually. **A successful update or reboot on that TV does not prove a fresh installation is fully automatic.**

## Requirements

- A compatible, **rooted** LG webOS TV.
- [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) installed and its service functional.
- Working Homebrew startup script at `/var/lib/webosbrew/startup.sh`.
- SSH access to install the IPK using the commands below.
- A computer with `ssh` and `scp` available.

## Installation

### 1. Download the IPK

Download `org.webosbrew.autostart_0.1.5_all.ipk` from this repository's [Releases](https://github.com/controlcde/webosbrew-autostart/releases), if attached to a release. Alternatively, download the IPK build artifact from [GitHub Actions](https://github.com/controlcde/webosbrew-autostart/actions) and extract the ZIP file.

### 2. Transfer it to the TV

Run on your **computer**, from the directory containing the IPK:

```sh
scp org.webosbrew.autostart_0.1.5_all.ipk root@TV_IP:/tmp/autostart.ipk
```

Replace `TV_IP` with your TV's address. Then connect:

```sh
ssh root@TV_IP
```

### 3. Install it

Run on the **TV**, over SSH:

```sh
luna-send-pub -i \
  luna://com.webos.appInstallService/dev/install \
  '{"id":"com.ares.defaultName","ipkUrl":"/tmp/autostart.ipk","subscribe":true}'
```

Wait for an installation status containing `"state":"installed"`. Verify the installed version:

```sh
cat /media/developer/apps/usr/palm/applications/org.webosbrew.autostart/appinfo.json
```

The `version` field should read `0.1.5`.

### 4. Initialize the app

Open **Autostart** once from the TV launcher. The app should start the Homebrew service, register itself for the next boot, prepare and verify the EIM overlay, and remove its registration from the **mounted overlay**. On success it should report messages similar to:

```text
EIM_OVERLAY_OK
EIM overlay successfully verified.
Autostart initialization completed successfully.
Closing autostart application...
```

It should then close automatically and return to the previous input when possible. **If an error remains on screen, investigate it before rebooting.** Do not manually repeat the EIM commands unless you understand their effect.

### 5. Verify after a reboot

Power-cycle or fully restart the TV. **Do not manually open Homebrew Channel.** Allow the TV to finish booting, then check from your computer:

```sh
ssh root@TV_IP
```

Also check that your configured Homebrew services are online (for example, Glasshouse in Home Assistant).

## How it works

This is an *Input Apps* / External Input Manager (EIM) workaround:

1. The app requests `luna://org.webosbrew.hbchannel.service/autostart` to start Homebrew services.
2. It removes any previous input-app registration and registers `org.webosbrew.autostart` with EIM for the next boot.
3. It creates or reuses a persistent EIM data copy at `/var/lib/webosbrew/eim` and bind-mounts that directory over `/var/lib/eim`.
4. It verifies the mount, then removes its own registration from the **mounted copy**.
5. The underlying EIM data retains the registration. After reboot, the temporary bind mount is gone, so webOS can launch Autostart again; the app re-establishes the overlay.

The app also tries to relaunch the previous input so that it does not leave the user on its own screen. It does **not** require writing to protected kernel or root filesystem partitions. It **does** modify EIM registration data, so firmware compatibility matters.

## Building from source

You can use the repository's [GitHub Actions](https://github.com/controlcde/webosbrew-autostart/actions) workflow to build an IPK without installing a toolchain locally. Open the successful run and download its artifact.

For a local build, install a compatible Node.js/npm toolchain and the project's dependencies:

```sh
npm ci
npm run build
npm run package
```

For development on a configured TV or emulator, the upstream project also provides:

```sh
node_modules/.bin/ares-setup-device ...
npm run deploy
npm run launch
```

The output IPK version is derived from the package metadata. When preparing a release, keep `package.json` and `package-lock.json` consistent.

## Troubleshooting

**The app installs but SSH only starts after opening Homebrew Channel:** Confirm that the Homebrew startup service and `/var/lib/webosbrew/startup.sh` work, and inspect the Autostart app's on-screen log. A successful IPK installation alone does not configure boot startup.

**The app stays open:** Check the on-screen output. In v0.1.5 it closes automatically after successful initialization; a critical setup failure can leave the screen visible for diagnosis.

**Overlay verification fails:** Do not blindly call `deleteDevice` or remove EIM database files. On a rooted TV, `findmnt /var/lib/eim` can help confirm whether the expected overlay is mounted.

**The app does not start after reboot:** This mechanism depends on firmware-specific EIM behavior. The upstream Homebrew Channel fix may be a better option for your setup.

## Credits and project history

- Original project: [kopiro/webosbrew-autostart](https://github.com/kopiro/webosbrew-autostart).
- Rewritten EIM-based implementation: [speed47/webosbrew-autostart](https://github.com/speed47/webosbrew-autostart).
- Compatibility context: [Homebrew Channel issue #124](https://github.com/webosbrew/webos-homebrew-channel/issues/124).
- Homebrew Channel native-startup fix: [PR #230](https://github.com/webosbrew/webos-homebrew-channel/pull/230).
- This fork: [controlcde/webosbrew-autostart](https://github.com/controlcde/webosbrew-autostart).

## Disclaimer and development disclosure

This project is provided **as is**, without warranty. Rooting and changes to EIM input registration can affect TV behavior. Back up important data and proceed at your own risk.

**Vibe coding disclosure:** The v0.1.5 adaptations in this fork were developed with AI-assisted *vibe coding* (ChatGPT), guided by manual diagnostics and real-device testing. The successful boot, SSH, Glasshouse, and automatic-close behavior were verified on an LG 32LJ610V running webOS 3.x; broader compatibility and fresh-device installation have not been independently validated.

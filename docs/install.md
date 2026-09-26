# Installing Lantern

This takes about five minutes. You need Windows 10 or 11. You don't need a GitHub account.

1. **Download:** **[Lantern.zip](https://github.com/juggernautjake/lantern/releases/latest/download/Lantern.zip)**. It's always the newest version.
2. **Unzip:** open your Downloads folder, right-click **Lantern.zip** and choose **Extract All…**. For the place, type `C:\Lantern` (or anywhere you'll keep it), then click **Extract**.
3. **Install:** in that folder, double-click **Install Lantern.cmd**.
   - If Windows says *"Windows protected your PC"*, click **More info**, then **Run anyway**.
   - If it says Lantern needs **Node.js**, answer **Y**. It installs Node.js (a free program Lantern runs on) with Microsoft's installer. When that finishes, run **Install Lantern.cmd** again.
   - It adds **Lantern** to your Start menu and desktop, and asks whether to start Lantern when you sign in to Windows.
4. **Open Lantern** from the desktop icon. It opens in your web browser. It runs only on your computer: nobody else can reach it.

## Next

- **Someone sent you a course?** Go to **Settings → Account & hub**. Paste the hub address and public key they gave you, then create your account with the email they sent the course to. The course is waiting under **Invitations**.
- **Have a progress backup from the web version** of a course? Open the course, then **Bring your progress from the web version**.

## Where things are

| | |
|---|---|
| **The program** | The folder you unzipped. Updates replace it |
| **Your data** | `%LOCALAPPDATA%\Lantern`: your progress, courses and backups. Updates never touch it |
| **Stop Lantern** | Start menu → Lantern → **Stop Lantern** |
| **Update now** | Start menu → Lantern → **Update Lantern**. Normally Lantern updates itself; see [Updates and your data](updates-and-your-data.md) |
| **Uninstall** | Delete the program folder, and the Lantern folder in your Start menu. Delete `%LOCALAPPDATA%\Lantern` too only if you don't want to keep your progress |

## For other apps (quiet install)

`Install Lantern.cmd --quiet` installs with no questions and writes its progress to `%LOCALAPPDATA%\Lantern\install-status.json`. Dayspring uses this; see `docs/dev/ecosystem.md`.

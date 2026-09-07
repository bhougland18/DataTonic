# Arch Linux packaging, and the route to Omarchy

**Status: both packages build in a real Arch container**, on every change to
this directory - see `.github/workflows/arch-package.yml`. What remains
unverified is the part that needs a running desktop session, listed in section
4. Building them is what found the three defects noted below; reading them
would not have.

---

## 1. What "publish to Omarchy" actually means

Omarchy's Install menu (`Super + Alt + Space` → *Install*) is a thin fzf UI over
three sources, none of which is an app store Duckle can submit to directly:

| Source | Reachable? |
| :--- | :--- |
| Official Arch repos (`core`/`extra`) | No. Requires an Arch package maintainer to adopt the software; no self-service path. |
| **OPR** (`pkgs.omarchy.org`) | No. Basecamp's own infrastructure, holding essentially `omarchy` and `omarchy-settings`. No public submission process. |
| **AUR** | **Yes.** Open, self-service, and what `omarchy-pkg-aur-install` searches. |

There is a fourth entry, *Install → Web App*, but it wraps a URL in a frameless
browser window. It does not apply to a native Tauri binary.

**So the deliverable is a well-formed AUR package.** Bundled inclusion in OPR is
a separate, much higher bar - realistically only reachable after AUR traction
and community requests - and is section 7, not the main path.

## 2. Two packages, not one

| Package | Installs | Dependencies |
| :--- | :--- | :--- |
| `duckle-runner-bin` | The headless runner | **none** - statically linked against musl |
| `duckle-bin` | The desktop application | `webkit2gtk-4.1 gtk3 libsoup3 glib2 cairo dbus hicolor-icon-theme` |

Split because they share nothing at install time. A server wants the runner and
should not pull in a browser engine to get it. `duckle-bin` lists the runner as
`optdepends` so the connection is discoverable without being forced.

`unixodbc` is deliberately absent from both: the release workflow refuses to
publish a Linux binary that requires `libodbc.so`, so ODBC is linked statically.
That check exists because a build once shipped needing it.

## 3. Binary, not source - and there is no `.deb`

`duckle-bin` repackages the released binary rather than building from source.
Source-building means the full Rust + Node toolchain in `makepkg`, and every
toolchain bump becomes a package break; that is worth doing once the `-bin`
package is stable and someone owns keeping it green, not first.

**One correction worth having up front:** the release workflow runs
`cargo build --release`, **not** `cargo tauri build`. The Tauri bundler never
runs, so there is **no `.deb`, no generated `.desktop` file, and no icon
installation** - the release publishes a bare `Duckle-linux-x64` executable.
A PKGBUILD that extracts `data.tar.*` from a `.deb` would have nothing to
extract. Hence `duckle.desktop` here, and the icons installed explicitly.

## 4. Desktop integration: what was checked

| Item | State |
| :--- | :--- |
| `.desktop` file | **Added here**, as a local file beside the PKGBUILD rather than fetched from the tag. It did not exist before - the bare binary had no menu entry at all - so fetching it from `v${pkgver}` 404s for every release made before it was written. The CI job below caught exactly that. |
| Icons | **Completed.** `apps/desktop/icons/` had 32/64/128; 16, 48, 256 and 512 added. The PKGBUILD does not fetch them size by size - it derives every size from the 512px master at build time, because the master is the only icon guaranteed to exist at any given tag. |
| XDG paths | **Verified correct, in the code.** Both the desktop app and the runner resolve Windows→`APPDATA`, macOS→`~/Library/Application Support`, and everything else→`XDG_DATA_HOME` falling back to `~/.local/share`, then `io.duckle.app`. The macOS branch is `cfg!`-gated, so there is no macOS-first path leaking onto Linux. |
| `StartupWMClass` | **Unverified.** Set to `duckle` to match the installed binary name, which is what GTK reports as WM_CLASS. Confirm with `xprop WM_CLASS` or `hyprctl clients` before relying on window grouping under Hyprland. |
| First-run network fetch | **Unverified.** Duckle fetches the DuckDB CLI on first launch, and the local model separately. Needs testing in a clean Arch container with no caches - different XDG defaults are exactly where this breaks, and a silent failure here is the likeliest source of "doesn't work" reports. |

## 5. What has to happen before submitting

1. **Build both, on Arch.** CI does this now on every change here. To reproduce
   locally:

   ```bash
   podman run --rm -it -v "$PWD:/src" archlinux:base-devel bash -c '
     pacman -Syu --noconfirm base-devel git namcap &&
     useradd -m build && chown -R build /src &&
     su build -c "cd /src/packaging/arch/duckle-runner-bin && makepkg -si --noconfirm" &&
     namcap /src/packaging/arch/duckle-runner-bin/*.pkg.tar.zst'
   ```

   `namcap` is the lint AUR reviewers run. Fix what it reports before
   submitting, not after.

2. **Replace every `SKIP` checksum** with `updpkgsums`. The binary's value is
   already published per release in `SHA256SUMS.txt`, so it is verifiable
   against the release rather than trusted from this file.

3. **Dependency list: done, from evidence.** namcap reads the released
   binary's dynamic dependencies in CI, and the list in the PKGBUILD is now
   what it reported rather than what Tauri's documentation suggests. That
   removed `libayatana-appindicator` - Tauri names it for tray support, the
   binary never references it, and Duckle has no tray - and added `glib2`,
   `cairo`, `dbus` and `hicolor-icon-theme`. `glibc` and `libgcc` are reported
   too and deliberately omitted, being in `base`.

4. **Generate `.SRCINFO`** (`makepkg --printsrcinfo > .SRCINFO`). The AUR
   rejects a push without it.

5. **Test the first-run flow in a clean container**, per section 4.

## 6. Publishing, and keeping it alive

An AUR package is a bare git repo; pushing is publishing.

```bash
git clone ssh://aur@aur.archlinux.org/duckle-runner-bin.git
# add PKGBUILD + .SRCINFO, commit, push
```

Then test the real end-user path - `omarchy-pkg-aur-install` from Omarchy's own
Install menu, and launching from Walker - rather than only `yay -S`.

**Automate the version bump.** Every release changes `pkgver` and its
checksums. That belongs in the release workflow beside the step that publishes
`SHA256SUMS.txt`, or the package silently falls behind, gets flagged
out-of-date, and eventually orphaned.

## 7. Bundled inclusion (stretch, do not block on it)

OPR has no public submission process. The realistic sequence is AUR first,
visible install numbers and community mentions second, and only then a GitHub
issue on `basecamp/omarchy` making the case with usage data rather than
speculatively. Community storefronts such as `omarchy-plugins` are a
lower-friction visibility channel in the meantime.

## 8. Ongoing

- [ ] Each release: bump `pkgver`, refresh checksums, regenerate `.SRCINFO`, push
- [ ] Watch AUR comments - Omarchy users are a subset of a wider Arch audience
      (CachyOS, EndeavourOS) who will hit different environments
- [ ] Re-check `.desktop`, icons and XDG behaviour after any Tauri major bump
- [ ] Periodically re-run the full `omarchy-pkg-aur-install` → launch → first-run
      path on a current Omarchy release

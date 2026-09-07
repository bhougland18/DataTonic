# Arch Linux packaging

Draft packaging for Arch, and the route to Omarchy.

**Status: written, not yet built.** These PKGBUILDs have not been run through
`makepkg` - that needs an Arch machine or container, and neither exists in this
repo's CI yet. Treat them as a starting point that still has to be built once
before submission. The verification step is in section 4.

---

## 1. Which route

**AUR, not the official repositories.** `[extra]` requires an Arch package
maintainer to adopt the software; there is no self-service path and no useful
way to accelerate it. The AUR is where Arch users expect third-party
applications to be, it is self-service, and `yay`/`paru` install from it with no
extra configuration. It is also the prerequisite for Omarchy (section 3).

## 2. Two packages, not one

| Package | What it installs | Dependencies |
| :--- | :--- | :--- |
| `duckle-runner-bin` | The headless runner | **none** - statically linked against musl |
| `duckle-bin` | The desktop application | `webkit2gtk-4.1 gtk3 libsoup3 libayatana-appindicator` |

Split because they have nothing in common at install time. A server wants the
runner and should not pull in a browser engine to get it; a laptop wants the
editor. `duckle-bin` lists the runner as an `optdepends` so the connection is
discoverable without being forced.

`unixodbc` is deliberately absent from both. The release workflow refuses to
publish a Linux binary that requires `libodbc.so`, so ODBC support is linked in
statically - that check exists because a build once shipped needing it.

## 3. Omarchy

Omarchy is an opinionated Arch setup; getting included means a pull request to
its repository adding Duckle to the installable set. It installs through
`pacman`/`yay`, so **being in the AUR is the prerequisite**, not a parallel
track. The order is: publish both AUR packages, let them settle, then propose
the addition with the AUR package name.

Worth being realistic: Omarchy's list is curated and deliberately short. The
case for Duckle there is the desktop editor being genuinely local-first with no
account and no telemetry, which fits that project's stated position better than
most data tooling does.

## 4. What has to happen before submitting

1. **Build both, on Arch.** Nothing here has been through `makepkg`:

   ```bash
   podman run --rm -it -v "$PWD:/src" archlinux:base-devel bash -c '
     pacman -Syu --noconfirm base-devel git namcap &&
     useradd -m build && chown -R build /src &&
     su build -c "cd /src/packaging/arch/duckle-runner-bin && makepkg -si --noconfirm" &&
     namcap /src/packaging/arch/duckle-runner-bin/*.pkg.tar.zst'
   ```

   `namcap` is the lint Arch reviewers run; fix what it reports before
   submitting rather than after.

2. **Replace every `SKIP` checksum.** The values are already published per
   release in `SHA256SUMS.txt`, so they can be taken from there and are
   verifiable against the release rather than trusted from this file.
   `updpkgsums` fills them in automatically.

3. **Confirm the desktop dependency list against the actual binary**, rather
   than against Tauri's documentation:

   ```bash
   ldd Duckle-linux-x64 | awk '{print $1}' | sort -u
   ```

   Then map each `.so` to its owning package with `pacman -F`. The list in the
   PKGBUILD is Tauri v2's usual set and is the most likely thing here to be
   wrong.

4. **Generate `.SRCINFO`** (`makepkg --printsrcinfo > .SRCINFO`); the AUR
   rejects a push without it.

5. **Automate the version bump.** Every release changes `pkgver` and six
   checksums. That belongs in the release workflow, next to the step that
   publishes `SHA256SUMS.txt`, or the AUR package will silently fall behind.

## 5. The gap this exposed

The Linux release is a **bare binary**, not a bundle - no `.desktop` entry and
no icons. Anyone who downloads it today gets an executable with no menu entry,
no icon, and no MIME association. `duckle.desktop` here is the first of those to
exist; it is installed by the PKGBUILD, and it should probably be installed by
whatever the non-Arch Linux instructions tell people to do as well.

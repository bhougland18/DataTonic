#!/usr/bin/env python3
"""Point the Arch PKGBUILDs at a released version, checksums included.

Run from the repository root:

    python packaging/arch/bump.py 0.7.1          # rewrite in place
    python packaging/arch/bump.py 0.7.1 --check  # report, change nothing

Every release changes `pkgver` and every checksum. Doing that by hand is how an
AUR package silently falls behind, gets flagged out-of-date, and is eventually
orphaned - so this exists to be run by the release workflow rather than
remembered.

Two sources of truth, deliberately:

* The three published binaries are read from the release's own
  **SHA256SUMS.txt**, so the PKGBUILD carries the same value the release
  publishes rather than one this script computed separately. If they disagreed,
  the release would be the one that is right.
* Everything else - the local desktop entry, the icon and the licence files -
  is hashed from its actual bytes.

`updpkgsums` is not used: it resolves `source_$CARCH` for the machine it runs
on, so an x86_64 runner would leave the aarch64 checksum stale, and a stale
checksum on one architecture is worse than no automation because it fails only
for the people who have that hardware.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
ARCH = ROOT / "packaging" / "arch"
REPO = "slothflowlabs/duckle"
PACKAGES = ("duckle-runner-bin", "duckle-bin")

# Release asset -> the PKGBUILD array its checksum belongs in.
ARCH_ASSETS = {
    "Duckle-linux-x64": "sha256sums_x86_64",
    "Duckle-linux-arm64": "sha256sums_aarch64",
}


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def published_sums(version: str) -> dict[str, str]:
    """The release's own SHA256SUMS.txt, as {asset: sha256}."""
    url = f"https://github.com/{REPO}/releases/download/v{version}/SHA256SUMS.txt"
    try:
        body = fetch(url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # By far the likeliest reason, and worth saying rather than
            # printing a traceback: the release workflow creates a DRAFT, and a
            # draft's assets are not downloadable until someone publishes it.
            raise SystemExit(
                f"no SHA256SUMS.txt at v{version}. Is the release published "
                f"rather than still a draft?"
            ) from None
        raise SystemExit(f"fetching SHA256SUMS.txt for v{version}: {e}") from None
    out: dict[str, str] = {}
    for line in body.decode("utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2:
            out[parts[1].lstrip("*")] = parts[0]
    if not out:
        raise SystemExit(f"SHA256SUMS.txt at v{version} listed nothing")
    return out


def expand(entry: str, text: str, version: str) -> str:
    """Resolve the shell variables a source entry is written in terms of."""
    url = re.search(r'^url="([^"]+)"', text, re.M)
    out = entry.replace("${pkgver}", version)
    if url:
        out = out.replace("${url}", url.group(1))
    return out


def source_entries(text: str, array: str) -> list[str]:
    """The entries of a bash array, in order, unquoted."""
    m = re.search(rf"^{array}=\((.*?)\)$", text, re.S | re.M)
    if not m:
        return []
    return re.findall(r"""['"]([^'"]+)['"]""", m.group(1))


def digest_for(entry: str, pkgdir: pathlib.Path, version: str,
               sums: dict[str, str]) -> str:
    """One source entry's sha256: from the release, from disk, or fetched."""
    target = entry.split("::", 1)[-1]
    if not target.startswith(("http://", "https://")):
        # A local file committed beside the PKGBUILD.
        return hashlib.sha256((pkgdir / target).read_bytes()).hexdigest()
    asset = target.rsplit("/", 1)[-1]
    if asset in sums:
        # Prefer what the release itself published over hashing it again.
        return sums[asset]
    return hashlib.sha256(fetch(target.replace("${pkgver}", version))).hexdigest()


def replace_array(text: str, array: str, values: list[str]) -> str:
    if not values:
        return text
    body = "\n".join(f"            '{v}'" for v in values).lstrip()
    return re.sub(
        rf"^{array}=\(.*?\)$",
        f"{array}=({body})",
        text,
        count=1,
        flags=re.S | re.M,
    )


def bump(pkg: str, version: str, sums: dict[str, str], check: bool) -> bool:
    pkgdir = ARCH / pkg
    path = pkgdir / "PKGBUILD"
    original = path.read_text(encoding="utf-8")
    text = original

    text = re.sub(r"^pkgver=.*$", f"pkgver={version}", text, count=1, flags=re.M)
    # A new version starts at release 1; pkgrel only increments when the
    # packaging changes for a version that is already out.
    text = re.sub(r"^pkgrel=.*$", "pkgrel=1", text, count=1, flags=re.M)

    # Entries are written in terms of ${url} and ${pkgver}; resolve both before
    # fetching, or the "URL" is a literal that looks like a local path.
    for array, sums_array in (
        ("source", "sha256sums"),
        ("source_x86_64", "sha256sums_x86_64"),
        ("source_aarch64", "sha256sums_aarch64"),
    ):
        entries = source_entries(text, array)
        if not entries:
            continue
        digests = [
            digest_for(expand(e, text, version), pkgdir, version, sums)
            for e in entries
        ]
        text = replace_array(text, sums_array, digests)

    if any(d == "SKIP" for d in re.findall(r"'(SKIP)'", text)):
        raise SystemExit(f"{pkg}: a checksum is still SKIP after bumping")

    if text == original:
        print(f"  {pkg}: already at {version}")
        return False
    if check:
        print(f"  {pkg}: WOULD change (pkgver -> {version}, checksums refreshed)")
        return True
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"  {pkg}: pkgver -> {version}, checksums refreshed")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("version", help="release version, without the leading v")
    ap.add_argument("--check", action="store_true",
                    help="report what would change and write nothing")
    args = ap.parse_args()
    version = args.version.lstrip("v")

    print(f"reading SHA256SUMS.txt from the v{version} release")
    sums = published_sums(version)
    for asset in ARCH_ASSETS:
        if asset not in sums:
            raise SystemExit(f"the release does not list {asset}")
    print(f"  {len(sums)} assets listed")

    changed = [bump(p, version, sums, args.check) for p in PACKAGES]
    return 1 if (args.check and any(changed)) else 0


if __name__ == "__main__":
    sys.exit(main())

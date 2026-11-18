"""Step 1 (fetch): clone/pull 5etools-src and pull Open5e SRD data into the
gitignored cache. After this runs once, the rest of the build is offline."""
import json
import os
import subprocess
import sys
import time
import urllib.request

from util import CACHE, OPEN5E

TOOLS_REPO = "https://github.com/5etools-mirror-3/5etools-src.git"
TOOLS_DIR = os.path.join(CACHE, "5etools-src")

API = "https://api.open5e.com/v1"
# SRD-only documents in Open5e.
SRD = "wotc-srd"
# category -> endpoint; we keep the SRD slice of each.
OPEN5E_ENDPOINTS = {
    "spells": "spells",
    "races": "races",
    "backgrounds": "backgrounds",
    "classes": "classes",
    "feats": "feats",
    "magicitems": "magicitems",
}


def sh(args, cwd=None):
    print("  $", " ".join(args))
    return subprocess.run(args, cwd=cwd, check=True)


def fetch_5etools():
    os.makedirs(CACHE, exist_ok=True)
    if os.path.isdir(os.path.join(TOOLS_DIR, ".git")):
        print("[fetch] updating 5etools-src clone")
        try:
            sh(["git", "pull", "--ff-only"], cwd=TOOLS_DIR)
        except subprocess.CalledProcessError:
            print("  (pull failed; using existing clone)")
    else:
        print("[fetch] cloning 5etools-src (shallow)")
        sh(["git", "clone", "--depth", "1", TOOLS_REPO, TOOLS_DIR])


def _get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "dnd-build/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - network is best-effort
            last = e
            print("  retry %d: %s" % (i + 1, e))
            time.sleep(2 * (i + 1))
    raise last


def fetch_open5e(force=False):
    os.makedirs(OPEN5E, exist_ok=True)
    for name, endpoint in OPEN5E_ENDPOINTS.items():
        out = os.path.join(OPEN5E, name + ".json")
        if os.path.exists(out) and not force:
            print("[fetch] open5e/%s cached" % name)
            continue
        results = []
        # filter to SRD at the API where supported; classes/feats endpoints
        # ignore the filter harmlessly, we re-filter in normalize anyway.
        url = "%s/%s/?format=json&limit=100&document__slug=%s" % (API, endpoint, SRD)
        page = 1
        while url:
            print("[fetch] open5e/%s page %d" % (name, page))
            data = _get(url)
            results.extend(data.get("results", []))
            url = data.get("next")
            page += 1
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(results, fh)
        print("  -> %d records" % len(results))


def main():
    force = "--force-open5e" in sys.argv
    skip_tools = "--skip-5etools" in sys.argv
    if not skip_tools:
        fetch_5etools()
    fetch_open5e(force=force)
    print("[fetch] done")


if __name__ == "__main__":
    main()

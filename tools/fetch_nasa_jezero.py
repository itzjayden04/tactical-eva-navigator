"""
Build TEVAN's real-data Jezero dataset from public NASA / USGS sources.

    pip install rasterio numpy scipy scikit-image pillow
    python tools/fetch_nasa_jezero.py --out public/data/nasa-jezero

Sources (all public, no key needed):
  * Elevation  USGS Astrogeology / NASA JPL Mars 2020 Terrain Relative Navigation
               HiRISE DTM mosaic, 1 m/px (JEZ_hirise_soc_006 ... blend40.tif)
  * Imagery    Mars 2020 TRN HiRISE orthomosaic, 25 cm/px (JEZ_hirise_soc_006 ... first.tif)
               https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/
               (the same products NASA Mars Trek and the USGS Astrogeology hub serve)
  * Rover      Perseverance traverse + waypoints, NASA/JPL MMGIS
               https://mars.nasa.gov/mmgis-maps/M20/Layers/json/

Only a 4 x 4 km window is read (HTTP range requests through GDAL), so the
multi-gigabyte mosaics are never downloaded whole. The window is centred
1200 m west and 400 m north of the Octavia E. Butler landing site, which
puts the landing site, Seitah's northern margin, the delta front and the
first ~700 sols of Perseverance's route inside the map.

Output: public/data/nasa-jezero/
  manifest.json      grids + layers + credits
  elevation.f32      513x513 Float32, metres (MOLA areoid), row 0 = north
  rocks.f32          257x257 roughness 0..1 (from 1 m DTM detrended std-dev)
  radiation.f32      257x257 GCR dose rate, µSv/h, real sky-view factor
  dust.f32           257x257 aeolian dust index (low ground + bright ripple sand)
  ortho.jpg          4096x4096 HiRISE orthophoto (≈0.98 m/px), north up
  ortho_map.jpg      1024x1024 copy for the minimap
  traverse.json      Perseverance route in local metres with sol numbers
  layout.json        EVA nodes / tracks / POIs placed on the real terrain
"""
import argparse
import json
import math
import os
import urllib.request

import numpy as np

R = 3396190.0  # Mars 2000 sphere (IAU), as used by the TRN products
K = math.pi / 180
LAT0, LON0 = 18.44462715, 77.45088573  # Octavia E. Butler landing site (sol 13 waypoint)
COS0 = math.cos(LAT0 * K)
X0, Y0 = R * LON0 * K, R * LAT0 * K  # equirectangular (lat_ts = 0) metres
CE, CN, SIZE = -1200.0, 400.0, 4000.0  # window centre relative to the landing site, size (m)

S3 = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/"
DTM = S3 + "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
ORTHO = S3 + "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif"
MMGIS = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/"


def to_local(lon, lat):
    """lon/lat (deg) → local east/north metres, origin = window centre."""
    return R * (lon - LON0) * K * COS0 - CE, R * (lat - LAT0) * K - CN


def _get_range(url, a, b, ctx, tries=5):
    import time
    import urllib.request

    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={a}-{b - 1}"})
            with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
                return r.read()
        except Exception:
            if t == tries - 1:
                raise
            time.sleep(1.5 * (t + 1))


def read_window(url, n, cache):
    """Read an n x n nearest-neighbour sample of the study window.

    The TRN mosaics are uncompressed one-row strips, so each needed row is
    fetched as a single HTTP range covering only the window's columns (≈70 MB
    for the 4096² orthophoto instead of the 7 GB file). Other layouts fall
    back to a plain rasterio read.
    """
    if os.path.exists(cache):
        return np.load(cache)
    import ssl
    from concurrent.futures import ThreadPoolExecutor

    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    h = SIZE / 2
    with rasterio.open("/vsicurl/" + url) as src:
        # true metres east → equirectangular metres: divide by cos(lat)
        win = from_bounds(X0 + (CE - h) / COS0, Y0 + CN - h, X0 + (CE + h) / COS0, Y0 + CN + h, src.transform)
        o0 = src.get_tag_item("BLOCK_OFFSET_0_0", "TIFF", bidx=1)
        o1 = src.get_tag_item("BLOCK_OFFSET_0_1", "TIFF", bidx=1)
        sz = src.get_tag_item("BLOCK_SIZE_0_0", "TIFF", bidx=1)
        dt = np.dtype(src.dtypes[0])
        simple = src.block_shapes[0][0] == 1 and o0 and o1 and int(o1) - int(o0) == int(sz) == src.width * dt.itemsize
        if not simple:
            a = src.read(1, window=win, out_shape=(n, n), resampling=Resampling.nearest)
            np.save(cache, a)
            return a
        o0, stride, width = int(o0), int(sz), src.width
    rows = [int(win.row_off + (i + 0.5) * win.height / n) for i in range(n)]
    cols = np.array([int(win.col_off + (j + 0.5) * win.width / n) for j in range(n)])
    c0, c1 = int(cols.min()), int(cols.max()) + 1
    ctx = ssl.create_default_context(cafile=os.environ.get("CURL_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE"))
    out = np.zeros((n, n), dt)

    def one(i):
        off = o0 + rows[i] * stride + c0 * dt.itemsize
        buf = _get_range(url, off, off + (c1 - c0) * dt.itemsize, ctx)
        out[i] = np.frombuffer(buf, dt.newbyteorder("<"))[cols - c0]

    with ThreadPoolExecutor(24) as ex:
        for k, _ in enumerate(ex.map(one, range(n))):
            if k % 512 == 0:
                print(f"  row {k}/{n}", flush=True)
    np.save(cache, out)
    return out


def resize(a, n):
    from scipy import ndimage

    f = (a.shape[0] - 1) / (n - 1)
    if f > 1:
        a = ndimage.gaussian_filter(a, f * 0.5)
    yy, xx = np.mgrid[0:n, 0:n] * f
    return ndimage.map_coordinates(a, [yy, xx], order=1, mode="nearest").astype(np.float32)


def grid_meta(fname, n, units):
    return {"file": fname, "width": n, "height": n, "originE": -SIZE / 2, "originN": SIZE / 2, "cell": SIZE / (n - 1), "units": units}


def sky_view_dose(elev, base=28.0):
    """GCR dose rate scaled by the real sky-view factor (horizon scan, 16 azimuths)."""
    n = elev.shape[0]
    cell = SIZE / (n - 1)
    from scipy import ndimage

    out = np.zeros_like(elev)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    h0 = elev + 1.7
    blocked = np.zeros_like(elev)
    dirs = 16
    for k in range(dirs):
        a = k / dirs * 2 * math.pi
        mx = np.zeros_like(elev)
        s = 10.0
        while s <= 600:
            dx, dy = math.cos(a) * s / cell, -math.sin(a) * s / cell
            h = ndimage.map_coordinates(elev, [yy + dy, xx + dx], order=1, mode="nearest")
            mx = np.maximum(mx, (h - h0) / s)
            s *= 1.25
        blocked += np.sin(np.arctan(mx))
    svf = 1 - 0.5 * blocked / dirs
    out = base * svf * (1 + 0.09 * (h0 + 2600) / 1000)
    return out.astype(np.float32)


def route(cost, a, b, cell):
    from skimage.graph import route_through_array

    ij = lambda p: (int(round((SIZE / 2 - p[1]) / cell)), int(round((p[0] + SIZE / 2) / cell)))
    path, _ = route_through_array(cost, ij(a), ij(b), fully_connected=True, geometric=True)
    return [(-SIZE / 2 + j * cell, SIZE / 2 - i * cell) for i, j in path]


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a
    L = np.hypot(*ab) or 1e-9
    d = [abs(ab[0] * (p[1] - a[1]) - ab[1] * (p[0] - a[0])) / L for p in pts[1:-1]]
    i = int(np.argmax(d)) + 1
    if d[i - 1] > eps:
        return rdp(pts[: i + 1], eps)[:-1] + rdp(pts[i:], eps)
    return [pts[0], pts[-1]]


# ---------------------------------------------------------------- EVA layout
# Positions are local metres (origin = window centre; landing site at 1200,-400).
NODES = {
    "HAB": (1200, -400, "Habitat · OEB Landing Site"),
    "JA": (1150, -900, "Junction Alpha"),
    "S1": (650, -1120, "Séítah Margin Outcrop"),
    "SH": (560, 330, "Crater Wall Shelter"),
    "JB": (-250, 420, "Junction Bravo"),
    "S2": (-1250, 280, "Delta Front Outcrop"),
    "CR": (-500, 900, "Delta Top Relay Point"),
}
# id: (a, b, name, surface, waypoints, description, mode)  mode: route | direct | traverse
EDGES = {
    "E1": ("HAB", "JA", "Egress Path", "regolith", [], "Beside Perseverance's first drive south", "route"),
    "E2": ("JA", "S1", "Séítah Ridge Traverse", "boulders", [(980, -1230)], "Firm footing but crosses rough ridged bedrock", "route"),
    "E3": ("JA", "S1", "Ripple Field Shortcut", "soft_sand", [], "Shorter and flat, but across aeolian ripples", "direct"),
    "E4": ("JA", "SH", "Crater Approach", "regolith", [(950, -250)], "", "route"),
    "E5": ("S1", "SH", "Floor Trail", "regolith", [(420, -420)], "", "route"),
    "E6": ("S1", "JB", "Western Floor", "regolith", [(80, -420)], "", "route"),
    "E7": ("SH", "JB", "Northern Plains", "regolith", [], "", "route"),
    "E8": ("JB", "S2", "Scarp Toe Direct", "slope_scree", [(-760, 520)], "Direct, steep, along the delta scarp toe", "direct"),
    "E9": ("JB", "S2", "Perseverance Track", "regolith", [(-830, 200)], "Along the rover's own route to the delta front: longer, gentle", "route"),
    "E10": ("S2", "HAB", "Southern Return", "regolith", [(-800, -250), (-50, -700), (700, -720)], "Long walk home across the crater floor", "route"),
    "E11": ("JB", "CR", "Delta Climb", "slope_scree", [], "Climbs ~70 m onto the delta top", "route"),
    "E12": ("CR", "SH", "Relay Descent", "regolith", [(300, 750)], "", "route"),
}


def nearest_idx(poly, p):
    d = [math.dist(q, p) for q in poly]
    return int(np.argmin(d))


def build_layout(elev2, rough, trav_pts, cell):
    from scipy import ndimage

    sm = ndimage.uniform_filter(elev2, 3)
    gy, gx = np.gradient(sm, cell)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    cost = 1 + (slope / 10) ** 2 + 4 * rough
    cost[slope > 30] = 1e4
    xy = lambda nid: NODES[nid][:2]
    edges = []
    for eid, (a, b, name, surf, wps, desc, mode) in EDGES.items():
        stops = [xy(a)] + wps + [xy(b)]
        if mode == "traverse":
            i, j = nearest_idx(trav_pts, xy(a)), nearest_idx(trav_pts, xy(b))
            lo, hi = min(i, j), max(i, j)
            pa, pb = (xy(a), xy(b)) if i < j else (xy(b), xy(a))
            # skip the rover's loops near the ends: start at the LAST pass by the first end,
            # stop at the FIRST arrival at the second end
            near = lambda k, p: math.dist(trav_pts[k], p) <= math.dist(trav_pts[lo if p is pa else hi], p) + 25
            lo = max(k for k in range(lo, hi + 1) if near(k, pa))
            hi = min(k for k in range(lo, hi + 1) if near(k, pb))
            seg = trav_pts[lo: hi + 1]
            if i > j:
                seg = seg[::-1]
            pts = [xy(a)] + seg + [xy(b)]
        elif mode == "direct":
            pts = stops
        else:
            pts = []
            for p, q in zip(stops, stops[1:]):
                pts += route(cost, p, q, cell)
        via = rdp([tuple(map(float, p)) for p in pts], 7)[1:-1]
        # drop control points that crowd each other: the spline through them would curl
        thin = []
        for p in via:
            if math.dist(p, thin[-1] if thin else xy(a)) >= 22 and math.dist(p, xy(b)) >= 22:
                thin.append(p)
        via = thin
        e = {"id": eid, "name": name, "a": a, "b": b, "via": [[round(x, 1), round(y, 1)] for x, y in via], "surface": surf}
        if desc:
            e["description"] = desc
        edges.append(e)
    nodes = [{"id": k, "name": v[2], "e": v[0], "n": v[1]} for k, v in NODES.items()]
    pois = [
        {"id": "hab", "kind": "habitat", "name": "Habitat", "e": 1200, "n": -400, "shielding": 0.02, "radius": 12, "note": "Pressurised habitat at the Octavia E. Butler landing site (Perseverance touchdown, 18 Feb 2021)"},
        {"id": "s1", "kind": "sample", "name": "Séítah Margin Outcrop", "e": 650, "n": -1120, "note": "Olivine-rich igneous bedrock at the northern edge of Séítah, where Perseverance cored its early samples"},
        {"id": "s2", "kind": "sample", "name": "Delta Front Outcrop", "e": -1250, "n": 280, "note": "Layered fluvial-deltaic sediments at the base of the western delta front"},
        {"id": "shelter", "kind": "shelter", "name": "Crater Wall Shelter", "e": 560, "n": 330, "shielding": 0.35, "radius": 45, "note": "Inner wall of a ~150 m impact crater blocks part of the sky"},
        {"id": "relay", "kind": "comms", "name": "Delta Top Relay Point", "e": -500, "n": 900, "note": "~70 m above the floor: line of sight to the habitat and orbiters"},
        {"id": "cache-a", "kind": "cache", "name": "Supply Cache Alpha", "e": 590, "n": 300, "note": "Pre-placed O2, water and battery pack at the shelter"},
        {"id": "cache-b", "kind": "cache", "name": "Supply Cache Bravo", "e": -230, "n": 395, "note": "Pre-placed O2, water and battery pack at Junction Bravo"},
        {"id": "kodiak", "kind": "landmark", "name": "Kodiak", "e": -1200, "n": -800, "note": "Isolated butte, an erosional remnant of the delta, ~60 m tall"},
        {"id": "hz-boulder", "kind": "hazard", "name": "Séítah Ridges", "e": 900, "n": -1220, "radius": 200, "note": "Rough ridged bedrock: slip and trip risk"},
        {"id": "hz-sand", "kind": "hazard", "name": "Ripple Field", "e": 880, "n": -1000, "radius": 120, "note": "Aeolian ripples: high sinkage"},
        {"id": "hz-rim", "kind": "hazard", "name": "Delta Scarp Scree", "e": -760, "n": 560, "radius": 220, "note": "Loose debris below the delta scarp, slopes over 25°"},
    ]
    for n in nodes:
        n["poiId"] = {"HAB": "hab", "S1": "s1", "S2": "s2", "SH": "shelter", "CR": "relay"}.get(n["id"])
        if not n["poiId"]:
            del n["poiId"]
    return {"nodes": nodes, "edges": edges, "pois": pois}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/data/nasa-jezero")
    ap.add_argument("--cache", default=".nasa-cache")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.cache, exist_ok=True)
    from PIL import Image
    from scipy import ndimage

    print("DTM window (1 m HiRISE, read at 2 m)…")
    dtm = read_window(DTM, 2001, os.path.join(a.cache, "dtm_2001.npy")).astype(np.float32)
    bad = (dtm < -9000) | ~np.isfinite(dtm)
    if bad.any():
        dtm[bad] = np.nanmean(np.where(bad, np.nan, dtm))
    cell2 = SIZE / 2000

    elev = resize(dtm, 513)
    elev.astype("<f4").tofile(os.path.join(a.out, "elevation.f32"))
    # roughness: std-dev of the 2 m surface after removing a 20 m trend
    det = dtm - ndimage.uniform_filter(dtm, 10)
    rough = np.sqrt(ndimage.uniform_filter(det * det, 6))
    rough_n = np.clip((rough - 0.05) / 0.6, 0, 1)
    rocks = resize(rough_n, 257)
    rocks.astype("<f4").tofile(os.path.join(a.out, "rocks.f32"))
    rad = sky_view_dose(resize(dtm, 257))
    rad.astype("<f4").tofile(os.path.join(a.out, "radiation.f32"))
    print(f"elevation {elev.min():.1f}..{elev.max():.1f} m  dose {rad.min():.1f}..{rad.max():.1f} µSv/h")

    print("Orthophoto window (25 cm HiRISE, read at ~1 m)…")
    ortho = read_window(ORTHO, 4096, os.path.join(a.cache, "ortho_4096.npy")).astype(np.float32)
    valid = ortho > 0
    lo, hi = np.percentile(ortho[valid], [0.5, 99.5]) if valid.any() else (0, 255)
    o8 = np.clip((ortho - lo) / (hi - lo) * 255, 0, 255)
    o8[~valid] = 128
    Image.fromarray(o8.astype(np.uint8)).save(os.path.join(a.out, "ortho.jpg"), quality=84, optimize=True)
    Image.fromarray(o8.astype(np.uint8)).resize((1024, 1024), Image.LANCZOS).save(os.path.join(a.out, "ortho_map.jpg"), quality=85)
    # dust: low ground + bright (sandy) albedo
    bright = resize(ndimage.gaussian_filter(o8, 12), 257) / 255
    low = np.clip((-2550 - resize(dtm, 257)) / 30, 0, 1)
    dust = (0.3 + 0.8 * low + 1.2 * np.clip(bright - 0.45, 0, 1) * 2).astype(np.float32)
    dust.astype("<f4").tofile(os.path.join(a.out, "dust.f32"))

    print("Perseverance traverse…")
    tj = os.path.join(a.cache, "M20_traverse.json")
    wj = os.path.join(a.cache, "M20_waypoints.json")
    for url, p in ((MMGIS + "M20_traverse.json", tj), (MMGIS + "M20_waypoints.json", wj)):
        if not os.path.exists(p):
            urllib.request.urlretrieve(url, p)
    inside = lambda e, n, m=0: abs(e) <= SIZE / 2 + m and abs(n) <= SIZE / 2 + m
    path, sols = [], []
    for f in json.load(open(tj))["features"]:
        for lon, lat, *_ in f["geometry"]["coordinates"]:
            e, n = to_local(lon, lat)
            if inside(e, n, 300) and (not path or math.dist(path[-1], (e, n)) > 4):
                path.append((e, n))
                sols.append(f["properties"]["sol"])
    # keep only the first continuous pass (sols up to the delta-front campaign)
    cut = next((i for i, s in enumerate(sols) if s > 760), len(sols))
    path, sols = path[:cut], sols[:cut]
    simp = rdp(path, 1.5)
    keep = {p: s for p, s in zip(path, sols)}
    traverse = {"points": [[round(e, 1), round(n, 1), keep[(e, n)]] for e, n in simp]}
    wps = []
    for f in json.load(open(wj))["features"]:
        p = f["properties"]
        e, n = to_local(p["lon"], p["lat"])
        if inside(e, n) and p["sol"] <= 760:
            pano = next((im["url"] for im in (p.get("images") or []) if im.get("isPanoramic")), None)
            wps.append({"sol": p["sol"], "e": round(e, 1), "n": round(n, 1), "elev": round(p["elev_geoid"], 1), "pano": ("https://mars.nasa.gov/mmgis-maps/M20/" + pano) if pano else None})
    traverse["waypoints"] = wps
    json.dump(traverse, open(os.path.join(a.out, "traverse.json"), "w"), separators=(",", ":"))

    print("EVA layout on real terrain…")
    layout = build_layout(dtm, rough_n, [(e, n) for e, n in path], cell2)
    json.dump(layout, open(os.path.join(a.out, "layout.json"), "w"), indent=1)

    manifest = {
        "label": "NASA JEZERO · HiRISE",
        "grids": {
            "elevation": grid_meta("elevation.f32", 513, "m"),
            "rocks": grid_meta("rocks.f32", 257, "0..1"),
            "radiation": grid_meta("radiation.f32", 257, "µSv/h"),
            "dust": grid_meta("dust.f32", 257, "index"),
        },
        "imagery": {"file": "ortho.jpg", "map": "ortho_map.jpg", "originE": -SIZE / 2, "originN": SIZE / 2, "sizeE": SIZE, "sizeN": SIZE},
        "traverse": "traverse.json",
        "layout": "layout.json",
        "geo": {"lat0": LAT0, "lon0": LON0, "offsetE": -CE, "offsetN": -CN, "radius": R},
        "conditions": {"surfaceTempC": -63, "dustTau": 0.6, "gcrDoseRateuSvH": 28},
        "credits": [
            "Elevation: HiRISE DTM mosaic, Mars 2020 TRN (NASA/JPL-Caltech/UArizona/USGS)",
            "Imagery: HiRISE orthomosaic, Mars 2020 TRN (NASA/JPL-Caltech/UArizona/USGS)",
            "Rover route: Perseverance traverse, NASA/JPL MMGIS",
            "Raw images: NASA/JPL-Caltech Mars 2020 raw image feed",
        ],
    }
    json.dump(manifest, open(os.path.join(a.out, "manifest.json"), "w"), indent=2, ensure_ascii=False)
    print("wrote", a.out)


if __name__ == "__main__":
    main()

"""
Convert NASA rasters (GeoTIFF) into the simulator's static-grid format.

Usage (hackathon day, 14 Nov 2026):
    pip install rasterio numpy
    python tools/convert_geotiff.py --out public/data/nasa-jezero \
        --elevation path/to/jezero_dtm.tif \
        --radiation path/to/dose_map.tif      (optional) \
        --dust path/to/dust.tif               (optional) \
        --magnetic path/to/crustal_field.tif  (optional) \
        --center-e <easting_m> --center-n <northing_m> --size 4000 --cells 257 \
        --label "NASA JEZERO (Space Apps 2026)"

Then open the app with  ?data=nasa-jezero
Layers you don't pass fall back to the synthetic ones. The mission tracks
(src/data/mockJezero.ts MISSION) are in local metres around the centre, so
re-place nodes on the real terrain by exporting a mission.json if needed.
"""
import argparse
import json
import os

import numpy as np


def resample(path, center_e, center_n, size, cells):
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    half = size / 2
    with rasterio.open(path) as src:
        win = from_bounds(center_e - half, center_n - half, center_e + half, center_n + half, src.transform)
        data = src.read(1, window=win, out_shape=(cells, cells), resampling=Resampling.bilinear, boundless=True, fill_value=np.nan)
    data = data.astype(np.float32)
    if np.isnan(data).any():
        data = np.where(np.isnan(data), np.nanmean(data), data)
    return data  # row 0 = north (raster convention)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--elevation", required=True)
    ap.add_argument("--radiation")
    ap.add_argument("--dust")
    ap.add_argument("--magnetic")
    ap.add_argument("--rocks")
    ap.add_argument("--center-e", type=float, required=True, help="projected easting of study-area centre (m)")
    ap.add_argument("--center-n", type=float, required=True, help="projected northing of study-area centre (m)")
    ap.add_argument("--size", type=float, default=4000)
    ap.add_argument("--cells", type=int, default=257)
    ap.add_argument("--label", default="NASA JEZERO")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cell = a.size / (a.cells - 1)
    meta_base = {"width": a.cells, "height": a.cells, "originE": -a.size / 2, "originN": a.size / 2, "cell": cell}
    units = {"elevation": "m", "radiation": "µSv/h", "dust": "index", "magnetic": "nT", "rocks": "0..1"}
    grids = {}
    for key in units:
        path = getattr(a, key)
        if not path:
            continue
        arr = resample(path, a.center_e, a.center_n, a.size, a.cells)
        fname = f"{key}.f32"
        arr.astype("<f4").tofile(os.path.join(a.out, fname))
        grids[key] = {"file": fname, **meta_base, "units": units[key]}
        print(f"{key}: min {arr.min():.2f} max {arr.max():.2f} -> {fname}")
    manifest = {"label": a.label, "grids": grids, "conditions": {"surfaceTempC": -63, "dustTau": 0.6, "gcrDoseRateuSvH": 28}}
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("wrote", os.path.join(a.out, "manifest.json"))


if __name__ == "__main__":
    main()

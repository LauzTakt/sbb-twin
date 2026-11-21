"""Railways outside Switzerland from OpenStreetMap (Overpass JSON) -> data/abroad-lines.geojson for the map.

Usage: python3 tools/prepare_abroad.py overpass.json
The Overpass query (bbox = the viewer's map bounds, Swiss area excluded) is in the README.
"""
import json
import sys
from pathlib import Path


def simplify(points, tol):
    """Douglas-Peucker on lon/lat pairs (tol in degrees)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            x, y = points[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def main(src):
    data = json.loads(Path(src).read_text())
    features = []
    for el in data.get("elements", []):
        if el.get("type") != "way" or not el.get("geometry"):
            continue
        pts = [(round(g["lon"], 5), round(g["lat"], 5)) for g in el["geometry"]]
        pts = simplify(pts, 0.00009)
        if len(pts) < 2:
            continue
        tags = el.get("tags", {})
        features.append({
            "type": "Feature",
            "properties": {"id": el["id"], "usage": tags.get("usage", ""), "gauge": tags.get("gauge", ""), "name": tags.get("name", "")},
            "geometry": {"type": "LineString", "coordinates": pts},
        })
    out = Path(__file__).resolve().parent.parent / "data" / "abroad-lines.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "attribution": "© OpenStreetMap contributors (ODbL)", "features": features}, separators=(",", ":")))
    print(f"{len(features)} lines -> {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1])

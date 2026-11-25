"""Straßennetz für den simulierten Autoverkehr der 3D-Karte (ort.json: bausteine.verkehr).

Eingabe : data/raw/gemeinde/osm/*.json (OpenStreetMap, ODbL; aus fetch.py osm)
Ausgabe : site/data/verkehr.js   window.AL_VERKEHR = {w: [[klasse, ort, x0,z0,x1,z1,...], ...], stand}
          klasse: 0 Bundesstraße/primary/trunk, 1 secondary (Landesstraße), 2 tertiary (Kreisstraße), 3 unclassified, 4 residential/living_street
          ort   : 1 = Mitte des Abschnitts liegt in einer Ortslage (Tempo 50 statt 80/100)
Feldwege (track), Wirtschafts-, Fuß- und Radwege sowie Zufahrten (service) fehlen bewusst: dort fährt die Simulation nicht.
Die Simulation ist keine Verkehrsmessung; Dichte und Tempo sind angenommen (js/ebenen.js, Abschnitt Verkehr).
Schalter: ort.json bausteine.verkehr (true/false, Standard aus). Ist er aus, endet das Skript ohne Arbeit.
Aufruf  : python scripts/prepare_verkehr.py   (ohne Netz, im Wochenlauf nach fetch.py osm)
"""
import datetime as dt, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
sys.stdout.reconfigure(encoding="utf-8")
from geo import ORT, pip, simplify, xz  # noqa: E402

BAUSTEIN = ORT.get("bausteine") or {}
KLASSE = {"trunk": 0, "primary": 0, "trunk_link": 0, "primary_link": 0, "secondary": 1, "secondary_link": 1, "tertiary": 2, "tertiary_link": 2,
          "unclassified": 3, "residential": 4, "living_street": 4}
ORTSLAGE = {"residential", "village_green", "retail", "commercial", "farmyard"}


def main():
    if not BAUSTEIN.get("verkehr"):
        print("Verkehr: ort.json bausteine.verkehr ist aus, uebersprungen")
        return 0
    import prepare_gemeinde as pg
    ways, areas, seen = [], [], set()
    d = os.path.join(ROOT, "data", "raw", "gemeinde", "osm")
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        with open(os.path.join(d, fn), encoding="utf-8") as fh:
            elems = json.load(fh)["elements"]
        for e in elems:
            if e["type"] != "way" or not e.get("geometry") or (e["type"], e["id"]) in seen:
                continue
            seen.add((e["type"], e["id"]))
            t = e.get("tags") or {}
            pts = [xz(g["lat"], g["lon"]) for g in e["geometry"]]
            if t.get("highway") in KLASSE and t.get("access") not in ("no", "private") and t.get("area") != "yes":
                ways.append((KLASSE[t["highway"]], pts))
            elif t.get("landuse") in ORTSLAGE and len(pts) > 3:
                xs, zs = [q[0] for q in pts], [q[1] for q in pts]
                areas.append((min(xs), min(zs), max(xs), max(zs), pts))

    def in_ort(x, z):
        return any(a[0] <= x <= a[2] and a[1] <= z <= a[3] and pip(x, z, a[4]) for a in areas)

    out, n_m = [], 0.0
    for k, pts in ways:
        # nur Abschnitte, die überwiegend im Gemeindegebiet liegen (Durchgangsstraßen dürfen über die Grenze hinausragen)
        inside = sum(1 for p in pts if pg.in_gemeinde(*p))
        if inside < len(pts) / 2:
            continue
        pts = simplify(pts, 0.8) if len(pts) > 2 else pts
        L = sum(((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5 for a, b in zip(pts, pts[1:]))
        if L < 15:
            continue
        mid = pts[len(pts) // 2]
        out.append([k, 1 if in_ort(*mid) else 0] + [round(v, 1) for p in pts for v in p])
        n_m += L
    res = {"stand": dt.date.today().isoformat(), "w": out, "quelle": "Straßennetz: © OpenStreetMap-Mitwirkende, ODbL. Verkehr: Simulation"}
    p = os.path.join(ROOT, "site", "data", "verkehr.js")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write("window.AL_VERKEHR=" + json.dumps(res, separators=(",", ":")) + ";\n")
    print("Verkehr: %d Abschnitte, %.0f km Strasse, %.0f KB" % (len(out), n_m / 1000, os.path.getsize(p) / 1024))


if __name__ == "__main__":
    main()

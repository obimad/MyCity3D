"""Straßenlampen für die Nachtansicht der 3D-Karte (ort.json: bausteine.lampen).

Eingabe : data/raw/osm_notfall.json (echte Lampen, highway=street_lamp, aus fetch_notfall.py; fehlt die Datei, gibt es nur symbolische Lampen)
          data/raw/gemeinde/osm/*.json (Straßen und Landnutzung, aus fetch.py osm)
Ausgabe : site/data/lampen.js   window.AL_LAMPEN = {r: [x,z,...] echte Lampen, s: [x,z,...] symbolische Lampen, stand}
Regel   : Echte Lampen aus OpenStreetMap (ODbL) im Gemeindegebiet. Dazu symbolische Lampen alle ABSTAND m entlang der Ortsstraßen
          (residential, living_street, unclassified, tertiary, secondary, primary, service mit Namen), aber nur innerhalb der Ortslagen
          (landuse residential, village_green, retail, commercial, farmyard) und nicht näher als NAH m an einer echten Lampe.
          Keine Feldwege (track), keine Fuß- und Radwege, keine Landstraßen außerhalb der Ortslage.
Schalter: ort.json bausteine.lampen (true/false, Standard aus). Ist er aus, endet das Skript ohne Arbeit.
          Statt true darf ein Objekt stehen: {"abstand_m": 35, "nah_m": 22} (Abstand der symbolischen Lampen, Mindestabstand zu echten Lampen).
Aufruf  : python scripts/prepare_lampen.py     (läuft im Wochenlauf nach fetch_notfall.py, schnell, ohne Netz)
Ortsunabhängig: arbeitet nur mit den Rohdaten des Gebiets; Grenze und Kacheln aus prepare_gemeinde.py.
"""
import datetime as dt, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
sys.stdout.reconfigure(encoding="utf-8")
from geo import ORT, pip, xz  # noqa: E402

BAUSTEIN = ORT.get("bausteine") or {}
_CFG = BAUSTEIN.get("lampen")
_CFG = _CFG if isinstance(_CFG, dict) else {}
ABSTAND, NAH = float(_CFG.get("abstand_m", 35.0)), float(_CFG.get("nah_m", 22.0))
STRASSEN = {"residential", "living_street", "unclassified", "tertiary", "secondary", "primary", "service"}
ORTSLAGE = {"residential", "village_green", "retail", "commercial", "farmyard"}


def main():
    if not BAUSTEIN.get("lampen"):
        print("Lampen: ort.json bausteine.lampen ist aus, uebersprungen")
        return 0
    import prepare_gemeinde as pg
    real = []
    p = os.path.join(ROOT, "data", "raw", "osm_notfall.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as fh:
            for e in json.load(fh)["elements"]:
                if (e.get("tags") or {}).get("highway") == "street_lamp" and "lat" in e:
                    x, z = xz(e["lat"], e["lon"])
                    if pg.in_gemeinde(x, z):
                        real.append((x, z))
    roads, areas, seen = [], [], set()
    d = os.path.join(ROOT, "data", "raw", "gemeinde", "osm")
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        with open(os.path.join(d, fn), encoding="utf-8") as fh:
            elems = json.load(fh)["elements"]
        for e in elems:
            if (e["type"], e["id"]) in seen or e["type"] != "way" or not e.get("geometry"):
                continue
            seen.add((e["type"], e["id"]))
            t = e.get("tags") or {}
            pts = [xz(g["lat"], g["lon"]) for g in e["geometry"]]
            hw = t.get("highway")
            if hw in STRASSEN and not (hw == "service" and not t.get("name")):
                roads.append(pts)
            elif t.get("landuse") in ORTSLAGE and len(pts) > 3:
                xs, zs = [q[0] for q in pts], [q[1] for q in pts]
                areas.append((min(xs), min(zs), max(xs), max(zs), pts))

    def in_ort(x, z):
        return any(a[0] <= x <= a[2] and a[1] <= z <= a[3] and pip(x, z, a[4]) for a in areas)

    grid = {}

    def near(x, z, r):
        gx, gz = int(x // 50), int(z // 50)
        return any(math.hypot(q[0] - x, q[1] - z) < r for dx in (-1, 0, 1) for dz in (-1, 0, 1) for q in grid.get((gx + dx, gz + dz), []))

    def add(x, z):
        grid.setdefault((int(x // 50), int(z // 50)), []).append((x, z))

    for x, z in real:
        add(x, z)
    sym = []
    for pts in roads:
        rest = ABSTAND / 2  # erste Lampe nach halbem Abstand
        for (ax, az), (bx, bz) in zip(pts, pts[1:]):
            L = math.hypot(bx - ax, bz - az)
            s = rest
            while s <= L:
                x, z = ax + (bx - ax) * s / L, az + (bz - az) * s / L
                # leicht an den Straßenrand versetzt (4 m), Seite abwechselnd
                nx, nz = -(bz - az) / L, (bx - ax) / L
                k = 4.0 if len(sym) % 2 else -4.0
                x2, z2 = x + nx * k, z + nz * k
                if in_ort(x, z) and pg.in_gemeinde(x, z) and not near(x2, z2, NAH):
                    sym.append((x2, z2))
                    add(x2, z2)
                s += ABSTAND
            rest = s - L
    flat = lambda ps: [round(v, 1) for q in ps for v in q]  # noqa: E731
    out = {"stand": dt.date.today().isoformat(), "abstand": ABSTAND, "r": flat(real), "s": flat(sym),
           "quelle": "Echte Lampen: © OpenStreetMap-Mitwirkende, ODbL. Ergänzte Lampen: symbolisch alle %d m entlang der Ortsstraßen" % ABSTAND}
    p = os.path.join(ROOT, "site", "data", "lampen.js")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write("window.AL_LAMPEN=" + json.dumps(out, separators=(",", ":"), ensure_ascii=False) + ";\n")
    print("Lampen: %d echt (OSM), %d symbolisch, %d Ortslagen, %d Strassen, %.0f KB" % (len(real), len(sym), len(areas), len(roads), os.path.getsize(p) / 1024))


if __name__ == "__main__":
    main()

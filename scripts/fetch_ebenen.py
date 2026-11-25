"""Zusatzebenen der 3D-Karte: Bauleitplanung, Flurstücke, Mobilität, Glasfaser, Straßenfotos.

Aufruf : python scripts/fetch_ebenen.py [plaene] [flurstuecke] [mobil] [glasfaser] [fotos]   (ohne Angabe: alle eingeschalteten)
         --lokal  nur vorhandene Rohdaten auswerten (kein Abruf)
Schalter (ort.json, bausteine; Standard aus, jede Phase einzeln):
         bplan        -> plaene       NUR BRANDENBURG (PLIS-Geoserver)
         flurstuecke  -> flurstuecke  NUR BRANDENBURG (ALKIS vereinfacht, LGB)
         mobil        -> mobil        überall (OpenStreetMap)
         glasfaser    -> glasfaser    überall in Deutschland (Breitbandatlas der Bundesnetzagentur)
         fotos        -> fotos        überall (Panoramax, Wikimedia Commons, KartaView)
         Ist ein Schalter aus, überspringt das Skript die Phase ohne Netzzugriff und ohne Fehler.
Ausgabe: site/data/plaene.js       window.AL_PLAENE    B-Pläne und Satzungen (PLIS Brandenburg, dl-de/by-2-0)
         site/data/fs/f_<i>_<j>.js window.AL_FS[...]   Flurstücke je 2-km-Kachel (ALKIS vereinfacht, LGB, dl-de/by-2-0)
         site/data/fs_index.js     window.AL_FS_INDEX  Liste der Flurstück-Kacheln
         site/data/mobil.js        window.AL_MOBIL     P+R, Taxi, Carsharing, Mitfahrbänke, Fahrkarten (OpenStreetMap, ODbL)
         site/img/glasfaser.png + site/data/glasfaser.js   Glasfaser FTTB/H je 100-m-Zelle (Breitbandatlas, BNetzA)
         site/data/fotos.js        window.AL_FOTOS     Straßenfotos: Panoramax, Wikimedia Commons, KartaView (CC BY-SA, je Bild Urheber)
Alle Dateien lädt die Karte erst, wenn die Ebene eingeschaltet wird (js/ebenen.js).
Rohdaten: data/raw/ebenen/ (nicht im Repository). Fällt eine Quelle aus, bleibt die alte Ausgabe stehen.

Ortsangaben (alle aus ort.json bzw. geo.py): name, kontakt_ua, geo.gemeindeschluessel, geo.umgrenzung_sued_west_nord_ost, geo.kachel_m.
Kacheln, Grenze und Ortsteile kommen aus prepare_gemeinde.py (data/raw/gemeinde/). Jede Phase ist eine eigene Funktion phase_<name>().
Optionale Einstellungen, wenn der Schalter statt true ein Objekt trägt:
         bausteine.glasfaser.datenstand  Datenstand des Breitbandatlas für den Quellenvermerk (Standard siehe DATENSTAND_BBA)
         bausteine.fotos.ortsbezug       Liste weiterer Wörter (z. B. Namen von Gebäuden/Plätzen), die ein Commons-Titel statt
                                         Gemeinde- oder Ortsteilnamen enthalten darf
Takt   : Mobilität und Fotos wöchentlich bis monatlich, Bauleitpläne monatlich, Flurstücke und Glasfaser vierteljährlich (ändern sich selten;
         Flurstücke sind der größte Abruf: eine Anfrage je Kachel, bis zu 10 Minuten).
"""
import datetime as dt, json, math, os, re, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "data", "raw", "ebenen")
OUTD = os.path.join(ROOT, "site", "data")
IMG = os.path.join(ROOT, "site", "img")
sys.stdout.reconfigure(encoding="utf-8")

from geo import CELL, GEMEINDE_SCHLUESSEL, ORT, UMGRENZUNG, latlon, simplify, utm33_to_latlon, xz  # noqa: E402

GEMEINDE = GEMEINDE_SCHLUESSEL               # amtlicher Gemeindeschlüssel (ARS) aus ort.json
BB = tuple(UMGRENZUNG)                       # Süd, West, Nord, Ost (Rechteck um die Gemeinde)
UA = ORT["kontakt_ua"]
BAUSTEIN = ORT.get("bausteine") or {}
LOKAL = "--lokal" in sys.argv
PLIS = "https://plis-bb.de/plisproject/inspire/index.php/geoserver/"           # nur Brandenburg
ALKIS = "https://isk.geobasis-bb.de/ows/alkis_vereinf_wfs"                     # nur Brandenburg
BBA = "https://breitbandatlas-wms.gigabit-grundbuch.online/WMS/Breitbandatlas"  # ganz Deutschland
BBA_LAYER = "Festnetz__100m_Gitter__Glasfaser_(FTTB/H)_≥_1000_Mbit/s722963448"
DATENSTAND_BBA = "06.2026"                   # Datenstand der Bundesnetzagentur; bei neuer Ausgabe anpassen (oder bausteine.glasfaser.datenstand)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def einstellung(name):
    """Objekt aus ort.json bausteine.<name>, wenn der Schalter statt true ein Objekt trägt, sonst leer."""
    c = BAUSTEIN.get(name)
    return c if isinstance(c, dict) else {}


def http(url, data=None, timeout=240, tries=4):
    last = None
    for t in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # Zeitüberschreitung, 5xx
            last = e
            log("  Versuch %d: %s" % (t + 1, e))
            time.sleep(6 * (t + 1))
    raise RuntimeError("Abruf fehlgeschlagen: %s (%s)" % (url[:120], last))


def raw(name, fetch):
    """Rohdatei laden (oder mit --lokal bzw. bei Ausfall die vorhandene nehmen)."""
    p = os.path.join(RAW, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if not LOKAL:
        try:
            blob = fetch()
            with open(p + ".part", "wb") as fh:
                fh.write(blob)
            os.replace(p + ".part", p)
            return blob
        except Exception as e:
            log("  Abruf fehlgeschlagen (%s), nehme vorhandene Rohdaten" % e)
    if os.path.exists(p):
        with open(p, "rb") as fh:
            return fh.read()
    raise RuntimeError("keine Rohdaten: " + name)


def write_js(path, var, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    s = "%s=%s;\n" % (var, json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    with open(path + ".part", "w", encoding="utf-8") as fh:
        fh.write(s)
    os.replace(path + ".part", path)
    log("  geschrieben: %s (%.0f KB)" % (os.path.relpath(path, ROOT), len(s.encode()) / 1024))


def gem():
    import prepare_gemeinde as pg  # Grenze, Ortsteile, Kacheln der Gemeinde
    return pg


def r1(v):
    return round(v, 1)


def ring_xz(coords, tol=0.6):
    pts = [xz(la, lo) for lo, la in coords]
    if len(pts) > 6:
        pts = simplify(pts, tol)
    out = []
    for x, z in pts:
        out += [r1(x), r1(z)]
    return out


# ------------------------------------------------------------------ 1. Bebauungspläne und Satzungen (PLIS Brandenburg, nur Brandenburg)
PLAN_TYPEN = [
    ("bebauungsplaene_rechtswirksam_wfs", "bp_rechtswirksam_flaechen", "bp"),
    ("satzungen_wfs", "innenbereichssatzung_rechtswirksam", "sat"),
    ("satzungen_wfs", "aussenbereichssatzung_rechtswirksam", "sat"),
    ("satzungen_wfs", "andere_satzungen_rechtswirksam", "sat"),
    ("satzungen_wfs", "entwicklungssatzung_rechtswirksam", "sat"),
    ("satzungen_wfs", "erhaltungssatzung_rechtswirksam", "sat"),
    ("satzungen_wfs", "oertliche_bauvorschriften_rechtswirksam", "sat"),
    ("satzungen_wfs", "sanierungssatzung_rechtswirksam", "sat"),
]


def phase_plaene():
    log("Bauleitplanung (PLIS Brandenburg)")
    items = []
    for svc, typ, kind in PLAN_TYPEN:
        url = (PLIS + svc + "/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=%s:%s&SRSNAME=EPSG:4326"
               "&BBOX=%s,%s,%s,%s,urn:ogc:def:crs:EPSG::4326&OUTPUTFORMAT=application/json" % ((svc, typ) + BB))
        try:
            d = json.loads(raw("plis_%s.json" % typ, lambda: http(url)).decode("utf-8"))
        except Exception as e:
            log("  %s: %s" % (typ, e))
            continue
        n = 0
        for f in d.get("features", []):
            p = f["properties"]
            if p.get("gemnr") != GEMEINDE or not f.get("geometry"):
                continue
            g = f["geometry"]
            polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
            rings = [ring_xz(poly[0]) for poly in polys if poly and len(poly[0]) > 3]
            if kind == "bp":
                it = {"k": "bp", "n": p.get("bp_bez") or "Bebauungsplan", "a": p.get("bp_t_part"), "v": p.get("bp_t_vart"),
                      "h": p.get("bp_t_haupt"), "b": p.get("bp_dat_bek"), "o": p.get("otname"), "id": p.get("bp_id"), "f": p.get("flaeche")}
            else:
                it = {"k": "sat", "n": p.get("sat_bez") or "Satzung", "a": p.get("sat_t_part"), "b": p.get("sa_dat_bek"),
                      "o": p.get("otname"), "id": p.get("sat_id"), "f": p.get("flaeche"), "t": typ.replace("_rechtswirksam", "")}
            it["r"] = rings
            items.append({k: v for k, v in it.items() if v not in (None, "")})
            n += 1
        log("  %s: %d in der Gemeinde" % (typ, n))
    if not items:
        log("  keine Plaene, alte Datei bleibt")
        return
    items.sort(key=lambda i: (i["k"], i["n"]))
    write_js(os.path.join(OUTD, "plaene.js"), "window.AL_PLAENE",
             {"stand": dt.date.today().isoformat(), "items": items,
              "quelle": "Planungsinformationssystem PLIS, Gemeinsame Landesplanungsabteilung Berlin-Brandenburg, dl-de/by-2-0"})


# ------------------------------------------------------------------ 2. Flurstücke (ALKIS vereinfacht, LGB, nur Brandenburg)
RE_FS = re.compile(r"<Flurstueck\b.*?</Flurstueck>", re.S)


def tag(s, t):
    m = re.search(r"<%s>([^<]*)</%s>" % (t, t), s)
    return m.group(1) if m else ""


def phase_flurstuecke():
    log("Flurstuecke (ALKIS vereinfacht, LGB)")
    pg = gem()
    cells = [(i, j) for i, j in pg.KEPT]
    out_dir = os.path.join(OUTD, "fs")
    idx, total = [], 0
    for i, j in sorted(cells):
        xa, za = pg.X0 + i * CELL, pg.Z0 + j * CELL
        s, w = latlon(xa, za + CELL)
        n, e = latlon(xa + CELL, za)
        url = (ALKIS + "?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ave:Flurstueck&COUNT=20000"
               "&BBOX=%.6f,%.6f,%.6f,%.6f,urn:ogc:def:crs:EPSG::4326" % (s, w, n, e))
        try:
            gml = raw("flurstuecke/c_%d_%d.gml" % (i, j), lambda: http(url, timeout=600)).decode("utf-8")
        except Exception as ex:
            log("  Kachel %d_%d: %s" % (i, j, ex))
            continue
        gmk, parcels = [], []
        for blk in RE_FS.findall(gml):
            if tag(blk, "gmdschl") != GEMEINDE:
                continue
            rings = []
            for pl in re.findall(r"<gml:exterior>.*?<gml:posList>([^<]+)</gml:posList>", blk, re.S):
                v = [float(t) for t in pl.split()]
                pts = []
                for k in range(0, len(v) - 1, 2):
                    la, lo = utm33_to_latlon(v[k], v[k + 1])
                    pts.append(xz(la, lo))
                if len(pts) > 6:
                    pts = simplify(pts, 0.25)
                # lokal zur Kachelecke in Dezimetern (kleine Ganzzahlen, Datei kleiner)
                rings.append([int(round((p[0] - xa) * 10)) if q == 0 else int(round((p[1] - za) * 10)) for p in pts for q in (0, 1)])
            if not rings:
                continue
            # Flurstück nur in der Kachel seines ersten Punkts führen (WFS liefert Randflurstücke in mehreren Kacheln)
            fx, fz = xa + rings[0][0] / 10, za + rings[0][1] / 10
            if not (xa <= fx < xa + CELL and za <= fz < za + CELL):
                continue
            g = tag(blk, "gemarkung")
            if g not in gmk:
                gmk.append(g)
            nen = tag(blk, "flstnrnen")
            parcels.append([gmk.index(g), tag(blk, "flur").lstrip("0") or "0", tag(blk, "flstnrzae") + ("/" + nen if nen else ""),
                            int(float(tag(blk, "flaeche") or 0)), tag(blk, "lagebeztxt")[:60], rings])
        if parcels:
            key = "%d_%d" % (i, j)
            write_js(os.path.join(out_dir, "f_%s.js" % key), "window.AL_FS=window.AL_FS||{};window.AL_FS[%s]" % json.dumps(key),
                     {"g": gmk, "p": parcels})
            idx.append(key)
            total += len(parcels)
        log("  Kachel %d_%d: %d Flurstuecke" % (i, j, len(parcels)))
    if idx:
        write_js(os.path.join(OUTD, "fs_index.js"), "window.AL_FS_INDEX", {"stand": dt.date.today().isoformat(), "cells": idx, "n": total})


# ------------------------------------------------------------------ 3. Mobilität und Fahrkarten (OpenStreetMap)
OSM_Q = ("[out:json][timeout:180];(" +
         'nwr["amenity"~"^(parking|taxi|car_sharing|bicycle_rental)$"]{bb};' +
         'nwr["park_ride"]["park_ride"!="no"]{bb};' +
         'nwr["vending"~"public_transport_tickets"]{bb};' +
         'nwr["shop"="ticket"]{bb};nwr["railway"="ticket_office"]{bb};' +
         'nwr["name"~"Mitfahr",i]{bb};nwr["amenity"="bench"]["bench:type"~"ride|lift",i]{bb};' +
         ");out center tags;").replace("{bb}", "(%s,%s,%s,%s)" % BB)


def mobil_art(t):
    am = t.get("amenity")
    if "mitfahr" in (t.get("name") or "").lower() or "ride" in (t.get("bench:type") or "").lower():
        return "M"
    if am == "parking":
        return None  # Parkplätze zeigt die eigene Ebene "Parkplätze" (scripts/fetch_parkplaetze.py, mit Gebührenangabe), nicht diese
    if t.get("park_ride") and t["park_ride"] != "no":
        return "R"
    if am == "taxi":
        return "X"
    if am == "car_sharing":
        return "C"
    if am == "bicycle_rental":
        return "B"
    if "public_transport_tickets" in (t.get("vending") or ""):
        return "A"
    if t.get("shop") == "ticket" or t.get("railway") == "ticket_office":
        return "V"
    return None


def mobil_detail(a, t):
    d = []
    if a in ("P", "R"):
        d.append({"surface": "Parkplatz", "multi-storey": "Parkhaus", "underground": "Tiefgarage", "street_side": "am Straßenrand",
                  "lane": "Parkstreifen", "rooftop": "Parkdeck"}.get(t.get("parking"), "Parkplatz"))
        if t.get("capacity", "").isdigit():
            d.append(t["capacity"] + " Stellplätze")
        if t.get("capacity:disabled", "").isdigit():
            d.append(t["capacity:disabled"] + " für Menschen mit Behinderung")
        if t.get("fee") == "no":
            d.append("kostenlos")
        elif t.get("fee") == "yes":
            d.append("gebührenpflichtig")
        if t.get("access") in ("private", "customers"):
            d.append({"private": "privat", "customers": "nur für Kunden"}[t["access"]])
    for k in ("name", "operator", "network", "opening_hours"):
        v = t.get(k)
        if v and len(v) < 90 and v not in d and not (k == "name" and v.lower() in ("parkplatz", "parking")):
            d.append(("Betreiber: " if k == "operator" else "Zeiten: " if k == "opening_hours" else "") + v)
    return ", ".join(d)


def phase_mobil():
    log("Mobilitaet und Fahrkarten (OpenStreetMap)")
    pg = gem()

    def get():
        last = None
        for host in ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
                     "https://overpass-api.de/api/interpreter"):
            try:
                return http(host, data=urllib.parse.urlencode({"data": OSM_Q}).encode(), tries=2)
            except Exception as e:
                last = e
        raise RuntimeError(last)
    d = json.loads(raw("osm_mobil.json", get))
    items, cnt = [], {}
    for e in d["elements"]:
        t = e.get("tags") or {}
        a = mobil_art(t)
        la = e.get("lat", (e.get("center") or {}).get("lat"))
        lo = e.get("lon", (e.get("center") or {}).get("lon"))
        if not a or la is None:
            continue
        x, z = xz(la, lo)
        if not pg.in_gemeinde(x, z):
            continue
        if a == "P" and t.get("access") in ("private", "no"):
            continue  # private Stellplätze nicht zeigen
        items.append([a, r1(x), r1(z), mobil_detail(a, t), "%s/%s" % (e["type"], e["id"])])
        cnt[a] = cnt.get(a, 0) + 1
    items.sort(key=lambda r: (r[0], r[1], r[2]))
    write_js(os.path.join(OUTD, "mobil.js"), "window.AL_MOBIL", {"stand": dt.date.today().isoformat(), "n": cnt, "items": items,
                                                                "quelle": "© OpenStreetMap-Mitwirkende, ODbL"})
    log("  %d Objekte %s" % (len(items), cnt))


# ------------------------------------------------------------------ 4. Glasfaser (Breitbandatlas der Bundesnetzagentur)
def phase_glasfaser():
    log("Glasfaser FTTB/H (Breitbandatlas, BNetzA)")
    pg = gem()
    s, w = latlon(pg.X0, pg.Z0 + pg.NZ * CELL)
    n, e = latlon(pg.X0 + pg.NX * CELL, pg.Z0)
    px = int(pg.NX * CELL / 10)  # 10 m je Bildpunkt (Zellen sind 100 m)
    pz = int(pg.NZ * CELL / 10)
    q = urllib.parse.urlencode({"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": BBA_LAYER, "STYLES": "",
                                "CRS": "CRS:84", "BBOX": "%.6f,%.6f,%.6f,%.6f" % (w, s, e, n), "WIDTH": px, "HEIGHT": pz,
                                "FORMAT": "image/png", "TRANSPARENT": "true"})
    blob = raw("glasfaser.png", lambda: http(BBA + "?" + q))
    from PIL import Image
    import io
    im = Image.open(io.BytesIO(blob)).convert("RGBA")
    if im.size != (px, pz) or im.getextrema()[3][1] == 0:
        log("  Bild unbrauchbar, alte Datei bleibt")
        return
    # Klassen der Legende auf eigene, kontrastreiche Farben (auf dem Luftbild lesbar); Umrisslinien des Dienstes entfallen
    LEG = [((254, 249, 216), (255, 120, 90), "0 bis 10 %"), ((255, 230, 170), (255, 170, 70), "10 bis 50 %"),
           ((204, 230, 232), (190, 225, 120), "50 bis 75 %"), ((122, 186, 196), (90, 210, 160), "75 bis 95 %"),
           ((51, 111, 145), (40, 200, 255), "über 95 %")]
    src = im.load()
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    dst = out.load()
    cnt = [0] * len(LEG)
    for yy in range(pz):
        for xx in range(px):
            r, g, b, a = src[xx, yy]
            if a < 128:
                continue
            best, bi = 60 ** 2, -1
            for k, (c, _, _) in enumerate(LEG):
                dd = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2
                if dd < best:
                    best, bi = dd, k
            if bi >= 0:
                dst[xx, yy] = LEG[bi][1] + (200,)
                cnt[bi] += 1
    os.makedirs(IMG, exist_ok=True)
    out.save(os.path.join(IMG, "glasfaser.png"), optimize=True)
    stand = str(einstellung("glasfaser").get("datenstand") or DATENSTAND_BBA)
    write_js(os.path.join(OUTD, "glasfaser.js"), "window.AL_GLASFASER",
             {"stand": dt.date.today().isoformat(), "datenstand": stand, "legende": [["#%02x%02x%02x" % l[1], l[2]] for l in LEG],
              "zellen": [round(c / 100) for c in cnt], "quelle": "© BNetzA. Datenstand: %s (Daten geändert: Farben, Gemeindeausschnitt)" % stand})
    log("  Zellen je Klasse (ca.): %s" % [round(c / 100) for c in cnt])


# ------------------------------------------------------------------ 5. Straßenfotos (Panoramax, Wikimedia Commons, KartaView)
def thin(points, dmin):
    """Punkte ausdünnen: höchstens ein Foto je dmin Meter."""
    keep, grid = [], {}
    for p in points:
        gx, gz = int(p["x"] // dmin), int(p["z"] // dmin)
        if any(q for dx in (-1, 0, 1) for dz in (-1, 0, 1) for q in grid.get((gx + dx, gz + dz), [])
               if math.hypot(q["x"] - p["x"], q["z"] - p["z"]) < dmin):
            continue
        grid.setdefault((gx, gz), []).append(p)
        keep.append(p)
    return keep


PERSONEN = re.compile(r"passfoto|chefredakteur|\btest\b|-test-|kinder|portrait|porträt|person|familie|hochzeit|selfie|\b(herr|frau)\b", re.I)


def _norm(t):
    t = t.lower().replace("ß", "ss")
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue")):
        t = t.replace(a, b)
    return t


def ortsbezug(title, pg):
    """Commons-Titel muss einen Ortsteil, die Gemeinde (ort.json: name) oder ein Zusatzwort (bausteine.fotos.ortsbezug) nennen."""
    t = _norm(title)
    zusatz = [_norm(str(w)) for w in einstellung("fotos").get("ortsbezug", []) if w]
    return any(_norm(o["n"]) in t for o in pg.OT) or _norm(ORT["name"]) in t or any(w in t for w in zusatz)


def phase_fotos():
    log("Strassenfotos")
    pg = gem()
    out = []
    # Panoramax (Metakatalog api.panoramax.xyz, Seiten zu 1000 Bildern)
    pnx = []
    try:  # Suche liefert höchstens 1000 Bilder je Abfrage: Rechteck in 6 x 5 Felder teilen
        nx, ny = 6, 5
        for a in range(nx):
            for b in range(ny):
                w = BB[1] + (BB[3] - BB[1]) * a / nx; e = BB[1] + (BB[3] - BB[1]) * (a + 1) / nx
                s_ = BB[0] + (BB[2] - BB[0]) * b / ny; n_ = BB[0] + (BB[2] - BB[0]) * (b + 1) / ny
                url = "https://api.panoramax.xyz/api/search?bbox=%.5f,%.5f,%.5f,%.5f&limit=1000" % (w, s_, e, n_)
                d = json.loads(raw("panoramax/f_%d_%d.json" % (a, b), lambda: http(url)))
                pnx += d.get("features", [])
    except Exception as e:
        log("  Panoramax: %s" % e)
    pts = []
    for f in pnx:
        lo, la = f["geometry"]["coordinates"][:2]
        x, z = xz(la, lo)
        if not pg.in_gemeinde(x, z):
            continue
        lic = (f.get("properties") or {}).get("license") or ""
        if not lic.upper().startswith(("CC-BY", "CC0", "ETALAB")):
            continue
        prod = ", ".join(p["name"] for p in f.get("providers", []) if "producer" in p.get("roles", []))
        th = ((f.get("assets") or {}).get("thumb") or {}).get("href")
        dt_ = ((f.get("properties") or {}).get("datetime") or "")[:10]
        if th:
            pts.append({"x": x, "z": z, "q": "p", "u": th, "a": prod, "l": lic, "d": dt_, "id": f["id"]})
    pts = thin(pts, 60)
    log("  Panoramax: %d Bilder, %d nach Ausduennen (60 m)" % (len(pnx), len(pts)))
    out += pts
    # Wikimedia Commons (Dateien mit Koordinaten; Orthofoto-Kacheln und Bilder von Personen ausgenommen)
    try:
        cm = []
        for o in pg.OT:  # je Ortsteil 2,5 km um die Mitte (große Radien füllen sich mit Orthofoto-Kacheln)
            lat, lon = (round(v, 4) for v in latlon(*o["c"]))
            u = ("https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=%s|%s&ggsradius=2500&ggslimit=500"
                 "&ggsnamespace=6&prop=imageinfo|coordinates&colimit=max&iiprop=url|extmetadata&iiurlwidth=500&iiextmetadatafilter=LicenseShortName|Artist|DateTimeOriginal"
                 "&format=json" % (lat, lon))
            d = json.loads(raw("commons_%s_%s.json" % (lat, lon), lambda: http(u)))
            cm += list(((d.get("query") or {}).get("pages") or {}).values())
        seen = set()
        for p in cm:
            t = p.get("title", "")
            if t in seen or "Orthofoto" in t or "DOP20" in t or PERSONEN.search(t) or not p.get("coordinates"):
                continue
            seen.add(t)
            if not ortsbezug(t, pg):
                continue  # falsch verortete Dateien (z. B. Fotos einer fernen Stadt mit Ersatzkoordinaten) fallen heraus
            c = p["coordinates"][0]
            x, z = xz(c["lat"], c["lon"])
            if not pg.in_gemeinde(x, z):
                continue
            ii = (p.get("imageinfo") or [{}])[0]
            md = ii.get("extmetadata") or {}
            lic = (md.get("LicenseShortName") or {}).get("value", "")
            if not re.match(r"(CC|Public domain|PD)", lic, re.I) or "NC" in lic or "ND" in lic:
                continue
            art = re.sub(r"<[^>]+>", "", (md.get("Artist") or {}).get("value", "")).strip()[:80]
            if ii.get("thumburl"):
                out.append({"x": x, "z": z, "q": "c", "u": ii["thumburl"].split("?")[0], "a": art, "l": lic, "t": t[5:].rsplit(".", 1)[0][:90],
                            "w": ii.get("descriptionurl", ""), "d": re.sub(r"<[^>]+>", "", (md.get("DateTimeOriginal") or {}).get("value", ""))[:10]})
        log("  Commons: %d Bilder in der Gemeinde" % sum(1 for o in out if o["q"] == "c"))
    except Exception as e:
        log("  Commons: %s" % e)
    # KartaView (Suchradius höchstens 500 m: Abfrage an den Ortsteilmitten)
    try:
        kv = []
        for o in pg.OT:
            la, lo = latlon(*o["c"])
            u = "https://api.kartaview.org/2.0/photo/?lat=%.5f&lng=%.5f&radius=500&itemsPerPage=150" % (la, lo)
            d = json.loads(raw("kartaview_%s.json" % re.sub(r"\W", "_", o["n"]), lambda: http(u)))
            kv += ((d.get("result") or {}).get("data") or [])
        kp = []
        for p in kv:
            if p.get("autoImgProcessingResult") != "BLURRED":
                continue  # nur Bilder mit unkenntlich gemachten Gesichtern und Kennzeichen
            x, z = xz(float(p["lat"]), float(p["lng"]))
            th = p.get("fileurlLTh") or p.get("fileurlTh")
            if th and pg.in_gemeinde(x, z):
                kp.append({"x": x, "z": z, "q": "k", "u": th, "a": "", "l": "CC-BY-SA-4.0", "d": (p.get("shotDate") or p.get("dateAdded") or "")[:10],
                           "id": p.get("id"), "s": "%s/%s" % (p.get("sequenceId"), p.get("sequenceIndex"))})
        kp = thin(kp, 60)
        log("  KartaView: %d Bilder, %d nach Ausduennen" % (len(kv), len(kp)))
        out += kp
    except Exception as e:
        log("  KartaView: %s" % e)
    if not out:
        log("  keine Fotos, alte Datei bleibt")
        return
    for o in out:
        o["x"], o["z"] = r1(o["x"]), r1(o["z"])
    write_js(os.path.join(OUTD, "fotos.js"), "window.AL_FOTOS", {"stand": dt.date.today().isoformat(), "items": out})


PHASES = {"plaene": phase_plaene, "flurstuecke": phase_flurstuecke, "mobil": phase_mobil, "glasfaser": phase_glasfaser, "fotos": phase_fotos}
SCHALTER = {"plaene": "bplan", "flurstuecke": "flurstuecke", "mobil": "mobil", "glasfaser": "glasfaser", "fotos": "fotos"}  # Phase -> ort.json bausteine.<Schlüssel>


def main():
    want = [a for a in sys.argv[1:] if not a.startswith("--")] or list(PHASES)
    for w in want:
        if w not in PHASES:
            log("unbekannte Phase %s (erlaubt: %s)" % (w, ", ".join(PHASES)))
            continue
        if not BAUSTEIN.get(SCHALTER[w]):
            log("%s: ort.json bausteine.%s ist aus, uebersprungen" % (w, SCHALTER[w]))
            continue
        try:
            PHASES[w]()
        except Exception as e:
            log("FEHLER in %s: %s (alter Stand bleibt)" % (w, e))
    return 0


if __name__ == "__main__":
    sys.exit(main())

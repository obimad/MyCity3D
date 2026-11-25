"""Parkplätze und Parkregeln am Straßenrand aus OpenStreetMap (ODbL) für das Gebiet (ort.json: bausteine.parken).

Abruf  : Overpass-API, die Umgrenzung aus ort.json (geo.umgrenzung_sued_west_nord_ost); Filter auf das Gemeindegebiet beim Aufbereiten
         (wie fetch_notfall.py). amenity=parking (Punkte, Flächen, Relationen) und Straßen mit eingetragener Parkregel (parking:left/right/both ...).
Ausgabe: data/raw/osm_parken.json (Rohdaten, nicht im Repository), site/data/parken.js  window.AL_PARKEN
Aufnahme: öffentlich nutzbare und Kundenparkplätze (nicht private/no/delivery ...); Parkhaus, Tiefgarage, Parkdeck, Park and Ride;
         Parkstreifen am Straßenrand (parking=street_side/lane/on_kerb) nur mit Name oder Stellplatzzahl; Garagenhöfe und Carports nicht.
         Fehlt eine Angabe (Gebühr, Zugang ...), steht sie nicht in der Ausgabe - die Karte schreibt dann "nicht in OpenStreetMap angegeben".
Straßen: nur Abschnitte mit einer Regel, die etwas über Gebühr, Dauer, Parkscheibe oder Verbot sagt. Klassen:
         B kostenpflichtig, F gebührenfrei, S Parkscheibe/zeitlich begrenzt, V Parkverbot (restriction=no_parking/no_stopping).
         "parking:both=no" und reine Angaben wie lane/parallel ohne Regel werden nicht gezeichnet (nichts raten).
Handpflege (optional): data/ergaenzung/parken_manuell.json, jeder Eintrag mit Quelle (z. B. Parkzonen-Satzung der Gemeinde).
         Die Datei ist leer/fehlt im Standard und liegt nicht im Repository; Aufbau siehe data/ergaenzung/parken_manuell.beispiel.json
         (erfundene Werte). Einträge ohne "quelle" werden ignoriert.
Hinweis: Angaben stammen von Mitwirkenden und können unvollständig oder veraltet sein. Maßgeblich ist die Beschilderung vor Ort.
Schalter: ort.json bausteine.parken (true/false, Standard aus). Ist er aus, endet das Skript ohne Netzzugriff.
Aufruf : python scripts/fetch_parkplaetze.py [--lokal] [--notbehelf]   (Wochenlauf; fällt Overpass aus, bleibt die alte Datei stehen)
         --lokal      nur die vorhandenen Rohdaten auswerten (kein Abruf)
         --notbehelf  ohne Rohdaten dieses Skripts: Parkplätze aus data/raw/ebenen/osm_mobil.json (fetch_ebenen.py) und den OSM-Kacheln
"""
import datetime as dt, json, math, os, re, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from geo import ORT, UMGRENZUNG, simplify, stitch, xz  # noqa: E402

ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "data", "raw", "osm_parken.json")
OUT = os.path.join(ROOT, "site", "data", "parken.js")
MAN = os.path.join(ROOT, "data", "ergaenzung", "parken_manuell.json")
BB = "(%s,%s,%s,%s)" % UMGRENZUNG
UA = ORT["kontakt_ua"]
BAUSTEIN = ORT.get("bausteine") or {}
HOSTS = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter")
sys.stdout.reconfigure(encoding="utf-8")

Q = ("[out:json][timeout:240];(" +
     'nwr["amenity"="parking"]' + BB + ";" +
     'way["highway"][~"^parking:(left|right|both|lane|condition)"~"."]' + BB + ";" +
     ");out tags geom;")


def overpass(q, tries=2):
    for i in range(tries):
        for host in HOSTS:
            try:
                req = urllib.request.Request(host, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
                return json.load(urllib.request.urlopen(req, timeout=180))
            except Exception as e:
                print("Overpass %s: %s" % (host, e))
                time.sleep(8 * (i + 1))
    raise RuntimeError("Overpass nicht erreichbar")


# ------------------------------------------------------------------ Texte in Deutsch
TAGE = {"Mo": "Mo", "Tu": "Di", "We": "Mi", "Th": "Do", "Fr": "Fr", "Sa": "Sa", "Su": "So", "PH": "Feiertage", "SH": "Schulferien"}


def zeit_de(s):
    """OSM-Zeitangabe (opening_hours, time_interval) mit deutschen Wochentagen; Ausdruck bleibt sonst unverändert."""
    s = (s or "").strip()
    if s == "24/7":
        return "rund um die Uhr"
    s = re.sub(r"\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b", lambda m: TAGE[m.group(1)], s)
    s = re.sub(r"\boff\b", "geschlossen", s)
    return s


def dauer_de(s):
    """maxstay wie '2 hours', '30 min', '1 day' -> '2 Stunden'; ohne erkennbare Einheit bleibt der Text stehen."""
    s = (s or "").strip()
    m = re.match(r"^(\d+(?:[.,]\d+)?)\s*(minutes?|mins?|hours?|h|days?|d)$", s, re.I)
    if not m:
        return s
    n, u = m.group(1).replace(".", ","), m.group(2).lower()
    ein = n in ("1", "1,0")
    if u.startswith("m"):
        return n + (" Minute" if ein else " Minuten")
    if u.startswith("h"):
        return n + (" Stunde" if ein else " Stunden")
    return n + (" Tag" if ein else " Tage")


def bedingt_de(s):
    """fee:conditional / maxstay:conditional wie 'yes @ (Mo-Fr 08:00-18:00); no @ (Sa,Su)'."""
    s = (s or "").strip()
    teile = []
    for part in s.split(";"):
        part = part.strip()
        m = re.match(r"^(.*?)\s*@\s*\(?(.*?)\)?$", part)
        if not m:
            teile.append(part)
            continue
        wert, zeit = m.group(1).strip(), zeit_de(m.group(2))
        wert = {"yes": "kostenpflichtig", "no": "kostenlos"}.get(wert, dauer_de(wert))
        teile.append("%s: %s" % (wert, zeit))
    return "; ".join(t for t in teile if t)


def preis_de(s):
    s = (s or "").strip()
    s = re.sub(r"\bhours?\b", "Stunde", s)
    s = re.sub(r"\bdays?\b", "Tag", s)
    s = re.sub(r"\b(minutes?|mins?)\b", "Min.", s)
    s = re.sub(r"(\d)\.(\d)", r"\1,\2", s)
    return s.replace("EUR", "€")


FLAECHE = {"asphalt": "Asphalt", "paved": "befestigt", "concrete": "Beton", "paving_stones": "Pflaster", "sett": "Kopfsteinpflaster", "cobblestone": "Kopfsteinpflaster",
           "unpaved": "unbefestigt", "gravel": "Schotter", "fine_gravel": "Splitt", "compacted": "verdichtet", "ground": "Erde", "dirt": "Erde", "grass": "Rasen",
           "grass_paver": "Rasengitter", "concrete:plates": "Betonplatten", "concrete:lanes": "Betonspuren", "pebblestone": "Kies", "wood": "Holz", "metal": "Metall"}
STRASSENART = {"lane": "Parkstreifen auf der Fahrbahn", "street_side": "Parkstreifen neben der Fahrbahn", "on_kerb": "Parken auf dem Gehweg",
               "half_on_kerb": "Parken halb auf dem Gehweg", "shoulder": "Parken auf dem Seitenstreifen", "diagonal": "Schrägparken", "marked": "markierte Stellplätze"}
AUSRICHTUNG = {"parallel": "längs", "perpendicular": "quer", "diagonal": "schräg"}


def zahl(v):
    return int(v) if v and re.match(r"^\d{1,5}$", v.strip()) else None


# ------------------------------------------------------------------ Geometrie
def xy(g):
    return xz(g["lat"], g["lon"])


def punkte(geom):
    return [xy(g) for g in geom]


def flaeche(r):
    return abs(sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r)))) / 2


def schwerpunkt(r):
    a = 0.0; cx = cz = 0.0
    for i in range(len(r)):
        x0, z0 = r[i]; x1, z1 = r[(i + 1) % len(r)]
        k = x0 * z1 - x1 * z0
        a += k; cx += (x0 + x1) * k; cz += (z0 + z1) * k
    if abs(a) < 1e-6:
        return sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)
    return cx / (3 * a), cz / (3 * a)


def ringe(e):
    """Äußere Ringe eines Elements als Punktlisten (x,z); Weg: der geschlossene Umriss, Relation: zusammengesetzte outer-Ringe."""
    if e["type"] == "way":
        g = e.get("geometry") or []
        if len(g) >= 4 and g[0] == g[-1]:
            return [punkte(g)]
        return []
    teile = [[(m2["lat"], m2["lon"]) for m2 in m["geometry"]] for m in e.get("members", [])
             if m.get("type") == "way" and (m.get("role") or "outer") == "outer" and m.get("geometry")]
    return [[xz(a, b) for a, b in r] for r in stitch(teile)]


def mitte_lage(e):
    """Mittelpunkt (x,z) und optional der Umriss (flache Liste)."""
    if e["type"] == "node":
        return xz(e["lat"], e["lon"]), None
    rs = sorted(ringe(e), key=flaeche, reverse=True)
    if rs:
        r = rs[0]
        a = flaeche(r)
        c = schwerpunkt(r)
        ring = None
        if 40 <= a <= 60000:
            s = simplify(r, 1.2)
            if len(s) >= 4:
                ring = [round(v, 1) for p in s for v in p]
        return c, ring
    g = e.get("geometry") or []
    if g:
        p = punkte(g)
        return p[len(p) // 2], None
    c = e.get("center")  # Rohdaten ohne Geometrie (Notbehelf, siehe lokale_rohdaten)
    if c:
        return xz(c["lat"], c["lon"]), None
    b = e.get("bounds")
    if b:
        return xz((b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2), None
    return None, None


# ------------------------------------------------------------------ Parkplätze
AUSGESCHLOSSEN = {"private", "no", "delivery", "agricultural", "forestry", "emergency", "military", "staff", "residents_only"}
ZUGANG = {"yes": "p", "public": "p", "permissive": "p", "designated": "p", "customers": "k", "permit": "b", "residents": "b", "destination": "d"}
ART_NAME = {"H": "Parkhaus", "T": "Tiefgarage", "D": "Parkdeck", "R": "Park-and-Ride-Parkplatz", "S": "Parkstreifen", "K": "Kundenparkplatz", "P": "Parkplatz"}


def parkplatz(e, t, pg):
    pk = t.get("parking")
    if pk in ("carports", "garage_boxes"):
        return None
    ac = (t.get("access") or "").strip().lower()
    if ac in AUSGESCHLOSSEN:
        return None
    zu = ZUGANG.get(ac, "u")
    if ac and ac not in ZUGANG:
        return None  # unbekannter Wert (z. B. 'private;customers'): lieber weglassen als falsch zeigen
    (c, ring) = mitte_lage(e)
    if not c:
        return None
    x, z = c
    if not pg.in_gemeinde(x, z):
        return None
    cap = zahl(t.get("capacity"))
    name = (t.get("name") or "").strip()
    if pk in ("street_side", "lane", "on_kerb", "half_on_kerb") and not (name or cap):
        return None
    if t.get("park_ride") and t["park_ride"] != "no":
        art = "R"
    elif pk == "multi-storey":
        art = "H"
    elif pk == "underground":
        art = "T"
    elif pk == "rooftop":
        art = "D"
    elif pk in ("street_side", "lane", "on_kerb", "half_on_kerb"):
        art = "S"
    elif zu == "k":
        art = "K"
    else:
        art = "P"
    fee = (t.get("fee") or "").strip().lower()
    fc = (t.get("fee:conditional") or "").strip()
    f = {"yes": "y", "no": "n"}.get(fee, "u")
    if fc and re.search(r"\byes\b", fc) and f != "y":
        f = "z"  # zeitweise kostenpflichtig
    it = {"x": round(x, 1), "z": round(z, 1), "a": art, "f": f, "zu": zu, "o": "%s/%d" % (e["type"], e["id"])}
    if name and name.lower() not in ("parkplatz", "parking"):
        it["nm"] = name[:80]
    if cap:
        it["n"] = cap
    if zahl(t.get("capacity:disabled")):
        it["nb"] = zahl(t["capacity:disabled"])
    if zahl(t.get("capacity:charging")):
        it["nl"] = zahl(t["capacity:charging"])
    if t.get("charge"):
        it["ch"] = preis_de(t["charge"])[:80]
    if fc:
        it["fc"] = bedingt_de(fc)[:160]
    if t.get("maxstay"):
        it["ms"] = dauer_de(t["maxstay"])[:60]
    if t.get("maxstay:conditional"):
        it["mc"] = bedingt_de(t["maxstay:conditional"])[:160]
    if t.get("supervised") in ("yes", "no"):
        it["su"] = "y" if t["supervised"] == "yes" else "n"
    if t.get("lit") in ("yes", "no"):
        it["li"] = "y" if t["lit"] == "yes" else "n"
    if t.get("surface"):
        it["sf"] = FLAECHE.get(t["surface"], t["surface"])[:40]
    if t.get("operator"):
        it["op"] = t["operator"][:80]
    if t.get("opening_hours"):
        it["oh"] = zeit_de(t["opening_hours"])[:160]
    if pk in STRASSENART and art == "S":
        it["sa"] = STRASSENART[pk]
    if ring:
        it["r"] = ring
    return it


# ------------------------------------------------------------------ Straßen mit Parkregel
def seiten_tags(t):
    """parking:left/right/both samt Unterschlüsseln und parking:condition:left/right/both gesammelt, beidseitige Werte gelten für links und rechts."""
    d = {"left": {}, "right": {}, "both": {}}
    for k, v in t.items():
        m = re.match(r"^parking:(left|right|both)(?::(.+))?$", k)
        if m:
            d[m.group(1)][m.group(2) or "_"] = v
            continue
        m = re.match(r"^parking:condition:(left|right|both)(?::(.+))?$", k)
        if m:
            d[m.group(1)]["cond:" + (m.group(2) or "_")] = v
    return {s: {**d["both"], **d[s]} for s in ("left", "right")}


def regel(w):
    """Klasse (B/F/S/V) und Einzelheiten für eine Straßenseite; None, wenn keine Regel eingetragen ist."""
    if w.get("_") in ("no", "separate") and not w.get("restriction"):
        return None
    cond = {c.strip() for c in (w.get("cond:_") or "").split(";") if c.strip()}
    rs = (w.get("restriction") or "").strip()
    fee = (w.get("fee") or "").strip()
    fcnd = (w.get("fee:conditional") or "").strip()
    ms = (w.get("maxstay") or w.get("cond:maxstay") or "").strip()
    mc = (w.get("maxstay:conditional") or "").strip()
    ti = (w.get("cond:time_interval") or w.get("time_interval") or "").strip()
    disc = w.get("authentication:disc") == "yes" or "disc" in cond
    d = {}
    if rs in ("no_parking", "no_stopping") or cond & {"no_parking", "no_stopping"}:
        k = "V"
        d["rs"] = {"no_parking": "Parkverbot (eingeschränktes Halteverbot)", "no_stopping": "Halteverbot (absolutes Halteverbot)"}.get(rs or ("no_parking" if "no_parking" in cond else "no_stopping"), rs)
        if w.get("restriction:conditional"):
            d["rc"] = bedingt_de(w["restriction:conditional"])[:160]
    elif fee == "yes" or "ticket" in cond or re.search(r"\byes\b", fcnd):
        k = "B"
    elif disc or ms or mc or ti or "disc" in cond:
        k = "S"
    elif fee == "no" or "free" in cond:
        k = "F"
    else:
        return None
    if w.get("charge"):
        d["ch"] = preis_de(w["charge"])[:80]
    if fcnd:
        d["fc"] = bedingt_de(fcnd)[:160]
    if ms:
        d["ms"] = dauer_de(ms)[:60]
    if mc:
        d["mc"] = bedingt_de(mc)[:160]
    if ti:
        d["ti"] = zeit_de(ti)[:120]
    if disc:
        d["sc"] = 1
    if w.get("_") in STRASSENART:
        d["sa"] = STRASSENART[w["_"]]
    if w.get("orientation") in AUSRICHTUNG:
        d["or"] = AUSRICHTUNG[w["orientation"]]
    return k, d


def versatz(pts, seite, abstand):
    """Parallele Linie im Abstand (m) links bzw. rechts der Fahrtrichtung (x Ost, z Süd; links = (dz,-dx))."""
    n = len(pts)
    out = []
    for i in range(n):
        a, b = pts[max(0, i - 1)], pts[min(n - 1, i + 1)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        l = math.hypot(dx, dz) or 1.0
        nx, nz = (dz / l, -dx / l) if seite == "left" else (-dz / l, dx / l)
        out.append((pts[i][0] + nx * abstand, pts[i][1] + nz * abstand))
    return out


def strassen(elems, pg):
    segs = []
    for e in elems:
        t = e.get("tags") or {}
        if e["type"] != "way" or "highway" not in t or not e.get("geometry"):
            continue
        p = punkte(e["geometry"])
        if len(p) < 2:
            continue
        mx, mz = p[len(p) // 2]
        if not pg.in_gemeinde(mx, mz):
            continue
        for s, w in seiten_tags(t).items():
            r = regel(w)
            if not r:
                continue
            k, d = r
            q = simplify(versatz(p, s, 4.2), 0.8)
            segs.append({"k": k, "id": e["id"], "nm": (t.get("name") or t.get("ref") or "")[:70], "d": d, "p": q})
    # Abschnitte gleicher Straße und Regel verbinden (Endpunkte höchstens 30 m auseinander) -> eine Karteninfo je Abschnitt
    for s in segs:
        sig = (s["nm"], s["k"], json.dumps(s["d"], sort_keys=True, ensure_ascii=False))
        s["sig"] = sig
    parent = list(range(len(segs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(len(segs)):
        for j in range(i + 1, len(segs)):
            if segs[i]["sig"] != segs[j]["sig"]:
                continue
            a, b = segs[i]["p"], segs[j]["p"]
            if min(math.hypot(u[0] - v[0], u[1] - v[1]) for u in (a[0], a[-1]) for v in (b[0], b[-1])) <= 30:
                parent[find(i)] = find(j)
    cl = {}
    for i, s in enumerate(segs):
        cl.setdefault(find(i), []).append(s)
    gruppen, out = [], []
    for gi, lst in enumerate(sorted(cl.values(), key=lambda l: (l[0]["nm"], l[0]["k"], l[0]["id"]))):
        lang = 0.0
        for s in lst:
            lang += sum(math.hypot(s["p"][i + 1][0] - s["p"][i][0], s["p"][i + 1][1] - s["p"][i][1]) for i in range(len(s["p"]) - 1))
        mid = max(lst, key=lambda s: len(s["p"]))
        m = mid["p"][len(mid["p"]) // 2]
        g = {"nm": lst[0]["nm"], "k": lst[0]["k"], "x": round(m[0], 1), "z": round(m[1], 1), "l": int(round(lang)),
             "o": sorted({"way/%d" % s["id"] for s in lst}), **lst[0]["d"]}
        gruppen.append(g)
        for s in lst:
            out.append({"g": gi, "k": s["k"], "p": [round(v, 1) for q in s["p"] for v in q]})
    return gruppen, out


# ------------------------------------------------------------------ Handpflege
def manuell():
    """data/ergaenzung/parken_manuell.json (optional): Einträge mit Quelle (z. B. Parkzonen-Satzung); ohne Quelle werden sie ignoriert."""
    if not os.path.exists(MAN):
        return [], []
    with open(MAN, encoding="utf-8") as fh:
        d = json.load(fh)
    pl, st = [], []
    for m in d.get("parkplaetze", []):
        if not m.get("quelle") or m.get("lat") is None:
            continue
        x, z = xz(m["lat"], m["lon"])
        f = {"yes": "y", "no": "n"}.get(m.get("gebuehr"), "u")
        it = {"x": round(x, 1), "z": round(z, 1), "a": {"Parkhaus": "H", "Tiefgarage": "T", "Kundenparkplatz": "K"}.get(m.get("art"), "P"), "f": f,
              "zu": "u", "o": "", "q": m["quelle"]}
        for src, dst in (("name", "nm"), ("plaetze", "n"), ("charge", "ch"), ("maxstay", "ms"), ("zeiten", "oh"), ("betreiber", "op")):
            if m.get(src):
                it[dst] = m[src]
        pl.append(it)
    for m in d.get("strassen", []):
        if not m.get("quelle") or m.get("klasse") not in ("B", "F", "S", "V") or not m.get("punkte"):
            continue
        p = [xz(a, b) for a, b in m["punkte"]]
        g = {"nm": m.get("name", ""), "k": m["klasse"], "x": round(p[len(p) // 2][0], 1), "z": round(p[len(p) // 2][1], 1),
             "l": int(sum(math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) for i in range(len(p) - 1))), "o": [], "q": m["quelle"]}
        if m.get("text"):
            g["tx"] = m["text"]
        st.append((g, [round(v, 1) for q in p for v in q]))
    return pl, st


def lokale_rohdaten():
    """Notbehelf ohne Overpass (nur wenn noch keine Rohdaten dieses Skripts da sind): Parkplätze aus data/raw/ebenen/osm_mobil.json
    (Mittelpunkt, ohne Flächenumriss) und Straßen mit Parkregel aus den OSM-Kacheln data/raw/gemeinde/osm/*.json (mit Geometrie)."""
    els, seen = [], set()
    pm = os.path.join(ROOT, "data", "raw", "ebenen", "osm_mobil.json")
    if os.path.exists(pm):
        with open(pm, encoding="utf-8") as fh:
            for e in json.load(fh).get("elements", []):
                if (e.get("tags") or {}).get("amenity") == "parking" and (e["type"], e["id"]) not in seen:
                    seen.add((e["type"], e["id"])); els.append(e)
    td = os.path.join(ROOT, "data", "raw", "gemeinde", "osm")
    if os.path.isdir(td):
        for fn in sorted(os.listdir(td)):
            with open(os.path.join(td, fn), encoding="utf-8") as fh:
                for e in json.load(fh).get("elements", []):
                    t = e.get("tags") or {}
                    if e["type"] == "way" and (e["type"], e["id"]) not in seen and "highway" in t and any(k.startswith("parking:") for k in t):
                        seen.add((e["type"], e["id"])); els.append(e)
    return {"elements": els, "notbehelf": True}


def main():
    if not BAUSTEIN.get("parken"):
        print("Parkplaetze: ort.json bausteine.parken ist aus, uebersprungen")
        return 0
    os.makedirs(os.path.dirname(RAW), exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    try:
        if "--lokal" in sys.argv:
            raise RuntimeError("--lokal: nur die vorhandenen Rohdaten auswerten")
        d = overpass(Q)
        if not d.get("elements"):
            raise RuntimeError("leere Antwort")
        with open(RAW, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
    except Exception as e:
        print("Parkplaetze: Abruf fehlgeschlagen (%s)" % e)
        if os.path.exists(RAW):
            with open(RAW, encoding="utf-8") as fh:
                d = json.load(fh)
            print("Parkplaetze: Rohdaten vom letzten Lauf werden verwendet")
        elif "--notbehelf" in sys.argv or not os.path.exists(OUT):
            d = lokale_rohdaten()
            print("Parkplaetze: Notbehelf aus osm_mobil.json und den OSM-Kacheln (%d Elemente, keine Flaechenumrisse)" % len(d["elements"]))
        else:
            return 0
    import prepare_gemeinde as pg  # Gebietsgrenze und Koordinaten
    items = []
    for e in d["elements"]:
        t = e.get("tags") or {}
        if t.get("amenity") == "parking":
            it = parkplatz(e, t, pg)
            if it:
                items.append(it)
    gruppen, segs = strassen(d["elements"], pg)
    mp, ms = manuell()
    items += mp
    for g, p in ms:
        gruppen.append(g)
        segs.append({"g": len(gruppen) - 1, "k": g["k"], "p": p})
    items.sort(key=lambda r: (r["a"], r["x"], r["z"]))
    cnt = {}
    for it in items:
        cnt[it["a"]] = cnt.get(it["a"], 0) + 1
    mit = sum(1 for it in items if it["f"] != "u")
    out = {"stand": dt.date.today().isoformat(), "n": cnt, "gesamt": len(items), "mitGebuehr": mit, "items": items,
           "gruppen": gruppen, "segs": segs, "quelle": "© OpenStreetMap-Mitwirkende, ODbL"}
    if d.get("notbehelf"):
        out["notbehelf"] = 1  # Rohdaten ohne Flächenumrisse (siehe lokale_rohdaten); der nächste Abruf ersetzt sie
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("window.AL_PARKEN=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
    ks = {}
    for g in gruppen:
        ks[g["k"]] = ks.get(g["k"], 0) + 1
    print("Parkplaetze im Gebiet: %d %s, davon %d mit Gebuehrenangabe (%d %%); Strassenabschnitte mit Parkregel: %d %s" % (
        len(items), cnt, mit, round(100 * mit / len(items)) if items else 0, len(gruppen), ks))
    return len(items)


if __name__ == "__main__":
    main()

# Eigene 3D-Modelle einbinden (optional)

Einzelne Gebäude lassen sich durch eigene Modelle ersetzen, zum Beispiel eine Kirche, eine Mühle oder ein Wahrzeichen. Die Vorlage liefert **keine Modelle** mit: Sie gehören zum Ort und haben eigene Quellen und Lizenzen. Sie bringt nur den Leser und die Ebene mit.

Einschalten: `ort.json`, `"bausteine": { "modelle": true }`, dann `python scripts/baue_seiten.py`.

## Was du lieferst

| Was | Wo | Inhalt |
|---|---|---|
| Modelle | `site/models/<name>_lod0.glb`, `_lod1.glb`, `_lod2.glb` | je Detailstufe eine binäre glTF-Datei (0 = fein, 2 = grob). Fehlt eine Stufe, nimmt die Karte die vorhandenen. |
| Liste | `site/data/modelle.js` | `window.AL_MODELLE_LISTE = [ {...}, ... ];` (Felder unten) |
| Quellentexte (optional) | `site/data/modelle_quellen.js` | `window.AL_MODELLE_Q = { "<id>": "Quelle, Lizenz, Annahmen" };` oder je Eintrag das Feld `quelle` |

`baue_seiten.py` legt `site/data/modelle.js` leer an, solange du keine Liste geschrieben hast. Die Karte zeigt dann nichts.

## Felder je Modell

| Feld | Bedeutung |
|---|---|
| `id` | Kennung, zum Beispiel `kirche_ortsmitte` (für die Quellentexte) |
| `name` | Anzeigename |
| `datei` | Pfad ohne Stufe und Endung, zum Beispiel `models/kirche_ortsmitte_lod` |
| `x`, `z` | Lage in Kartenmetern: `x` nach Osten, `z` nach Süden, Nullpunkt ist der Ortsmittelpunkt aus `ort.json` (dieselbe Rechnung wie `xz()` in `scripts/geo.py`) |
| `typ` | `kirche`, `muehle`, `anlauf` (hervorgehobener Anlaufpunkt) oder `turm` (Wahrzeichen ohne eigenen Marker) |
| `ot` | Ortsteil (nur Anzeige) |
| `hoehe` | Höhe in Metern (setzt den Marker) |
| `ersetzt` | Liste der Gebäude-IDs aus den Kacheldaten, die das Modell verdeckt; sie verschwinden erst, wenn das Modell geladen ist |
| `stufen` | Umschaltentfernungen in Metern, üblich `[0, 380, 1400]` |
| `laden` | Entfernung der Kamera, ab der das Modell geladen wird, üblich `6000` |
| `fluegel` | `true`: Knoten mit dem Namen `Fluegel` dreht sich (eine Umdrehung in 24 s), nicht bei „reduzierte Bewegung“ |
| `dreh` | Ausrichtung in Bogenmaß |
| `hl`, `hlr` | `hl: true` hebt den Anlaufpunkt mit Ring und Lichtsäule hervor, `hlr` ist der Ringradius in Metern |
| `quelle` | Quellentext (sonst aus `modelle_quellen.js`) |

## Anforderungen an die GLB-Dateien

- Binäres glTF 2.0, **keine Erweiterungen**: kein Draco, keine `KHR_*`. Der eingebaute Leser kennt nur Netze, Grundfarben und eingebettete Texturen; er lädt keine Zusatzbibliothek.
- Maßstab Meter, Ursprung im Mittelpunkt des Grundrisses auf Bodenhöhe, `y` nach oben.
- Wenige Dreiecke je Stufe halten die Karte flüssig; die Gesamtgröße je Modell sollte klein bleiben (grobe Stufe wenige zehn KB).

## Quellen und Lizenzen

Die Karte zeigt die Quelle eines Modells erst bei Klick und im Dialog „Quellen“. Trage dort die Herkunft des Grundrisses, der Höhe und der Vorlagen ein (zum Beispiel OpenStreetMap, ODbL; Fotos von Wikimedia Commons mit Urheber und Lizenz). Die Modelle sind eine vereinfachte Darstellung, keine Bauaufnahme: Das sagt der Quellentext der Karte schon allgemein, ergänze besondere Annahmen (geschätzte Höhe, angenommene Fassade, Drehung nur als Darstellung).

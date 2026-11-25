/* Zusatzebenen der 3D-Karte: Bebauungspläne und Satzungen, Flurstücke (beide nur Brandenburg), Parken und Mobilität, Glasfaser,
   Straßenfotos, eigene 3D-Modelle, Straßenlampen bei Dunkelheit und simulierter Autoverkehr. Jede Ebene ist ein eigener Baustein in ort.json
   (bausteine.bplan, flurstuecke, mobil, glasfaser, fotos, modelle, nachtlicht, verkehr) und fehlt ganz, wenn er aus ist.
   Daten entstehen mit scripts/fetch_ebenen.py, prepare_lampen.py und prepare_verkehr.py. Jede Ebene lädt ihre Daten erst beim Einschalten
   (eigene Datei, gleiche Herkunft). Fotos von Dritten lädt der Browser erst nach Klick auf "Foto anzeigen". Hängt an der Schnittstelle
   window.AL_APP aus js/app.js (EXT.layer, EXT.frame, EXT.pick, addMarker, NFD, setHidden). Die Ebenen kennen keinen Ort: Lage und ersetzte
   Gebäude der 3D-Modelle stehen in data/modelle.js (window.AL_MODELLE_LISTE, siehe docs/MODELLE.md). */
(function () {
  'use strict';

  // 3D-Modelle: Liste aus data/modelle.js (window.AL_MODELLE_LISTE, leer = keine). Je Eintrag: id, name, datei (Pfad ohne Stufe und .glb, z. B. 'models/kirche_lod'),
  // x/z (Karte, Meter), typ (kirche, muehle, anlauf, turm), ot (Ortsteil), hoehe, ersetzt (Gebäude-IDs, die das Modell verdeckt), stufen [0, 380, 1400] (Umschaltentfernungen),
  // laden (Entfernung, ab der geladen wird), optional fluegel (dreht sich), dreh (Ausrichtung im Bogenmaß), hl/hlr (hervorgehoben, Radius des Rings), quelle (Text).
  const MODELLE = window.AL_MODELLE_LISTE || [];

  function init(A) {
    if (init.done) return; init.done = true;
    const THREE = A.THREE, S = A.S, esc = A.esc, $ = (s) => document.querySelector(s), O = window.ORT || {};
    ['nachtlicht', 'verkehr', 'modelle', 'bplan', 'flurst', 'mobil', 'glasfaser', 'fotos'].forEach((k) => { if (!O[k]) S.L[k] = false; });
    const once = {};
    function loadScript(src) { // Datendatei (window.AL_...) einmalig nachladen, mit Kachelkennung gegen alte Zwischenspeicher
      if (!once[src]) once[src] = new Promise((ok, no) => {
        const s = document.createElement('script'); s.src = src + '?v=' + A.tv(); s.async = true;
        s.onload = ok; s.onerror = () => { delete once[src]; no(new Error('nicht geladen: ' + src)); }; document.head.appendChild(s);
      });
      return once[src];
    }
    const setState = (key, t) => { const el = document.getElementById('st-' + key); if (el) el.textContent = t ? ' · ' + t : ''; };
    const fmtDe = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? +m[3] + '.' + +m[2] + '.' + m[1] : (iso || ''); };
    const ha = (m2) => (m2 / 1e4).toLocaleString('de-DE', { maximumFractionDigits: m2 < 1e5 ? 2 : 1 }) + ' ha';
    function pip(x, z, r) { // Punkt im Ring (flaches Feld x0,z0,x1,z1,...)
      let inside = false;
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    }
    function ringCenter(r) { let x = 0, z = 0; const n = r.length / 2; for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; } return [x / n, z / n]; }
    function marker(grp, sym, color, x, y, z, title, onClick) {
      const mk = A.addMarker('nf', sym, x, y, z, () => onClick(mk), null);
      mk.grp = grp; mk.el.style.setProperty('--c', color); mk.el.title = title;
      if (/[^\x00-\x7f]/.test(sym) || sym.length > 2) mk.el.classList.add('big');
      return mk;
    }
    function selMk(mk) { document.querySelectorAll('.mk.sel').forEach((m) => m.classList.remove('sel')); if (mk) mk.el.classList.add('sel'); }

    // ------------------------------------------------------------------ Bebauungspläne und Satzungen (PLIS Brandenburg)
    A.NFD.bplan = 30000; A.NFD.mobil = 3200; A.NFD.fotos = 2600; A.NFD.modelle = 2600; A.NFD.modelleHl = 16000;
    const BP = { group: null, items: null };
    const bpColor = (it) => (it.k === 'sat' ? '#c58af9' : /Wohn/.test(it.h || it.v || '') ? '#ff9f43' : /Gemischt/.test(it.h || '') ? '#ffd166'
      : /Gewerb|Industr/.test(it.h || it.v || '') ? '#a0a6ff' : /Sonder|Photovolt|Energie/.test(it.h || it.v || '') ? '#ffe14d' : '#9fd8ff');
    function bpRows(it) {
      return '<dl>' + (it.a ? '<dt>Art</dt><dd>' + esc(it.a) + '</dd>' : '') + (it.v ? '<dt>Vorhaben</dt><dd>' + esc(it.v) + '</dd>' : '')
        + (it.h ? '<dt>Hauptnutzung</dt><dd>' + esc(it.h) + '</dd>' : '') + (it.b ? '<dt>Bekannt gemacht</dt><dd>' + esc(it.b) + '</dd>' : '')
        + (it.o ? '<dt>Ortsteil</dt><dd>' + esc(it.o) + '</dd>' : '') + (it.f ? '<dt>Fläche</dt><dd>' + ha(it.f) + '</dd>' : '') + '</dl>';
    }
    const BP_NOTE = '<p class="note">Geltungsbereich laut Planungsinformationssystem des Landes. Rechtsverbindlich sind nur Planzeichnung und Text, einzusehen bei der ' + esc((O.art || 'Gemeinde') + ' ' + (O.name || '')) + '.</p>';
    function bpSource() { return A.sourceLine('PLIS Brandenburg (Gemeinsame Landesplanungsabteilung), dl-de/by-2-0' + (window.AL_PLAENE ? ', Stand ' + fmtDe(window.AL_PLAENE.stand) : ''), 'https://www.govdata.de/dl-de/by-2-0'); }
    function bpBuild() {
      const D = window.AL_PLAENE; if (!D || BP.group) return;
      BP.items = D.items; BP.group = new THREE.Group();
      D.items.forEach((it) => {
        const c = new THREE.Color(bpColor(it));
        it.r.forEach((r) => {
          const pts = []; for (let i = 0; i < r.length; i += 2) pts.push(new THREE.Vector2(r[i], r[i + 1]));
          if (pts.length < 3) return;
          const tri = THREE.ShapeUtils.triangulateShape(pts, []), pos = new Float32Array(pts.length * 3), lin = new Float32Array(pts.length * 3);
          pts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = 0.55; pos[i * 3 + 2] = p.y; lin[i * 3] = p.x; lin[i * 3 + 1] = 0.7; lin[i * 3 + 2] = p.y; });
          const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(tri.flat());
          const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }));
          m.renderOrder = 7; BP.group.add(m);
          const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lin, 3));
          const l = new THREE.LineLoop(lg, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.95 })); l.renderOrder = 8; BP.group.add(l);
        });
        const big = it.r.slice().sort((a, b) => b.length - a.length)[0]; if (!big) return;
        const cc = ringCenter(big);
        marker('bplan', it.k === 'sat' ? 'S' : 'B', bpColor(it), cc[0], 10, cc[1], it.n, (mk) => {
          selMk(mk);
          A.openCard('<h3>' + esc(it.n) + '</h3><p class="sub">' + (it.k === 'sat' ? 'Satzung' : 'Bebauungsplan') + ', rechtswirksam</p>' + bpRows(it) + BP_NOTE + bpSource());
          A.flyTo({ tx: cc[0], tz: cc[1], dist: Math.min(A.view.dist, Math.max(500, Math.sqrt(it.f || 1e4) * 4)), phi: Math.min(A.view.phi, 1.0) }, 900);
        });
      });
      A.scene.add(BP.group); setState('bplan', D.items.length + ' Pläne'); A.dirty();
    }
    A.EXT.layer.push(() => {
      if (S.L.bplan && !BP.group) { setState('bplan', 'lädt …'); loadScript('data/plaene.js').then(() => { bpBuild(); A.applyLayers(); }, () => setState('bplan', 'nicht verfügbar')); }
      if (BP.group) BP.group.visible = S.L.bplan;
    });
    A.EXT.pick.push((x, z) => {
      if (!S.L.bplan || !BP.items) return '';
      const hit = BP.items.filter((it) => it.r.some((r) => pip(x, z, r)));
      return hit.map((it) => '<h4>' + (it.k === 'sat' ? 'Satzung' : 'Bebauungsplan') + ': ' + esc(it.n) + '</h4>' + bpRows(it)).join('') + (hit.length ? BP_NOTE + bpSource() : '');
    });

    // ------------------------------------------------------------------ Flurstücke (ALKIS, LGB), je 2-km-Kachel nachgeladen
    const FS = { cells: {}, idx: null, mat: null, maxDist: 4500 };
    function fsBuild(key) {
      const d = window.AL_FS && window.AL_FS[key], c = FS.cells[key]; if (!d || !c || c.line) return;
      const [i, j] = key.split('_').map(Number), ox = A.X0 + i * A.C, oz = A.Z0 + j * A.C;
      let n = 0; d.p.forEach((p) => p[5].forEach((r) => { n += r.length / 2; }));
      const pos = new Float32Array(n * 6); let k = 0;
      d.p.forEach((p) => p[5].forEach((r) => {
        const m = r.length / 2;
        for (let q = 0; q < m; q++) {
          const a = q * 2, b = ((q + 1) % m) * 2;
          pos[k++] = ox + r[a] / 10; pos[k++] = 0.45; pos[k++] = oz + r[a + 1] / 10;
          pos[k++] = ox + r[b] / 10; pos[k++] = 0.45; pos[k++] = oz + r[b + 1] / 10;
        }
      }));
      if (!FS.mat) FS.mat = new THREE.LineBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.8, depthWrite: false });
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      c.line = new THREE.LineSegments(g, FS.mat); c.line.renderOrder = 9; c.ox = ox; c.oz = oz; c.d = d;
      A.scene.add(c.line); A.dirty();
    }
    function fsUpdate() {
      if (!S.L.flurst) { for (const k in FS.cells) if (FS.cells[k].line) FS.cells[k].line.visible = false; return; }
      const near = A.view.dist < FS.maxDist;
      setState('flurst', near ? (FS.idx ? FS.idx.n.toLocaleString('de-DE') + ' Flurstücke' : 'lädt …') : 'zum Anzeigen näher heranzoomen');
      for (const k in FS.cells) if (FS.cells[k].line) FS.cells[k].line.visible = near;
      if (!near || !FS.idx) return;
      const R = Math.max(1600, A.view.dist * 1.3);
      FS.idx.cells.forEach((key) => {
        if (FS.cells[key]) return;
        const [i, j] = key.split('_').map(Number), cx = A.X0 + (i + 0.5) * A.C, cz = A.Z0 + (j + 0.5) * A.C;
        if (Math.abs(cx - A.view.tx) > R + A.C / 2 || Math.abs(cz - A.view.tz) > R + A.C / 2) return;
        FS.cells[key] = { busy: true };
        loadScript('data/fs/f_' + key + '.js').then(() => fsBuild(key), () => { delete FS.cells[key]; });
      });
    }
    A.EXT.layer.push(() => {
      if (S.L.flurst && !FS.idx) loadScript('data/fs_index.js').then(() => { FS.idx = window.AL_FS_INDEX; fsUpdate(); A.dirty(); }, () => setState('flurst', 'nicht verfügbar'));
      fsUpdate();
    });
    let fsLast = '';
    A.EXT.frame.push(() => { const k = Math.round(A.view.tx / 300) + ',' + Math.round(A.view.tz / 300) + ',' + Math.round(Math.log2(A.view.dist) * 2); if (k !== fsLast && S.L.flurst) { fsLast = k; fsUpdate(); } });
    A.EXT.pick.push((x, z) => {
      if (!S.L.flurst) return '';
      for (const key in FS.cells) {
        const c = FS.cells[key]; if (!c.d) continue;
        const lx = (x - c.ox) * 10, lz = (z - c.oz) * 10;
        for (const p of c.d.p) {
          if (p[5].some((r) => pip(lx, lz, r))) {
            return '<h4>Flurstück</h4><dl><dt>Gemarkung</dt><dd>' + esc(c.d.g[p[0]]) + '</dd><dt>Flur</dt><dd>' + esc(p[1]) + '</dd><dt>Flurstück</dt><dd>' + esc(p[2]) + '</dd>'
              + (p[3] ? '<dt>Amtliche Fläche</dt><dd>' + p[3].toLocaleString('de-DE') + ' m²</dd>' : '') + (p[4] ? '<dt>Lage</dt><dd>' + esc(p[4]) + '</dd>' : '') + '</dl>'
              + '<p class="note">Aus dem Liegenschaftskataster (ALKIS, vereinfacht), ohne Eigentümerangaben. Verbindlich ist nur ein Auszug des Katasteramts.</p>'
              + A.sourceLine('© GeoBasis-DE/LGB, dl-de/by-2-0 (Daten geändert)' + (FS.idx ? ', Stand ' + fmtDe(FS.idx.stand) : ''), 'https://www.govdata.de/dl-de/by-2-0');
          }
        }
      }
      return '';
    });

    // ------------------------------------------------------------------ Parken und Mobilität (OpenStreetMap)
    const MOB_T = { P: ['Parkplatz', 'P', '#3a7bd5', 'Parkplätze'], R: ['Park and Ride', 'P+R', '#1f9e89'], X: ['Taxistand', '🚕', '#d9a21b'], C: ['Carsharing', '🚗', '#4aa84a'],
      M: ['Mitfahrbank', '🙋', '#d86fa0'], B: ['Fahrradverleih', '🚲', '#4aa84a'], A: ['Fahrkartenautomat', '🎫', '#c0392b'], V: ['Fahrkarten-Verkaufsstelle', '🎫', '#8e44ad'] };
    let mobDone = false;
    A.EXT.layer.push(() => {
      if (!S.L.mobil || mobDone) return;
      mobDone = true; setState('mobil', 'lädt …');
      loadScript('data/mobil.js').then(() => {
        const D = window.AL_MOBIL; if (!D) return;
        D.items.forEach((it) => {
          const t = MOB_T[it[0]]; if (!t) return;
          marker('mobil', t[1], t[2], it[1], 8, it[2], t[0] + (it[3] ? ': ' + it[3] : ''), (mk) => {
            selMk(mk);
            A.openCard('<h3>' + esc(t[0]) + '</h3><p class="sub">' + esc(it[3] || 'ohne weitere Angaben') + '</p><p class="note">Eintrag aus OpenStreetMap, ohne Gewähr. Gebühren, Zeiten und Nutzungsbedingungen bitte vor Ort prüfen.</p>'
              + A.sourceLine('OpenStreetMap, Objekt ' + it[4], 'https://www.openstreetmap.org/' + it[4]));
            A.flyTo({ tx: it[1], tz: it[2], dist: Math.min(A.view.dist, 300), phi: Math.min(A.view.phi, 1.1) }, 900);
          });
        });
        const n = D.n || {}; setState('mobil', Object.keys(MOB_T).filter((k) => n[k]).map((k) => n[k] + ' ' + (n[k] > 1 && MOB_T[k][3] ? MOB_T[k][3] : MOB_T[k][0])).join(', ') || 'keine Einträge');
        A.dirty();
      }, () => { mobDone = false; setState('mobil', 'nicht verfügbar'); });
    });

    // ------------------------------------------------------------------ Glasfaser (Bildebene, lädt app.js über OVL); hier nur Legende und Hinweis
    A.EXT.layer.push(() => { const lg = $('#lg-glasfaser'); if (lg) lg.hidden = !S.L.glasfaser; });

    // ------------------------------------------------------------------ Straßenfotos (Panoramax, Wikimedia Commons, KartaView)
    const FQ = { p: ['Panoramax', '#58a6ff'], c: ['Wikimedia Commons', '#f2c14e'], k: ['KartaView', '#7ed957'] };
    function fotoLink(f) {
      if (f.q === 'c') return A.safeUrl(f.w);
      if (f.q === 'p') return 'https://api.panoramax.xyz/#focus=pic&pic=' + encodeURIComponent(f.id);
      if (f.q === 'k' && f.s) return 'https://kartaview.org/details/' + f.s.split('/').map(encodeURIComponent).join('/');
      return null;
    }
    function showFoto(f, mk) {
      selMk(mk);
      const host = (/^https:\/\/([^/]+)/.exec(f.u) || [])[1] || '', link = fotoLink(f), lic = f.l.replace(/-/g, ' ');
      A.openCard('<h3>' + esc(f.t || 'Straßenfoto') + '</h3><p class="sub">' + FQ[f.q][0] + (f.d ? ' · ' + fmtDe(f.d) : '') + '</p>'
        + '<div id="fotoBox"><button class="chip" id="fotoLaden">📷 Foto anzeigen</button><p class="note">Das Bild wird erst nach Klick direkt von <b>' + esc(host) + '</b> geladen. Dabei erhält dieser Dienst Ihre IP-Adresse.</p></div>'
        + '<p class="note">Urheber: ' + esc(f.a || 'Mitwirkende bei ' + FQ[f.q][0]) + ', Lizenz ' + esc(lic) + (f.q === 'c' ? '' : '. Gesichter und Kennzeichen sind vom Dienst unkenntlich gemacht.') + '</p>'
        + A.sourceLine(link ? 'Original bei ' + FQ[f.q][0] : FQ[f.q][0], link));
      const b = document.getElementById('fotoLaden');
      if (b) b.onclick = () => {
        const im = new Image(); im.alt = f.t || 'Straßenfoto'; im.referrerPolicy = 'no-referrer'; im.className = 'fotoimg'; im.decoding = 'async';
        im.onerror = () => { const bx = document.getElementById('fotoBox'); if (bx) bx.innerHTML = '<p class="note">Das Foto konnte nicht geladen werden.</p>'; };
        im.src = f.u; const bx = document.getElementById('fotoBox'); if (bx) { bx.innerHTML = ''; bx.appendChild(im); }
      };
      A.flyTo({ tx: f.x, tz: f.z, dist: Math.min(A.view.dist, 260), phi: Math.min(A.view.phi, 1.1) }, 900);
    }
    let fotoDone = false;
    A.EXT.layer.push(() => {
      if (!S.L.fotos || fotoDone) return;
      fotoDone = true; setState('fotos', 'lädt …');
      loadScript('data/fotos.js').then(() => {
        const D = window.AL_FOTOS; if (!D) return; const n = { p: 0, c: 0, k: 0 };
        D.items.forEach((f) => { if (!FQ[f.q]) return; n[f.q]++; marker('fotos', '📷', FQ[f.q][1], f.x, 6, f.z, FQ[f.q][0] + (f.t ? ': ' + f.t : ''), (mk) => showFoto(f, mk)); });
        setState('fotos', n.p + ' Panoramax, ' + n.c + ' Commons, ' + n.k + ' KartaView'); A.dirty();
      }, () => { fotoDone = false; setState('fotos', 'nicht verfügbar'); });
    });

    // ------------------------------------------------------------------ 3D-Modelle (GLB, eigener kleiner Leser ohne Zusatzbibliothek)
    async function loadGLB(url) {
      const r = await fetch(url); if (!r.ok) throw new Error(url + ': ' + r.status);
      const buf = await r.arrayBuffer(), dv = new DataView(buf);
      if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('keine GLB-Datei: ' + url);
      const jl = dv.getUint32(12, true), json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)));
      const binStart = 20 + jl + 8;
      if (json.extensionsRequired && json.extensionsRequired.length) throw new Error('Erweiterung nötig: ' + json.extensionsRequired.join(', '));
      const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }, NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
      function acc(i) {
        const a = json.accessors[i], bv = json.bufferViews[a.bufferView], T = CT[a.componentType], nc = NC[a.type];
        const off = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || 0, es = T.BYTES_PER_ELEMENT * nc;
        if (!stride || stride === es) return new THREE.BufferAttribute(new T(buf.slice(off, off + a.count * es)), nc, !!a.normalized);
        const out = new T(a.count * nc), src = new DataView(buf); // verschachtelte Daten entflechten
        for (let k = 0; k < a.count; k++) for (let c = 0; c < nc; c++) out[k * nc + c] = new T(buf.slice(off + k * stride + c * T.BYTES_PER_ELEMENT, off + k * stride + (c + 1) * T.BYTES_PER_ELEMENT))[0];
        void src; return new THREE.BufferAttribute(out, nc, !!a.normalized);
      }
      const texCache = {};
      function texture(ti) {
        if (texCache[ti]) return texCache[ti];
        const img = json.images[json.textures[ti].source], bv = json.bufferViews[img.bufferView];
        const blob = new Blob([new Uint8Array(buf, binStart + (bv.byteOffset || 0), bv.byteLength)], { type: img.mimeType || 'image/jpeg' });
        const t = new THREE.Texture(); t.flipY = false; t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
        const el = new Image(), u = URL.createObjectURL(blob);
        el.onload = () => { t.image = el; t.needsUpdate = true; URL.revokeObjectURL(u); A.dirty(); }; el.src = u;
        return (texCache[ti] = t);
      }
      const group = new THREE.Group();
      (json.nodes || []).forEach((nd) => {
        if (nd.mesh == null) return;
        json.meshes[nd.mesh].primitives.forEach((pr) => {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', acc(pr.attributes.POSITION));
          if (pr.attributes.NORMAL != null) g.setAttribute('normal', acc(pr.attributes.NORMAL)); else g.computeVertexNormals();
          if (pr.attributes.TEXCOORD_0 != null) g.setAttribute('uv', acc(pr.attributes.TEXCOORD_0));
          if (pr.indices != null) g.setIndex(acc(pr.indices));
          const mt = pr.material != null ? json.materials[pr.material] : {}, pbr = mt.pbrMetallicRoughness || {};
          const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
          if (pbr.baseColorTexture) m.map = texture(pbr.baseColorTexture.index);
          else if (pbr.baseColorFactor) m.color.setRGB(pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]);
          if (mt.doubleSided) m.side = THREE.DoubleSide;
          const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = nd.name || ''; // "Fluegel" = drehbares Flügelkreuz (Drehpunkt = Knotenursprung)
          if (nd.translation) mesh.position.fromArray(nd.translation);
          if (nd.rotation) mesh.quaternion.fromArray(nd.rotation);
          if (nd.scale) mesh.scale.fromArray(nd.scale);
          group.add(mesh);
        });
      });
      return group;
    }
    MODELLE.forEach((md) => {
      md.lod = new THREE.LOD(); md.lod.position.set(md.x, 0, md.z); md.lod.visible = false; md.loaded = []; md.busy = [];
      md.lod.rotation.y = md.dreh || 0; md.winkel = 0; // Ausrichtung des Modells (Mühlen: Flügelseite)
      A.scene.add(md.lod);
      md.need = function () {
        if (!S.L.modelle) return;
        const d = A.camera.position.distanceTo(md.lod.position);
        if (d > md.laden) return;
        // grobe Stufe zuerst, feinere erst in der Nähe (Ladezeit)
        [2, 1, 0].forEach((lv) => {
          if (md.loaded[lv] || md.busy[lv] || d > (lv === 0 ? md.stufen[1] * 1.6 : lv === 1 ? md.stufen[2] * 1.6 : md.laden)) return;
          md.busy[lv] = true;
          loadGLB(md.datei + lv + '.glb?v=' + A.tv()).then((g) => {
            md.loaded[lv] = g;
            // Stufen neu einsortieren: vorhandene feinste Stufe ab 0 m, gröbere ab ihrer Umschaltentfernung
            md.lod.levels.slice().forEach((l) => md.lod.remove(l.object)); md.lod.levels.length = 0;
            let first = true;
            [0, 1, 2].forEach((k) => { if (md.loaded[k]) { md.lod.addLevel(md.loaded[k], first ? 0 : md.stufen[k]); first = false; } });
            md.lod.visible = S.L.modelle; A.setHidden(md.ersetzt, S.L.modelle); A.dirty();
          }, (e) => { console.warn('3D-Modell nicht geladen:', e.message); md.busy[lv] = false; });
        });
      };
    });
    A.EXT.layer.push(() => {
      S.L.modelleHl = S.L.modelle; // Marker der hervorgehobenen Anlaufpunkte folgen dem Schalter "3D-Modelle" (eigene Sichtweite, NFD.modelleHl)
      MODELLE.forEach((md) => { const has = md.loaded.some(Boolean); md.lod.visible = S.L.modelle && has; A.setHidden(md.ersetzt, S.L.modelle && has); md.need(); });
      HL.visible = S.L.modelle;
    });
    let mdLast = 0;
    A.EXT.frame.push(() => { const t = performance.now(); if (t - mdLast > 500) { mdLast = t; MODELLE.forEach((md) => md.need()); } });

    // Quellentexte der Modelle (Wikimedia-Urheber, Lizenzen, Annahmen) liegen in data/modelle_quellen.js und werden erst bei Bedarf geladen
    function quelleVon(md) {
      if (md.quelle) return Promise.resolve(md.quelle);
      return loadScript('data/modelle_quellen.js').then(() => (window.AL_MODELLE_Q && window.AL_MODELLE_Q[md.id]) || 'Quellen siehe Quellen-Dialog.', () => 'Quellentext nicht verfügbar.');
    }
    const TYP = { kirche: 'Kirche', muehle: 'Bockwindmühle', anlauf: 'Anlaufpunkt', turm: 'Wahrzeichen' };
    function modellKarte(md, mk) {
      selMk(mk);
      A.openCard('<h3>' + esc(md.name) + '</h3><p class="sub">' + esc(TYP[md.typ] || '') + (md.ot ? ' · ' + esc(md.ot) : '') + ' · 3D-Modell, vereinfacht</p><div id="mdInfo"><p class="note">Quellen werden geladen …</p></div>');
      quelleVon(md).then((t) => {
        const el = document.getElementById('mdInfo'); if (!el) return;
        el.innerHTML = (md.fluegel ? '<p class="note"><b>Hinweis:</b> Die Flügel drehen sich nur in der Darstellung. Die Mühle steht in Wirklichkeit fest.</p>' : '') + '<p class="note">' + esc(t) + '</p>';
      });
      A.flyTo({ tx: md.x, tz: md.z, dist: Math.min(A.view.dist, md.typ === 'anlauf' ? 260 : 190), phi: Math.min(A.view.phi, 1.0) }, 900);
    }
    A.EXT.pick.push((x, z) => {
      if (!S.L.modelle) return '';
      const md = MODELLE.find((m) => m.loaded.some(Boolean) && Math.hypot(m.x - x, m.z - z) < (m.hlr || 20)); if (!md) return '';
      return '<h4>3D-Modell: ' + esc(md.name) + '</h4>' + (md.quelle ? '<p class="note">' + esc(md.quelle) + '</p>' : '<p class="note">Vereinfachtes Modell. Quellen, Lizenzen und Annahmen: Marker anklicken oder Quellen-Dialog.</p>');
    });

    // Beschriftete Marker (Buchstabe K Kirche, M Mühle, A Anlaufpunkt) und Hervorhebung der Anlaufpunkte (goldener Ring und Lichtsäule am Boden)
    const HL = new THREE.Group(); A.scene.add(HL);
    const gold = new THREE.Color('#F2C14E');
    MODELLE.forEach((md) => {
      if (md.typ === 'turm') return; // Wahrzeichen: ohne eigenen Marker
      const hl = !!md.hl, sym = md.typ === 'kirche' ? 'K' : md.typ === 'muehle' ? 'M' : 'A';
      const mk = A.addMarker('nf md' + (hl ? ' hl' : ''), sym, md.x, (md.hoehe || 12) + (hl ? 8 : 5), md.z, () => modellKarte(md, mk), md.name);
      mk.grp = hl ? 'modelleHl' : 'modelle'; mk.el.title = md.name;
      mk.el.style.setProperty('--c', md.typ === 'kirche' ? '#6f79d1' : md.typ === 'muehle' ? '#c27b3a' : '#F2C14E');
      if (!hl) return;
      const ring = new THREE.Mesh(new THREE.RingGeometry(md.hlr - 2.2, md.hlr, 64).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: gold, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -9, polygonOffsetUnits: -9 }));
      ring.position.set(md.x, 0.95, md.z); ring.renderOrder = 9; HL.add(ring);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 100, 12, 1, true).translate(0, 50, 0), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, uniforms: { uC: { value: gold } },
        vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 uC; varying float vY; void main(){ float a = (1.0 - vY / 100.0); a = a * a * 0.5; gl_FragColor = vec4(uC * a, a); }' }));
      beam.position.set(md.x, 0, md.z); beam.renderOrder = 10; HL.add(beam);
    });

    // Drehende Flügel der Bockwindmühlen: eine Umdrehung in 24 s, nur bei eingeschalteter Ebene, geladenem Modell, Kameraabstand unter 1200 m und im Bild;
    // bei eingestellter reduzierter Bewegung (prefers-reduced-motion) stehen die Flügel. Läuft ohne Mühle im Bild nicht (kein Dauerzeichnen).
    const MUEHLEN = MODELLE.filter((m) => m.fluegel), RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    const fr = new THREE.Frustum(), fm = new THREE.Matrix4(), fs = new THREE.Sphere();
    let wLast = 0; A.MUEHLEN = MUEHLEN;
    function wStep(now) {
      requestAnimationFrame(wStep);
      const dt = Math.min(1, (now - (wLast || now)) / 1000); wLast = now; // Zeit statt Bildzahl: gleiche Drehzahl auch bei langsamen Geräten
      if (RM.matches || document.hidden || !S.L.modelle) return;
      let an = false;
      MUEHLEN.forEach((md) => {
        md.dreht = false;
        if (!md.lod.visible || !md.loaded.some(Boolean) || A.camera.position.distanceTo(md.lod.position) > 1200) return;
        if (!an) { A.camera.updateMatrixWorld(); fm.multiplyMatrices(A.camera.projectionMatrix, A.camera.matrixWorldInverse); fr.setFromProjectionMatrix(fm); }
        fs.set(new THREE.Vector3(md.x, md.hoehe * 0.8, md.z), 16);
        if (!fr.intersectsSphere(fs)) return;
        md.winkel = (md.winkel + dt * 2 * Math.PI / 24) % (2 * Math.PI); md.dreht = true; an = true;
        md.lod.levels.forEach((l) => l.object.children.forEach((c) => { if (c.name === 'Fluegel') c.rotation.x = md.winkel; }));
      });
      if (an) A.dirty();
    }
    if (MUEHLEN.length) requestAnimationFrame(wStep);

    // ------------------------------------------------------------------ Straßenlampen bei Dunkelheit (data/lampen.js, scripts/prepare_lampen.py)
    // Keine echten Lichtquellen: leuchtende Köpfe als Punkte (ein Zeichenaufruf) und je Lampe ein weicher Lichtfleck am Boden (Instanzen).
    // Ein bei bürgerlicher Dämmerung (Sonne unter -6°), weich zwischen -4,5° und -7,5°. Schwache Geräte: halb so viele ergänzte Lampen, keine Lichtflecken.
    let NACHT_F = 0;
    const LP = { pts: null, pool: null, poles: null, fade: -1, busy: false };
    const schwach = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4 || matchMedia('(pointer: coarse)').matches;
    function lpBuild() {
      const D = window.AL_LAMPEN; if (!D || LP.pts) return;
      const xs = [], src = [];
      for (let i = 0; i < D.r.length; i += 2) { xs.push(D.r[i], D.r[i + 1]); src.push(1); }
      for (let i = 0, k = 0; i < D.s.length; i += 2, k++) { if (schwach && k % 2) continue; xs.push(D.s[i], D.s[i + 1]); src.push(0); }
      const n = xs.length / 2, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pos[i * 3] = xs[i * 2]; pos[i * 3 + 1] = 6.2; pos[i * 3 + 2] = xs[i * 2 + 1]; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const ptMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uFade: { value: 0 }, uScale: { value: A.renderer.getPixelRatio() } },
        vertexShader: 'uniform float uScale; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(4400.0 / -mv.z, 4.0, 56.0) * uScale; gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'uniform float uFade; void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c) * 2.0; float a = smoothstep(1.0, 0.0, d); a = a * a; vec3 col = mix(vec3(1.0, 0.62, 0.25), vec3(1.0, 0.95, 0.85), smoothstep(0.5, 0.0, d)); gl_FragColor = vec4(col * a * uFade, a * uFade); }',
      });
      LP.pts = new THREE.Points(g, ptMat); LP.pts.frustumCulled = false; LP.pts.renderOrder = 12; A.scene.add(LP.pts);
      const m4 = new THREE.Matrix4();
      if (!schwach) {
        const poolMat = new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10, uniforms: { uFade: { value: 0 } },
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
          fragmentShader: 'uniform float uFade; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); a *= a * 1.0 * uFade; gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * a, a); }',
        });
        LP.pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2), poolMat, n);
        for (let i = 0; i < n; i++) { m4.makeTranslation(pos[i * 3], 0.7, pos[i * 3 + 2]); LP.pool.setMatrixAt(i, m4); }
        LP.pool.frustumCulled = false; LP.pool.renderOrder = 11; A.scene.add(LP.pool);
        LP.poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, 6.2, 5).translate(0, 3.1, 0), new THREE.MeshLambertMaterial({ color: 0x3a3f47 }), n);
        for (let i = 0; i < n; i++) { m4.makeTranslation(pos[i * 3], 0, pos[i * 3 + 2]); LP.poles.setMatrixAt(i, m4); }
        A.scene.add(LP.poles);
      }
      setState('nachtlicht', D.r.length / 2 + ' aus OSM, ' + (n - D.r.length / 2) + ' ergänzt (symbolisch)' + (schwach ? ', reduziert' : ''));
      LP.fade = -1; A.dirty();
    }
    function lpTick() {
      const alt = S.sunAlt == null ? 30 : S.sunAlt;
      const nacht = Math.min(1, Math.max(0, (-alt - 4.5) / 3)), f = S.L.nachtlicht ? nacht : 0;
      NACHT_F = nacht; // Fahrzeuglicht folgt nur der Dunkelheit, nicht dem Lampen-Schalter
      if (A.setNacht) A.setNacht(nacht); // Scheinwerfer und Rücklichter von Zug und Bus (js/app.js), gleicher Auslöser
      if (f > 0 && !LP.pts && !LP.busy && !LP.fehlt) { LP.busy = true; loadScript('data/lampen.js').then(lpBuild, () => { LP.busy = false; LP.fehlt = true; setState('nachtlicht', 'nicht verfügbar'); }); }
      if (!LP.pts || Math.abs(f - LP.fade) < 0.002) return;
      LP.fade = f;
      const vis = f > 0.002;
      LP.pts.visible = vis; LP.pts.material.uniforms.uFade.value = f;
      if (LP.pool) { LP.pool.visible = vis; LP.pool.material.uniforms.uFade.value = f; }
      if (LP.poles) LP.poles.visible = vis;
      A.dirty();
    }
    A.EXT.frame.push(lpTick);

    // ------------------------------------------------------------------ Autoverkehr (Simulation) auf dem OSM-Straßennetz (data/verkehr.js, scripts/prepare_verkehr.py)
    // Keine Messwerte: Dichte je Straßenklasse und Tempo sind angenommen. Instanzen (je Fahrzeugart ein Zeichenaufruf), Lichter als Punkte, Lichtkegel als Instanzen.
    const VK = { on: false, ways: null, veh: [], meshes: null, last: 0, tempo: 1 }; A.VK = VK; // A.VK.tempo = 0 hält den Verkehr an (Prüfen)
    const VK_DICHTE = [10, 6, 3, 1, 0.35], VK_TEMPO = [25, 22, 19, 16, 8.5];   // Gewicht je Meter, m/s außerorts (innerorts 13,9)
    const VK_ART = { pkw: { l: 4.4, b: 1.8, h: 1.45, n: 0 }, lkw: { l: 10, b: 2.5, h: 3.4, n: 1 }, krad: { l: 2.1, b: 0.8, h: 1.3, n: 2 } };
    const VK_FARBEN = ['#d9dde3', '#1d2127', '#7d8590', '#a4232d', '#21457a', '#e8e3d4', '#3b5f3a', '#c4c8ce'];
    function vkPrep() {
      const D = window.AL_VERKEHR; if (!D || VK.ways) return;
      VK.ways = D.w.map((w) => {
        const p = w.slice(2), n = p.length / 2, cum = new Float32Array(n); for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
        return { k: w[0], ort: w[1], p, n, cum, L: cum[n - 1] };
      });
      const key = (x, z) => Math.round(x / 4) + ',' + Math.round(z / 4), ends = {};
      VK.ways.forEach((w, i) => { [0, 1].forEach((e) => { const j = e ? w.n - 1 : 0, k = key(w.p[j * 2], w.p[j * 2 + 1]); (ends[k] = ends[k] || []).push([i, e]); }); w.ek = [key(w.p[0], w.p[1]), key(w.p[w.n * 2 - 2], w.p[w.n * 2 - 1])]; });
      VK.ends = ends;
      const tot = VK.ways.reduce((a, w) => a + w.L * VK_DICHTE[w.k], 0), N = schwach ? 90 : 260;
      const rnd = (() => { let s = 20261125; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })(); // stabil: gleiche Verteilung bei jedem Laden
      VK.rnd = rnd;
      for (let i = 0; i < N; i++) {
        let r = rnd() * tot, w = 0; while (w < VK.ways.length - 1 && (r -= VK.ways[w].L * VK_DICHTE[VK.ways[w].k]) > 0) w++;
        const W = VK.ways[w], big = W.k <= 2, u = rnd(), art = u < (big ? 0.14 : 0.03) ? 'lkw' : u > 0.94 ? 'krad' : 'pkw';
        VK.veh.push({ w, s: rnd() * W.L, dir: rnd() < 0.5 ? 1 : -1, art, f: 0.88 + rnd() * 0.24, c: VK_FARBEN[Math.floor(rnd() * VK_FARBEN.length)], seg: 1, x: 0, z: 0, a: 0 });
      }
      vkMeshes();
    }
    function vkMeshes() {
      const cnt = { pkw: 0, lkw: 0, krad: 0 }; VK.veh.forEach((v) => { v.idx = cnt[v.art]++; });
      const lam = () => new THREE.MeshLambertMaterial({ color: 0xffffff });
      const M = {};
      Object.keys(VK_ART).forEach((a) => {
        const t = VK_ART[a], n = Math.max(1, cnt[a]);
        const body = new THREE.InstancedMesh(new THREE.BoxGeometry(t.l, a === 'pkw' ? t.h * 0.55 : t.h, t.b).translate(0, (a === 'pkw' ? t.h * 0.55 : t.h) / 2 + 0.25, 0), lam(), n);
        const top = new THREE.InstancedMesh(a === 'pkw' ? new THREE.BoxGeometry(t.l * 0.5, t.h * 0.42, t.b * 0.9).translate(-0.2, t.h * 0.55 + 0.25 + t.h * 0.21, 0)
          : a === 'lkw' ? new THREE.BoxGeometry(2.2, 2.9, t.b).translate(t.l / 2 + 1.15, 1.7, 0) : new THREE.BoxGeometry(0.5, 0.7, 0.5).translate(-0.2, t.h + 0.1, 0), lam(), n);
        body.count = top.count = cnt[a]; body.frustumCulled = top.frustumCulled = false;
        A.scene.add(body); A.scene.add(top); M[a] = { body, top };
      });
      const c = new THREE.Color();
      VK.veh.forEach((v) => {
        const m = M[v.art]; m.body.setColorAt(v.idx, c.set(v.art === 'lkw' ? '#e7e9ec' : v.c));
        m.top.setColorAt(v.idx, c.set(v.art === 'pkw' ? '#2b3440' : v.art === 'lkw' ? v.c : '#30343a'));
      });
      Object.values(M).forEach((m) => { if (m.body.instanceColor) m.body.instanceColor.needsUpdate = true; if (m.top.instanceColor) m.top.instanceColor.needsUpdate = true; });
      // Nachtlicht: Scheinwerfer (warmweiß) und Rücklichter (rot) als Punkte, Lichtkegel als flache Instanzen
      const n = VK.veh.length, mkPts = (col, size) => {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
        const p = new THREE.Points(g, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uFade: { value: 0 }, uCol: { value: new THREE.Color(col) }, uScale: { value: A.renderer.getPixelRatio() } },
          vertexShader: 'uniform float uScale; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(' + size.toFixed(1) + ' / -mv.z, 2.5, 30.0) * uScale; gl_Position = projectionMatrix * mv; }',
          fragmentShader: 'uniform float uFade; uniform vec3 uCol; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); a *= a * uFade; gl_FragColor = vec4(uCol * a, a); }' }));
        p.frustumCulled = false; p.renderOrder = 14; p.visible = false; A.scene.add(p); return p;
      };
      const cone = new THREE.InstancedMesh(new THREE.PlaneGeometry(28, 11).rotateX(-Math.PI / 2).translate(14, 0.35, 0), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12, uniforms: { uFade: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform float uFade; varying vec2 vUv; void main(){ float w = mix(0.1, 0.5, vUv.x); float side = 1.0 - smoothstep(w * 0.55, w, abs(vUv.y - 0.5)); float a = side * smoothstep(0.0, 0.1, vUv.x) * (1.0 - vUv.x) * 1.5 * uFade; gl_FragColor = vec4(vec3(1.0, 0.9, 0.72) * a, a); }' }), n);
      cone.frustumCulled = false; cone.renderOrder = 13; cone.visible = false; A.scene.add(cone);
      VK.meshes = { M, head: mkPts('#fff3d6', 2600), tail: mkPts('#ff2a1a', 1800), cone };
    }
    function vkNext(v) { // am Ende des Abschnitts: anschließenden Abschnitt wählen (größere Straßen bevorzugt), sonst wenden
      const W = VK.ways[v.w], endKey = W.ek[v.dir > 0 ? 1 : 0], opts = (VK.ends[endKey] || []).filter((o) => o[0] !== v.w);
      if (!opts.length) { v.dir = -v.dir; v.s = v.dir > 0 ? 0 : W.L; return; }
      let tot = 0; opts.forEach((o) => { tot += VK_DICHTE[VK.ways[o[0]].k] + 0.2; });
      let r = VK.rnd() * tot, pick = opts[0]; for (const o of opts) { if ((r -= VK_DICHTE[VK.ways[o[0]].k] + 0.2) <= 0) { pick = o; break; } }
      v.w = pick[0]; const N = VK.ways[v.w]; v.dir = pick[1] === 0 ? 1 : -1; v.s = v.dir > 0 ? 0 : N.L; v.seg = 1;
    }
    function vkPos(v) {
      const W = VK.ways[v.w], cum = W.cum, p = W.p; let i = Math.min(Math.max(1, v.seg), W.n - 1);
      while (i < W.n - 1 && cum[i] < v.s) i++; while (i > 1 && cum[i - 1] > v.s) i--; v.seg = i;
      const t = (v.s - cum[i - 1]) / Math.max(0.01, cum[i] - cum[i - 1]), ax = p[i * 2 - 2], az = p[i * 2 - 1], bx = p[i * 2], bz = p[i * 2 + 1];
      let dx = (bx - ax) * v.dir, dz = (bz - az) * v.dir; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const off = W.k <= 3 ? 1.8 : 1.3; // Rechtsverkehr: Fahrspur rechts der Mitte
      v.x = ax + (bx - ax) * t - dz * off; v.z = az + (bz - az) * t + dx * off;
      const na = Math.atan2(dz, dx); let da = na - v.a; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; v.a += Math.abs(da) > 1.2 ? da : da * 0.35;
    }
    const vkM4 = new THREE.Matrix4(), vkQ = new THREE.Quaternion(), vkS = new THREE.Vector3(1, 1, 1), vkP = new THREE.Vector3(), vkY = new THREE.Vector3(0, 1, 0);
    function vkStep(now) {
      requestAnimationFrame(vkStep);
      if (!VK.meshes) return;
      const show = S.L.verkehr && A.view.dist < 16000;
      Object.values(VK.meshes.M).forEach((m) => { m.body.visible = m.top.visible = show; });
      const nf = show ? NACHT_F : 0; ['head', 'tail', 'cone'].forEach((k) => { const o = VK.meshes[k]; o.visible = nf > 0.002; o.material.uniforms.uFade.value = nf; });
      if (!show || document.hidden) { if (VK.wasShown) { VK.wasShown = false; A.dirty(); } VK.last = now; return; }
      VK.wasShown = true;
      const dt = Math.min(0.1, (now - (VK.last || now)) / 1000); VK.last = now;
      const hp = VK.meshes.head.geometry.attributes.position, tp = VK.meshes.tail.geometry.attributes.position;
      VK.veh.forEach((v, i) => {
        const W = VK.ways[v.w], vmax = (W.ort ? Math.min(13.9, VK_TEMPO[W.k]) : VK_TEMPO[W.k]) * v.f * (v.art === 'lkw' ? 0.85 : v.art === 'krad' ? 1.08 : 1);
        v.s += v.dir * vmax * dt * VK.tempo;
        if (v.s > W.L || v.s < 0) vkNext(v);
        vkPos(v);
        const t = VK_ART[v.art], m = VK.meshes.M[v.art];
        vkQ.setFromAxisAngle(vkY, -v.a); vkP.set(v.x, 0.1, v.z); vkM4.compose(vkP, vkQ, vkS);
        m.body.setMatrixAt(v.idx, vkM4); m.top.setMatrixAt(v.idx, vkM4);
        if (nf > 0.002) {
          VK.meshes.cone.setMatrixAt(i, vkM4.compose(vkP.set(v.x + Math.cos(v.a) * t.l / 2, 0.1, v.z + Math.sin(v.a) * t.l / 2), vkQ, vkS));
          const c = Math.cos(v.a), s = Math.sin(v.a), hx = t.l / 2 + (v.art === 'lkw' ? 2.3 : 0.05), sw = v.art === 'krad' ? 0.01 : t.b * 0.36, y = v.art === 'lkw' ? 0.9 : 0.75;
          [-1, 1].forEach((sd, q) => {
            hp.setXYZ(i * 2 + q, v.x + c * hx - s * sd * sw, y, v.z + s * hx + c * sd * sw);
            tp.setXYZ(i * 2 + q, v.x - c * (t.l / 2 + 0.05) - s * sd * sw, y, v.z - s * (t.l / 2 + 0.05) + c * sd * sw);
          });
        }
      });
      Object.values(VK.meshes.M).forEach((m) => { m.body.instanceMatrix.needsUpdate = true; m.top.instanceMatrix.needsUpdate = true; });
      if (nf > 0.002) { hp.needsUpdate = true; tp.needsUpdate = true; VK.meshes.cone.instanceMatrix.needsUpdate = true; }
      A.dirty();
    }
    A.EXT.layer.push(() => {
      if (S.L.verkehr && !VK.ways && !VK.busy) {
        VK.busy = true; setState('verkehr', 'lädt …');
        loadScript('data/verkehr.js').then(() => { vkPrep(); setState('verkehr', VK.veh.length + ' Fahrzeuge, Simulation' + (schwach ? ' (reduziert)' : '')); requestAnimationFrame(vkStep); }, () => { VK.busy = false; setState('verkehr', 'nicht verfügbar'); });
      }
      if (!S.L.verkehr && VK.meshes) { Object.values(VK.meshes.M).forEach((m) => { m.body.visible = m.top.visible = false; }); A.dirty(); }
    });
    A.EXT.layer.push(() => { if (!S.L.nachtlicht) setState('nachtlicht', ''); lpTick(); });

    // ------------------------------------------------------------------ Quellen-Dialog ergänzen
    const ul = document.querySelector('#sourcesBody ul');
    if (ul) {
      const L = (u, t) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>', DL = L('https://www.govdata.de/dl-de/by-2-0', 'dl-de/by-2-0'), SA = L('https://creativecommons.org/licenses/by-sa/4.0/deed.de', 'CC BY-SA 4.0');
      [
        O.bplan ? '<b>Bebauungspläne und Satzungen:</b> Planungsinformationssystem PLIS der Gemeinsamen Landesplanungsabteilung Berlin-Brandenburg (WFS „bebauungsplaene_rechtswirksam_wfs“ und „satzungen_wfs“), ' + DL + ' (Daten geändert: auf das Gebiet zugeschnitten, Umrisse vereinfacht). Nur Geltungsbereiche, rechtsverbindlich ist allein der Plan bei der Kommune.' : '',
        O.flurst ? '<b>Flurstücke:</b> Liegenschaftskataster ALKIS (vereinfachtes Schema), © GeoBasis-DE/LGB, ' + DL + ' (Daten geändert). Ohne Eigentümerangaben, kein amtlicher Auszug.' : '',
        O.glasfaser ? '<b>Glasfaser:</b> Breitbandatlas der Bundesnetzagentur (Gigabit-Grundbuch), Ebene „100-m-Gitter, Glasfaser FTTB/H“, © BNetzA. ' + esc((window.AL_GLASFASER && window.AL_GLASFASER.quelle) || 'Datenstand siehe Bildebene (Daten geändert: Ausschnitt, eigene Farben).') : '',
        O.mobil ? '<b>Parken und Mobilität:</b> © OpenStreetMap-Mitwirkende, ' + L('https://www.openstreetmap.org/copyright', 'ODbL') + '. Was im Gebiet nicht eingetragen ist (zum Beispiel Taxi, Carsharing, Mitfahrbänke, Fahrkartenverkauf), fehlt auch hier.' : '',
        O.fotos ? '<b>Straßenfotos:</b> ' + L('https://panoramax.fr/', 'Panoramax') + ' (' + SA + ', Urheber je Bild), ' + L('https://commons.wikimedia.org/', 'Wikimedia Commons') + ' (freie Lizenz und Urheber je Bild, ohne Bilder mit NC/ND) und ' + L('https://kartaview.org/', 'KartaView') + ' (' + SA + '). Die Fotos lädt Ihr Browser erst nach Klick auf „Foto anzeigen“ direkt beim Dienst.' : '',
        O.nachtlicht ? '<b>Straßenlampen bei Dunkelheit:</b> Lampen aus OpenStreetMap (ODbL); die übrigen Lampen sind <b>symbolisch</b> alle 35 m entlang der Ortsstraßen ergänzt und zeigen keine echten Standorte. Fahrzeuglichter sind ebenfalls nur Darstellung.' : '',
        O.verkehr ? '<b>Autoverkehr:</b> <b>Simulation</b> auf dem Straßennetz aus OpenStreetMap (ODbL). Anzahl, Verteilung und Tempo sind angenommen, keine Verkehrszählung und keine Echtzeitdaten.' : '',
        O.modelle && MODELLE.length ? '<b>3D-Modelle:</b> eigene vereinfachte Modelle einzelner Gebäude, keine Bauaufnahme. Die Drehung von Mühlenflügeln ist nur Darstellung. <details id="mdQD"><summary>Quellen und Annahmen je Modell</summary><div id="mdQL"></div></details>' : '',
      ].filter(Boolean).forEach((h) => { const li = document.createElement('li'); li.innerHTML = h; ul.appendChild(li); });
      const mdQD = document.getElementById('mdQD');
      if (mdQD) mdQD.addEventListener('toggle', () => {
        if (!mdQD.open) return;
        loadScript('data/modelle_quellen.js').catch(() => null).then(() => {
          const q = window.AL_MODELLE_Q || {};
          document.getElementById('mdQL').innerHTML = '<ul>' + MODELLE.filter((m) => m.id).map((m) => '<li><b>' + esc(m.name) + ':</b> ' + esc(m.quelle || q[m.id] || '') + '</li>').join('') + '</ul>';
        });
      });
    }

    A.applyLayers();
  }
  window.AL_EBENEN = init;
  if (window.AL_APP) init(window.AL_APP);
})();

/* Ebene "Parkplätze" der 3D-Karte (25.11.2026): ausgewiesene Parkplätze mit Gebührenangabe (kostenpflichtig, frei oder nicht angegeben),
   Parkflächen als dezente Kontur und Parkregeln am Straßenrand als Band (kostenpflichtig, frei, Parkscheibe, Parkverbot) aus OpenStreetMap (ODbL).
   Daten: data/parken.js (scripts/fetch_parkplaetze.py), geladen erst beim Einschalten der Ebene. Hängt an der Schnittstelle window.AL_APP aus js/app.js
   (EXT.layer, EXT.frame, EXT.pick, addMarker, NFD). Alle Angaben stammen von Mitwirkenden; fehlt eine Angabe, wird sie nicht geraten.
   Übertragbar: Die Ebene kennt keine Gemeinde. */
(function () {
  'use strict';
  const HAFT = 'Angaben ohne Gewähr, aus OpenStreetMap bzw. offenen Daten. Maßgeblich ist die Beschilderung vor Ort. Nutzung auf eigene Gefahr.';
  const HAFT_HTML = '<p class="note haft">' + HAFT + ' <a href="impressum.html#haftung" target="_blank" rel="noopener">Haftungsausschluss</a></p>';
  const COL = { B: '#e0882a', F: '#2fa764', S: '#3a8fe0', V: '#d04a4a', U: '#8a8f98' }; // kostenpflichtig, frei, Parkscheibe, Verbot, unbekannt
  const ART = { P: 'Parkplatz', K: 'Kundenparkplatz', H: 'Parkhaus', T: 'Tiefgarage', D: 'Parkdeck', R: 'Park-and-Ride-Parkplatz', S: 'Parkstreifen am Straßenrand' };
  const ZUGANG = { p: 'öffentlich nutzbar', k: 'nur für Kunden', b: 'nur mit Berechtigung (Genehmigung)', d: 'nur Zielverkehr' };
  const KLASSE = { B: 'Kostenpflichtig', F: 'Gebührenfrei', S: 'Parkscheibe oder zeitlich begrenzt', V: 'Parkverbot' };

  function init(A) {
    if (init.done) return; init.done = true;
    const THREE = A.THREE, S = A.S, esc = A.esc, $ = (s) => document.querySelector(s);
    const PK = { busy: false, ok: false, filter: 'all', data: null, group: null, rings: [], marks: [], bands: null, mat: null, bandMarks: [] };
    A.NFD.parken = 3600;
    const fmtDe = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? +m[3] + '.' + +m[2] + '.' + m[1] : (iso || ''); };
    const setState = (t) => { const el = document.getElementById('st-parken'); if (el) el.textContent = t ? ' · ' + t : ''; };
    function loadData() {
      return new Promise((ok, no) => {
        if (window.AL_PARKEN) return ok(window.AL_PARKEN);
        const s = document.createElement('script'); s.src = 'data/parken.js?v=' + A.tv(); s.async = true;
        s.onload = () => (window.AL_PARKEN ? ok(window.AL_PARKEN) : no(new Error('leer'))); s.onerror = () => no(new Error('nicht geladen'));
        document.head.appendChild(s);
      });
    }
    const lotCls = (it) => (it.f === 'y' || it.f === 'z' ? 'paid' : it.f === 'n' ? 'free' : 'unk');
    const lotCol = (it) => (it.f === 'y' || it.f === 'z' ? COL.B : it.f === 'n' ? COL.F : COL.U);
    const showLot = (it) => PK.filter === 'all' || PK.filter === lotCls(it);
    const showBand = (k) => PK.filter === 'all' || (PK.filter === 'paid' && k === 'B') || (PK.filter === 'free' && k === 'F');

    // ---- Angaben in Worten
    function row(k, v) { return v ? '<dt>' + k + '</dt><dd>' + v + '</dd>' : ''; }
    function feeHtml(it) {
      if (it.f === 'y') return '<b class="pk-tag paid">Bezahlparkplatz</b>' + (it.ch ? ' ' + esc(it.ch) : '<span class="s">Preis nicht in OpenStreetMap angegeben</span>') + (it.fc ? '<span class="s">' + esc(it.fc) + '</span>' : '');
      if (it.f === 'z') return '<b class="pk-tag paid">Zeitweise kostenpflichtig</b>' + (it.fc ? '<span class="s">' + esc(it.fc) + '</span>' : '') + (it.ch ? '<span class="s">' + esc(it.ch) + '</span>' : '');
      if (it.f === 'n') return '<b class="pk-tag free">Kostenlos parken</b>';
      return '<b class="pk-tag unk">Gebühr nicht angegeben</b><span class="s">Gebühr: nicht in OpenStreetMap angegeben</span>';
    }
    function lotCard(it) {
      const platz = [it.n ? it.n + ' Stellplätze' : '', it.nb ? it.nb + ' für Menschen mit Behinderung' : '', it.nl ? it.nl + ' mit Lademöglichkeit' : ''].filter(Boolean).join(', ');
      const ms = [it.ms ? esc(it.ms) : '', it.mc ? esc(it.mc) : ''].filter(Boolean).join('<br>');
      const sub = [it.nm ? ART[it.a] || 'Parkplatz' : '', it.sa || ''].filter(Boolean).join(' · ');
      const h = '<h3>' + esc(it.nm || ART[it.a] || 'Parkplatz') + '</h3>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') + '<dl>'
        + row('Gebühr', feeHtml(it))
        + row('Zugang', ZUGANG[it.zu] ? esc(ZUGANG[it.zu]) : 'nicht in OpenStreetMap angegeben')
        + row('Zeiten', it.oh ? esc(it.oh) : '') + row('Höchstparkdauer', ms) + row('Plätze', esc(platz))
        + row('Bewacht', it.su === 'y' ? 'ja' : it.su === 'n' ? 'nein' : '') + row('Beleuchtet', it.li === 'y' ? 'ja' : it.li === 'n' ? 'nein' : '')
        + row('Belag', it.sf ? esc(it.sf) : '') + row('Betreiber', it.op ? esc(it.op) : '') + '</dl>'
        + '<p class="note">Angaben von OpenStreetMap-Mitwirkenden, ohne Gewähr; maßgeblich ist die Beschilderung vor Ort.</p>' + HAFT_HTML;
      return h + (it.o ? A.sourceLine('OpenStreetMap, Objekt ' + it.o, 'https://www.openstreetmap.org/' + it.o) : A.sourceLine(it.q || 'Handpflege'));
    }
    function bandCard(g) {
      const zeiten = g.ti ? esc(g.ti) : '', ms = [g.ms ? esc(g.ms) : '', g.mc ? esc(g.mc) : ''].filter(Boolean).join('<br>');
      let regel = '<b class="pk-tag k' + g.k + '">' + esc(KLASSE[g.k]) + '</b>';
      if (g.k === 'S' && g.sc) regel += '<span class="s">Parkscheibe erforderlich</span>';
      if (g.k === 'V' && g.rs) regel += '<span class="s">' + esc(g.rs) + '</span>' + (g.rc ? '<span class="s">' + esc(g.rc) + '</span>' : '');
      if (g.ch) regel += '<span class="s">' + esc(g.ch) + '</span>';
      if (g.fc) regel += '<span class="s">' + esc(g.fc) + '</span>';
      const h = '<h3>' + esc(g.nm || 'Straße ohne Namen in OpenStreetMap') + '</h3><p class="sub">Parken am Straßenrand · Abschnitt von rund ' + g.l + ' m</p><dl>'
        + row('Regel', regel) + row('Zeiten', zeiten) + row('Höchstparkdauer', ms) + row('Art', g.sa ? esc(g.sa) : '') + row('Ausrichtung', g.or ? esc(g.or) : '') + (g.tx ? row('Hinweis', esc(g.tx)) : '') + '</dl>'
        + '<p class="note">Nur Abschnitte, für die in OpenStreetMap eine Parkregel eingetragen ist. Wo nichts gezeichnet ist, heißt das nicht, dass dort frei geparkt werden darf.</p>' + HAFT_HTML;
      const o = g.o || [];
      return h + (g.q ? A.sourceLine(g.q) : o.length ? A.sourceLine('OpenStreetMap, ' + o.slice(0, 3).join(', ') + (o.length > 3 ? ' u. a.' : ''), 'https://www.openstreetmap.org/' + o[0]) : '');
    }
    function selMk(mk) { document.querySelectorAll('.mk.sel').forEach((m) => m.classList.remove('sel')); if (mk) mk.el.classList.add('sel'); }
    function fly(x, z) { A.flyTo({ tx: x, tz: z, dist: Math.min(A.view.dist, 280), phi: Math.min(A.view.phi, 1.1) }, 900); }

    // ---- Aufbau (einmalig, beim ersten Einschalten)
    function build(D) {
      PK.data = D; PK.group = new THREE.Group(); A.scene.add(PK.group);
      D.items.forEach((it) => {
        const c = lotCol(it), sym = it.f === 'y' || it.f === 'z' ? 'P€' : 'P';
        const mk = A.addMarker('nf', sym, it.x, 8, it.z, () => { selMk(mk); A.openCard(lotCard(it)); fly(it.x, it.z); }, null);
        mk.grp = 'parken'; mk.el.classList.add('pk'); mk.el.style.setProperty('--c', c); mk.el.title = (it.nm || ART[it.a] || 'Parkplatz') + ': ' + (it.f === 'y' || it.f === 'z' ? 'kostenpflichtig' : it.f === 'n' ? 'kostenlos' : 'Gebühr nicht angegeben');
        PK.marks.push({ it, mk });
        if (it.r && it.r.length >= 8) { // Fläche als dezente Kontur
          const pts = []; for (let i = 0; i < it.r.length; i += 2) pts.push(new THREE.Vector2(it.r[i], it.r[i + 1]));
          let tri; try { tri = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { tri = null; }
          const col = new THREE.Color(c), pos = new Float32Array(pts.length * 3), lin = new Float32Array(pts.length * 3);
          pts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = 0.5; pos[i * 3 + 2] = p.y; lin[i * 3] = p.x; lin[i * 3 + 1] = 0.65; lin[i * 3 + 2] = p.y; });
          const grp = new THREE.Group();
          if (tri && tri.length) {
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(tri.flat());
            const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7 }));
            m.renderOrder = 7; grp.add(m);
          }
          const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lin, 3));
          const l = new THREE.LineLoop(lg, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.85 })); l.renderOrder = 8; grp.add(l);
          PK.group.add(grp); PK.rings.push({ it, grp });
        }
      });
      // Parkregeln am Straßenrand: ein Band je Abschnitt, Breite wächst mit der Entfernung (wie bei den Touren)
      const pos = [], off = [], col = [], meta = [], idx = [], KI = { B: 0, F: 1, S: 2, V: 3 };
      (D.segs || []).forEach((s) => {
        const f = s.p, n = f.length / 2; if (n < 2) return;
        const c = new THREE.Color(COL[s.k] || COL.U), y = 0.7 + KI[s.k] * 0.04;
        for (let i = 0; i < n; i++) {
          const x = f[i * 2], z = f[i * 2 + 1], a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
          let dx = f[b * 2] - f[a * 2], dz = f[b * 2 + 1] - f[a * 2 + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          const k = pos.length / 3;
          pos.push(x, y, z, x, y, z); off.push(-dz, 0, dx, dz, 0, -dx); col.push(c.r, c.g, c.b, c.r, c.g, c.b); meta.push(KI[s.k] || 0, s.g, -1, KI[s.k] || 0, s.g, 1);
          if (i > 0) idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
        }
      });
      if (pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('off', new THREE.Float32BufferAttribute(off, 3));
        g.setAttribute('col', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('meta', new THREE.Float32BufferAttribute(meta, 3)); g.setIndex(idx);
        PK.mat = new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
          uniforms: { uW: { value: 1.6 }, uShow: { value: new THREE.Vector4(1, 1, 1, 1) } },
          // meta = (Klasse 0 B, 1 F, 2 S, 3 V; Gruppe; Seite -1/+1)
          vertexShader: 'attribute vec3 off; attribute vec3 col; attribute vec3 meta; uniform float uW; uniform vec4 uShow; varying vec3 vC; varying float vA, vS;'
            + 'void main(){ float vis = meta.x < 0.5 ? uShow.x : meta.x < 1.5 ? uShow.y : meta.x < 2.5 ? uShow.z : uShow.w; vC = col; vA = vis < 0.5 ? 0.0 : 0.82; vS = meta.z;'
            + ' gl_Position = vis < 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * modelViewMatrix * vec4(position + off * uW, 1.0); }',
          fragmentShader: 'varying vec3 vC; varying float vA, vS; void main(){ vec3 c = mix(vC, vec3(0.06, 0.05, 0.04), smoothstep(0.7, 1.0, abs(vS)) * 0.35); gl_FragColor = vec4(c, vA); }',
        });
        PK.bands = new THREE.Mesh(g, PK.mat); PK.bands.frustumCulled = false; PK.bands.renderOrder = 6; A.scene.add(PK.bands);
      }
      (D.gruppen || []).forEach((g) => {
        const sym = { B: '€', F: 'P', S: '🕑', V: '✕' }[g.k] || 'P';
        const mk = A.addMarker('nf', sym, g.x, 8, g.z, () => { selMk(mk); A.openCard(bandCard(g)); fly(g.x, g.z); }, null);
        mk.grp = 'parken'; mk.el.classList.add('pk', 'pks'); mk.el.style.setProperty('--c', COL[g.k] || COL.U); mk.el.title = (g.nm || 'Straße') + ': ' + KLASSE[g.k] + ' (Parken am Straßenrand)';
        if (/[^\x00-\x7f]/.test(sym)) mk.el.classList.add('big');
        PK.bandMarks.push({ g, mk });
      });
      PK.ok = true; box(); applyFilter();
      setState(D.gesamt + ' Parkplätze' + ((D.gruppen || []).length ? ', ' + D.gruppen.length + ' Straßenabschnitte' : ''));
      fillSources();
    }

    // ---- Filter (alle / kostenpflichtig / frei / Gebühr unbekannt)
    function applyFilter() {
      PK.marks.forEach((m) => { m.mk.grp = showLot(m.it) ? 'parken' : 'parken_aus'; });
      PK.bandMarks.forEach((m) => { m.mk.grp = showBand(m.g.k) ? 'parken' : 'parken_aus'; });
      PK.rings.forEach((r) => { r.grp.visible = showLot(r.it); });
      if (PK.mat) PK.mat.uniforms.uShow.value.set(showBand('B') ? 1 : 0, showBand('F') ? 1 : 0, PK.filter === 'all' ? 1 : 0, PK.filter === 'all' ? 1 : 0);
      document.querySelectorAll('#pkFilter [data-pk]').forEach((b) => { const on = b.dataset.pk === PK.filter; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      A.dirty(); S.moved = true;
    }
    function box() {
      const el = $('#pkBox'); if (!el) return;
      if (el.dataset.ready !== '1') {
        el.dataset.ready = '1';
        const lg = (c, t, s) => '<span class="pk-lg"><i class="pk-sw" style="--c:' + c + '">' + (s || 'P') + '</i>' + t + '</span>';
        el.innerHTML = '<div class="chips" id="pkFilter" role="group" aria-label="Parkplätze nach Gebühr filtern">'
          + [['all', 'Alle'], ['paid', 'Kostenpflichtig'], ['free', 'Kostenlos'], ['unk', 'Gebühr unbekannt']].map(([k, t]) => '<button type="button" class="chip' + (k === 'all' ? ' on' : '') + '" data-pk="' + k + '" aria-pressed="' + (k === 'all') + '">' + t + '</button>').join('') + '</div>'
          + '<div class="pk-legend">' + lg(COL.B, 'Bezahlparkplatz', 'P€') + lg(COL.F, 'kostenlos') + lg(COL.U, 'Gebühr nicht angegeben')
          + '<span class="pk-lgh">Am Straßenrand (nur wo eingetragen)</span>' + '<span class="pk-lg"><i class="pk-band" style="--c:' + COL.B + '"></i>kostenpflichtig</span><span class="pk-lg"><i class="pk-band" style="--c:' + COL.F + '"></i>gebührenfrei</span>'
          + '<span class="pk-lg"><i class="pk-band" style="--c:' + COL.S + '"></i>Parkscheibe, zeitlich begrenzt</span><span class="pk-lg"><i class="pk-band" style="--c:' + COL.V + '"></i>Parkverbot</span></div>'
          + '<p class="lnote" id="pkInfo"></p>'
          + '<p class="lnote">Angaben von OpenStreetMap-Mitwirkenden, ohne Gewähr; maßgeblich ist die Beschilderung vor Ort. Nutzung auf eigene Gefahr. <a href="impressum.html#haftung" target="_blank" rel="noopener">Haftungsausschluss</a></p>';
        el.addEventListener('click', (e) => { const b = e.target.closest('[data-pk]'); if (!b) return; PK.filter = b.dataset.pk; applyFilter(); });
      }
      const D = PK.data, inf = $('#pkInfo');
      if (inf && D) inf.textContent = D.gesamt + ' Parkplätze im Gebiet, davon ' + D.mitGebuehr + ' mit Gebührenangabe in OpenStreetMap' + ((D.gruppen || []).length ? '; ' + D.gruppen.length + ' Straßenabschnitte mit eingetragener Parkregel' : '') + '. Stand ' + fmtDe(D.stand) + '.';
    }

    // ---- Quellen-Dialog: Zahlen der Ebene (laden beim Öffnen, die Daten sind klein)
    function fillSources() {
      const el = document.getElementById('pkQ'), D = PK.data; if (!el || !D) return;
      const p = D.gesamt ? Math.round(100 * D.mitGebuehr / D.gesamt) : 0;
      el.textContent = 'Stand ' + fmtDe(D.stand) + ': ' + D.gesamt + ' Parkplätze im Gebiet, davon ' + D.mitGebuehr + ' (' + p + ' %) mit Gebührenangabe; ' + (D.gruppen || []).length + ' Straßenabschnitte mit eingetragener Parkregel.';
    }
    const srcBtn = document.querySelector('.pill[data-panel=sources]');
    if (srcBtn) srcBtn.addEventListener('click', () => {
      if (PK.data) return fillSources();
      loadData().then((D) => { PK.data = PK.data || D; fillSources(); }, () => { const el = document.getElementById('pkQ'); if (el) el.textContent = 'Zahlen derzeit nicht verfügbar.'; });
    });

    // ---- Klick auf das Band: Parkregel an der Stelle (Karteninfo der Stelle)
    A.EXT.pick.push((x, z) => {
      if (!S.L.parken || !PK.ok || !PK.data.segs) return '';
      const tol = Math.max(A.view.dist * 0.011, 6); let best = null, bd = 1e18;
      PK.data.segs.forEach((s) => {
        if (!showBand(s.k)) return;
        const f = s.p;
        for (let k = 0; k + 3 < f.length; k += 2) {
          const ax = f[k], az = f[k + 1], dx = f[k + 2] - ax, dz = f[k + 3] - az, l2 = dx * dx + dz * dz;
          let t = l2 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(ax + t * dx - x, az + t * dz - z); if (d < bd) { bd = d; best = s; }
        }
      });
      if (!best || bd > tol) return '';
      const g = PK.data.gruppen[best.g];
      return '<hr><h4 class="ge-h">Parken am Straßenrand: ' + esc(g.nm || 'Straße') + '</h4><p><b class="pk-tag k' + g.k + '">' + esc(KLASSE[g.k]) + '</b>'
        + (g.ms ? ' <span class="s">höchstens ' + esc(g.ms) + '</span>' : '') + (g.ti ? ' <span class="s">' + esc(g.ti) + '</span>' : '') + '</p>' + HAFT_HTML;
    });

    A.EXT.frame.push(() => { // Bandbreite folgt der Entfernung der Kamera
      if (!PK.mat || !PK.bands || !PK.bands.visible) return;
      const w = Math.min(Math.max(A.view.dist * 0.0011, 1.1), 22), u = PK.mat.uniforms.uW;
      if (Math.abs(u.value - w) > 0.03) { u.value = w; A.dirty(); }
    });
    A.EXT.layer.push(() => {
      const on = !!S.L.parken, el = $('#pkBox'); if (el) el.hidden = !on;
      if (PK.group) PK.group.visible = on;
      if (PK.bands) PK.bands.visible = on;
      if (on && !PK.ok && !PK.busy) {
        PK.busy = true; setState('lädt …');
        loadData().then((D) => { PK.busy = false; build(D); A.applyLayers(); }, () => { PK.busy = false; setState('nicht verfügbar'); });
      }
    });
    window.AL_PARKEN_API = { state: PK };
    A.applyLayers();
  }
  window.AL_PARKEN_INIT = init;
  if (window.AL_APP) init(window.AL_APP);
})();

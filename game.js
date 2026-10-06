/* ============================================================
   NEON RUNNER 3D
   Corredor infinito com renderizacao 3D em WebGL puro.
   Sem bibliotecas, sem CDN, sem assets externos.
   ============================================================ */
(function () {
  'use strict';

  var canvas = document.getElementById('game');
  var gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'high-performance' })
        || canvas.getContext('experimental-webgl', { antialias: true, alpha: false });

  if (!gl) {
    var fb = document.getElementById('fallback');
    if (fb) fb.style.display = 'flex';
    return;
  }

  /* =========================================================
     1. MATEMATICA (mat4 / coluna-maior, igual ao OpenGL)
     ========================================================= */
  var m4 = function () { return new Float32Array(16); };

  function m4identity(o) {
    o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
    return o;
  }

  function m4perspective(o, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = (far + near) * nf; o[11] = -1;
    o[12] = 0; o[13] = 0; o[14] = 2 * far * near * nf; o[15] = 0;
    return o;
  }

  function m4lookAt(o, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
    var zx = ex - cx, zy = ey - cy, zz = ez - cz;
    var l = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
    zx /= l; zy /= l; zz /= l;
    var xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    l = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= l; xy /= l; xz /= l;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
    o[12] = -(xx * ex + xy * ey + xz * ez);
    o[13] = -(yx * ex + yy * ey + yz * ez);
    o[14] = -(zx * ex + zy * ey + zz * ez);
    o[15] = 1;
    return o;
  }

  /* Compose = Translate * Rz*Ry*Rx * Scale  (matriz de modelo) */
  function m4compose(o, tx, ty, tz, rx, ry, rz, sx, sy, sz) {
    if (sx === undefined) { sx = 1; sy = 1; sz = 1; }
    var cx = Math.cos(rx), sX = Math.sin(rx),
        cy = Math.cos(ry), sY = Math.sin(ry),
        cz = Math.cos(rz), sZ = Math.sin(rz);
    // R = Rz*Ry*Rx  (linha-maior)
    var m00 = cz * cy,              m01 = cz * sY * sX - sZ * cx, m02 = cz * sY * cx + sZ * sX;
    var m10 = sZ * cy,              m11 = sZ * sY * sX + cz * cx, m12 = sZ * sY * cx - cz * sX;
    var m20 = -sY,                  m21 = cy * sX,                m22 = cy * cx;
    o[0] = m00 * sx; o[1] = m10 * sx; o[2] = m20 * sx; o[3] = 0;
    o[4] = m01 * sy; o[5] = m11 * sy; o[6] = m21 * sy; o[7] = 0;
    o[8] = m02 * sz; o[9] = m12 * sz; o[10] = m22 * sz; o[11] = 0;
    o[12] = tx; o[13] = ty; o[14] = tz; o[15] = 1;
    return o;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  /* =========================================================
     2. SHADERS
     ========================================================= */
  var VS_MAIN = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'uniform mat4 uProj, uView, uModel;',
    'uniform mat3 uNormal;',
    'varying vec3 vN;',
    'varying float vD;',
    'void main(){',
    '  vec4 world = uModel * vec4(aPos, 1.0);',
    '  vec4 view  = uView * world;',
    '  vN = uNormal * aNormal;',
    '  vD = -view.z;',
    '  gl_Position = uProj * view;',
    '}'
  ].join('\n');

  var FS_MAIN = [
    'precision mediump float;',
    'varying vec3 vN;',
    'varying float vD;',
    'uniform vec3 uColor;',
    'uniform vec3 uEmissive;',
    'uniform float uAlpha;',
    'uniform vec3 uFog;',
    'uniform float uFogD;',
    'uniform vec3 uLight;',
    'void main(){',
    '  vec3 n = normalize(vN);',
    '  float dif = max(dot(n, -uLight), 0.0);',
    '  float sky = 0.5 + 0.5 * n.y;',
    '  vec3 col = uColor * (0.22 + 0.55 * dif + 0.28 * sky) + uEmissive;',
    '  float f = 1.0 - exp(-pow(uFogD * vD, 2.0));',
    '  col = mix(col, uFog, clamp(f, 0.0, 1.0));',
    '  gl_FragColor = vec4(col, uAlpha);',
    '}'
  ].join('\n');

  var VS_GRID = [
    'attribute vec3 aPos;',
    'uniform mat4 uProj, uView;',
    'uniform vec2 uScroll;',
    'uniform float uCell;',
    'varying vec2 vP;',
    'varying float vD;',
    'varying vec2 vW;',
    'void main(){',
    '  vec4 view = uView * vec4(aPos, 1.0);',
    '  vP = (aPos.xz + uScroll) / uCell;',
    '  vW = aPos.xz;',
    '  vD = -view.z;',
    '  gl_Position = uProj * view;',
    '}'
  ].join('\n');

  var FS_GRID = [
    'precision mediump float;',
    'varying vec2 vP;',
    'varying float vD;',
    'varying vec2 vW;',
    'uniform vec3 uFog;',
    'uniform float uFogD;',
    'uniform vec3 uGridColor;',
    'uniform vec3 uLineColor;',
    'uniform float uPulse;',
    'void main(){',
    '  vec2 d = abs(fract(vP + 0.5) - 0.5);',
    '  float w = mix(0.010, 0.16, clamp(vD / 130.0, 0.0, 1.0));',
    '  float g = min(d.x, d.y);',
    '  float line = 1.0 - smoothstep(0.0, w, g);',
    '  float dist = length(vW - vec2(0.0, -60.0));',
    '  float fall = 1.0 - clamp(dist / 260.0, 0.0, 1.0);',
    '  float a = line * (0.30 + 0.35 * uPulse) * fall;',
    '  float laneD = min(abs(vW.x), abs(abs(vW.x) - 2.45));',
    '  float laneW = mix(0.035, 0.35, clamp(vD / 120.0, 0.0, 1.0));',
    '  float lane = 1.0 - smoothstep(0.0, laneW, laneD);',
    '  float f = 1.0 - exp(-pow(uFogD * vD, 2.0));',
    '  vec3 col = mix(uGridColor, uLineColor, clamp(line * 0.7, 0.0, 1.0));',
    '  col += vec3(0.0, 0.42, 0.55) * lane * 0.6;',
    '  a += lane * 0.26 * fall;',
    '  a *= (1.0 - clamp(f, 0.0, 1.0));',
    '  if (a < 0.004) discard;',
    '  gl_FragColor = vec4(col, a);',
    '}'
  ].join('\n');

  var VS_POINT = [
    'attribute vec3 aPos;',
    'attribute vec3 aColor;',
    'attribute float aSize;',
    'uniform mat4 uProj, uView;',
    'uniform float uScale;',
    'varying vec3 vC;',
    'varying float vD;',
    'void main(){',
    '  vec4 view = uView * vec4(aPos, 1.0);',
    '  vC = aColor;',
    '  vD = -view.z;',
    '  gl_Position = uProj * view;',
    '  gl_PointSize = clamp(uScale * aSize / max(0.35, vD), 1.0, 64.0);',
    '}'
  ].join('\n');

  var FS_POINT = [
    'precision mediump float;',
    'varying vec3 vC;',
    'varying float vD;',
    'uniform float uFogD;',
    'uniform float uPower;',
    'void main(){',
    '  vec2 c = gl_PointCoord - 0.5;',
    '  float r = length(c);',
    '  if (r > 0.5) discard;',
    '  float a = pow(smoothstep(0.5, 0.0, r), uPower);',
    '  float f = 1.0 - exp(-pow(uFogD * vD, 2.0));',
    '  a *= (1.0 - clamp(f, 0.0, 1.0));',
    '  gl_FragColor = vec4(vC * a, 1.0);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function makeProgram(vsSrc, fsSrc, attrs, unis) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Link: ' + gl.getProgramInfoLog(p));
    }
    var o = { p: p, a: {}, u: {} };
    attrs.forEach(function (n) { o.a[n] = gl.getAttribLocation(p, n); });
    unis.forEach(function (n) { o.u[n] = gl.getUniformLocation(p, n); });
    return o;
  }

  var PROG_MAIN = makeProgram(VS_MAIN, FS_MAIN,
    ['aPos', 'aNormal'],
    ['uProj', 'uView', 'uModel', 'uNormal', 'uColor', 'uEmissive', 'uAlpha', 'uFog', 'uFogD', 'uLight']);

  var PROG_GRID = makeProgram(VS_GRID, FS_GRID,
    ['aPos'],
    ['uProj', 'uView', 'uScroll', 'uCell', 'uFog', 'uFogD', 'uGridColor', 'uLineColor', 'uPulse']);

  var PROG_POINT = makeProgram(VS_POINT, FS_POINT,
    ['aPos', 'aColor', 'aSize'],
    ['uProj', 'uView', 'uScale', 'uFogD', 'uPower']);

  /* =========================================================
     3. GEOMETRIA (interleaved: px py pz nx ny nz)
     ========================================================= */
  function pushTri(out, a, b, c, n) {
    out.push(a[0], a[1], a[2], n[0], n[1], n[2]);
    out.push(b[0], b[1], b[2], n[0], n[1], n[2]);
    out.push(c[0], c[1], c[2], n[0], n[1], n[2]);
  }

  function geomBox(w, h, d) {
    var x = w / 2, y = h / 2, z = d / 2, out = [], i, tri;
    var faces = [
      { n: [0, 0, 1],  v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
      { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
      { n: [1, 0, 0],  v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
      { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
      { n: [0, 1, 0],  v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
      { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] }
    ];
    for (i = 0; i < faces.length; i++) {
      var f = faces[i], v = f.v;
      pushTri(out, v[0], v[1], v[2], f.n);
      pushTri(out, v[0], v[2], v[3], f.n);
    }
    return new Float32Array(out);
  }

  function geomOcta(r, squash) {
    var sy = squash || 1, out = [];
    var top = [0, r * sy, 0], bot = [0, -r * sy, 0];
    var px = [r, 0, 0], nx = [-r, 0, 0], pz = [0, 0, r], nz = [0, 0, -r];
    var quads = [[px, pz], [pz, nx], [nx, nz], [nz, px]];
    var i, a, b, t, n;
    for (i = 0; i < 4; i++) {
      a = quads[i][0]; b = quads[i][1];
      t = [a[0] + b[0] + top[0], a[1] + b[1] + top[1], a[2] + b[2] + top[2]];
      n = normalize3(t);
      pushTri(out, top, b, a, n);
      t = [a[0] + b[0] + bot[0], a[1] + b[1] + bot[1], a[2] + b[2] + bot[2]];
      n = normalize3(t);
      pushTri(out, bot, a, b, n);
    }
    return new Float32Array(out);
  }

  function normalize3(v) {
    var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function geomQuad(w, d) {
    var x = w / 2, z = d / 2;
    return new Float32Array([
      -x, 0, z, 0, 1, 0,
       x, 0, z, 0, 1, 0,
       x, 0, -z, 0, 1, 0,
      -x, 0, z, 0, 1, 0,
       x, 0, -z, 0, 1, 0,
      -x, 0, -z, 0, 1, 0
    ]);
  }

  var MESH_BOX = null, MESH_OCTA = null, MESH_OCTA_S = null, MESH_QUAD = null;

  function uploadGeom(data) {
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return { buf: buf, count: data.length / 6 };
  }

  function drawMesh(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
    gl.enableVertexAttribArray(PROG_MAIN.a.aPos);
    gl.vertexAttribPointer(PROG_MAIN.a.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(PROG_MAIN.a.aNormal);
    gl.vertexAttribPointer(PROG_MAIN.a.aNormal, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }

  MESH_BOX = uploadGeom(geomBox(1, 1, 1));
  MESH_OCTA = uploadGeom(geomOcta(1, 1));
  MESH_OCTA_S = uploadGeom(geomOcta(1, 0.55));
  MESH_QUAD = uploadGeom(geomQuad(1.5, 1.5));

  var MODEL = m4();
  var NORMAL = new Float32Array(9);

  function setNormalFromModel() {
    NORMAL[0] = MODEL[0]; NORMAL[1] = MODEL[1]; NORMAL[2] = MODEL[2];
    NORMAL[3] = MODEL[4]; NORMAL[4] = MODEL[5]; NORMAL[5] = MODEL[6];
    NORMAL[6] = MODEL[8]; NORMAL[7] = MODEL[9]; NORMAL[8] = MODEL[10];
  }

  var COL = new Float32Array(3), EMI = new Float32Array(3);

  function drawBox(x, y, z, sx, sy, sz, r, g, b, er, eg, eb, ry, rz) {
    m4compose(MODEL, x, y, z, 0, ry || 0, rz || 0, sx, sy, sz);
    setNormalFromModel();
    gl.uniformMatrix4fv(PROG_MAIN.u.uModel, false, MODEL);
    gl.uniformMatrix3fv(PROG_MAIN.u.uNormal, false, NORMAL);
    COL[0] = r; COL[1] = g; COL[2] = b;
    EMI[0] = er; EMI[1] = eg; EMI[2] = eb;
    gl.uniform3fv(PROG_MAIN.u.uColor, COL);
    gl.uniform3fv(PROG_MAIN.u.uEmissive, EMI);
    drawMesh(MESH_BOX);
  }

  /* =========================================================
     4. CENARIO / ESTADO
     ========================================================= */
  var LANES = [-2.45, 0, 2.45];
  var CELL = 4;
  var STAND_Y = 0.55, STAND_HY = 0.55, SLIDE_Y = 0.30, SLIDE_HY = 0.28;
  var HIT_HY = 0.48;   // hitbox vertical mais tolerante que o desenho
  var SPAWN_Z = -230;
  var FOG = [0.016, 0.012, 0.045];
  var FOG_D = 0.0062;

  var P = {                      // player
    x: 0, y: 0.5, vy: 0,
    lane: 1, target: 0,
    grounded: true, sliding: 0,
    tilt: 0, invuln: 0, airTime: 0,
    halfY: 0.5, spin: 0
  };

  var G = {                      // game
    state: 'menu',
    time: 0, distance: 0, score: 0, scroll: 0, scrollDelta: 0, slowT: 0,
    speed: 0, baseSpeed: 0, targetSpeed: 18,
    orbs: 0, shields: 3, maxShields: 3,
    energy: 0, boost: 0, boostCd: 0,
    shake: 0, flash: 0, flashColor: [1, 0.2, 0.4],
    dying: 0, best: 0, hitStop: 0,
    combo: 0, comboTimer: 0, mult: 1
  };

  try { G.best = parseInt(localStorage.getItem('neonrunner3d.best') || '0', 10) || 0; } catch (e) { G.best = 0; }

  /* ---------- pool de obstaculos ---------- */
  var OBST = [], ORBS = [], BLD = [], RAIL = [];
  var OBS_COLORS = {
    LOW:   { c: [1.0, 0.42, 0.05], e: [0.55, 0.16, 0.0] },
    HIGH:  { c: [1.0, 0.18, 0.58], e: [0.62, 0.05, 0.30] },
    BLOCK: { c: [0.45, 0.20, 1.0], e: [0.26, 0.06, 0.75] }
  };

  function initPools() {
    var i;
    for (i = 0; i < 70; i++) {
      OBST.push({ on: false, type: 'LOW', x: 0, y0: 0, y1: 1, z: 0, w: 2.2, d: 0.8 });
    }
    for (i = 0; i < 70; i++) {
      ORBS.push({ on: false, x: 0, y: 1.2, z: 0, spin: rand(0, 6.28), pulse: rand(0, 6.28), taken: 0 });
    }
    for (i = 0; i < 44; i++) {
      BLD.push({
        on: true, x: 0, z: 0, w: 3, h: 12, d: 3, hue: 0.6,
        side: 1, y: 0
      });
    }
    for (i = 0; i < 30; i++) {
      RAIL.push({ x: 0, y: 0.06, z: 0, len: 14, side: 1 });
    }
  }

  function resetWorld() {
    var i;
    for (i = 0; i < OBST.length; i++) OBST[i].on = false;
    for (i = 0; i < ORBS.length; i++) ORBS[i].on = false;
    for (i = 0; i < RAIL.length; i++) {
      var r = RAIL[i];
      r.side = (i % 2 === 0) ? -1 : 1;
      r.x = r.side * 3.9;
      r.z = -Math.floor(i / 2) * r.len + 10;
    }
    for (i = 0; i < BLD.length; i++) {
      var b = BLD[i];
      b.side = (i % 2 === 0) ? -1 : 1;
      respawnBuilding(b, -Math.floor(i / 2) * 16 + 20, true);
    }
    lastRowZ = 0;
    lastRowType = '';
    particles.length = 0;
    trail.length = 0;
  }

  function respawnBuilding(b, z, first) {
    b.side = b.side || (Math.random() < 0.5 ? -1 : 1);
    b.w = rand(2.5, 7);
    b.d = rand(2.5, 8);
    b.h = rand(5, 46);
    b.x = b.side * (6.4 + Math.random() * 22 + b.w * 0.5);
    b.z = (z !== undefined) ? z : rand(-260, -240);
    b.hue = Math.random();
    b.y = b.h / 2;
    if (first) b.z = rand(-260, 30);
    return b;
  }

  /* ---------- particulas ---------- */
  var MAXP = 620;
  var pPos = new Float32Array(MAXP * 3);
  var pCol = new Float32Array(MAXP * 3);
  var pSize = new Float32Array(MAXP);
  var particles = [];
  var pData = new Float32Array(MAXP * 7);

  function spawnParticle(x, y, z, vx, vy, vz, life, size, r, g, b) {
    if (particles.length >= MAXP) return;
    particles.push({ x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, l: life, lm: life, s: size, r: r, g: g, b: b });
  }

  function burst(x, y, z, n, spread, life, size, r, g, b, up) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = rand(0.2, 1) * spread;
      spawnParticle(x, y, z,
        Math.cos(a) * s, rand(0.1, 1) * spread * (up || 1), Math.sin(a) * s,
        life * rand(0.6, 1.3), size * rand(0.6, 1.3), r, g, b);
    }
  }

  /* ---------- rastro ---------- */
  var trail = [];
  var TRAIL_MAX = 46;

  /* =========================================================
     5. GERACAO DE PISTA
     ========================================================= */
  var lastRowZ = 0, lastRowType = '';

  function freeObstacle() {
    for (var i = 0; i < OBST.length; i++) if (!OBST[i].on) return OBST[i];
    return null;
  }
  function freeOrb() {
    for (var i = 0; i < ORBS.length; i++) if (!ORBS[i].on) return ORBS[i];
    return null;
  }

  function addObstacle(type, lane, z) {
    // nunca empilha dois obstaculos na mesma pista perto demais:
    // garante tempo de pousar o pulo ou terminar o escorregar
    var sep = Math.max(10, (G.speed + 8) * 0.58);
    var x = LANES[lane];
    for (var k = 0; k < OBST.length; k++) {
      var e = OBST[k];
      if (!e.on) continue;
      if (Math.abs(e.x - x) > 1.0) continue;
      if (Math.abs(e.z - z) < sep) return null;
    }
    var o = freeObstacle();
    if (!o) return null;
    o.on = true; o.type = type; o.x = x; o.z = z; o.w = 2.15; o.d = 0.85;
    if (type === 'LOW') { o.y0 = 0; o.y1 = 0.82; }
    else if (type === 'HIGH') { o.y0 = 0.85; o.y1 = 3.4; }
    else { o.y0 = 0; o.y1 = 3.0; o.d = 1.1; }
    return o;
  }

  function addOrb(lane, z, y) {
    var o = freeOrb();
    if (!o) return null;
    o.on = true; o.x = LANES[lane]; o.z = z; o.y = y; o.taken = 0;
    o.spin = rand(0, 6.28);
    return o;
  }

  function difficulty() { return clamp(G.distance / 1400, 0, 1); }

  function laneOrder() {
    var a = [0, 1, 2];
    shuffle(a);
    return a;
  }

  // corredor em ziguezague: bloqueia pistas em sequencia (so exige movimento lateral)
  function makeStaggered(z, d) {
    var order = laneOrder();
    var per = Math.max(7, (G.speed + 8) * 0.30);
    var n = (d > 0.3 && Math.random() < 0.55) ? 3 : 2;
    for (var i = 0; i < n; i++) {
      addObstacle(Math.random() < 0.58 ? 'LOW' : 'BLOCK', order[i], z - i * per);
      addOrb(order[(i + 2) % 3], z - i * per - per * 0.5, 1.15);
    }
    return (n - 1) * per;
  }

  function fillOrbs(lane, z, n, baseY, step) {
    for (var i = 0; i < n; i++) addOrb(lane, z - i * step, baseY + Math.sin(i * 0.9) * 0.4);
    return (n - 1) * step;
  }

  function makeRow(z) {
    var d = difficulty();
    var r = Math.random();
    var i, order;
    var avoidFull = (lastRowType === 'FULL_LOW' || lastRowType === 'FULL_HIGH');

    // logo apos uma barreira de largura total: so movimento lateral
    if (avoidFull) {
      if (Math.random() < 0.65) { lastRowType = 'ZIG'; return makeStaggered(z, d); }
      lastRowType = 'ORBS';
      return fillOrbs(laneOrder()[0], z, 3 + ((Math.random() * 3) | 0), 1.05, 2.1);
    }

    // 1) barreira baixa em todas as pistas -> PULAR
    if (r < 0.12 + 0.04 * d) {
      for (i = 0; i < 3; i++) addObstacle('LOW', i, z);
      lastRowType = 'FULL_LOW';
      for (i = -1; i <= 1; i++) addOrb(1, z + i * 2.4, 1.62 - Math.abs(i) * 0.33);
      return 0;
    }

    // 2) barreira alta em todas as pistas -> ESCORREGAR
    if (r < 0.23 + 0.05 * d) {
      for (i = 0; i < 3; i++) addObstacle('HIGH', i, z);
      lastRowType = 'FULL_HIGH';
      for (i = -1; i <= 1; i++) addOrb(1, z + i * 2.4, 0.45);
      return 0;
    }

    // 3) duas pistas bloqueadas -> DESVIAR
    if (r < 0.55 + 0.10 * d) {
      order = laneOrder();
      var t1 = Math.random() < 0.42 ? 'BLOCK' : (Math.random() < 0.5 ? 'LOW' : 'HIGH');
      var t2 = Math.random() < 0.55 ? t1 : (Math.random() < 0.5 ? 'LOW' : 'HIGH');
      addObstacle(t1, order[0], z);
      addObstacle(t2, order[1], z - (Math.random() < 0.45 ? rand(1, 3) : 0));
      lastRowType = 'TWO';
      fillOrbs(order[2], z - 1, 2, 1.05, 2.6);
      return 3.6;
    }

    // 4) um obstaculo (as vezes com um segundo em outra pista)
    if (r < 0.74) {
      order = laneOrder();
      var t = Math.random() < 0.30 ? 'BLOCK' : (Math.random() < 0.55 ? 'LOW' : 'HIGH');
      addObstacle(t, order[0], z);
      if (Math.random() < 0.45) {
        addObstacle(t === 'HIGH' ? 'LOW' : 'HIGH', order[1], z - rand(0.5, 4));
      }
      lastRowType = 'ONE';
      return fillOrbs(order[2], z, 3, 1.05, 2.3);
    }

    // 5) ziguezague escalonado
    if (r < 0.90) {
      lastRowType = 'ZIG';
      return makeStaggered(z, d);
    }

    // 6) corredor de nucleos
    lastRowType = 'ORBS';
    return fillOrbs(laneOrder()[0], z, 3 + ((Math.random() * 4) | 0), 1.0, 2.1);
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
  }

  function updateSpawner() {
    // a fronteira de geracao caminha junto com o mundo (antes ela ficava parada
    // e os obstaculos simplesmente acabavam depois dos primeiros 230 metros)
    lastRowZ += (G.scrollDelta || 0);
    var guard = 0;
    while (lastRowZ > SPAWN_Z && guard++ < 60) {
      var d = difficulty();
      var gap = Math.max(14, (G.speed + 7) * (0.58 - 0.06 * d)) * rand(0.94, 1.10);
      lastRowZ -= gap;
      lastRowZ -= makeRow(lastRowZ);
    }
  }

  /* =========================================================
     6. ENTRADA
     ========================================================= */
  var input = { jumpBuffer: 0, coyote: 0 };
  var keys = {};

  window.addEventListener('keydown', function (e) {
    var k = e.key.toLowerCase();
    if (k === ' ' || k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright') e.preventDefault();
    if (keys[k]) return;
    keys[k] = true;

    if (G.state === 'menu' || G.state === 'over') {
      if (k === ' ' || k === 'enter') startGame();
      return;
    }
    if (k === 'p' || k === 'escape') { togglePause(); return; }
    if (G.state !== 'playing') return;

    if (k === 'arrowleft' || k === 'a') moveLane(-1);
    else if (k === 'arrowright' || k === 'd') moveLane(1);
    else if (k === 'arrowup' || k === 'w' || k === ' ') doJump();
    else if (k === 'arrowdown' || k === 's') doSlide();
    else if (k === 'shift' || k === 'e') doBoost();
    else if (k === 'm') toggleMute();
  }, false);

  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; }, false);

  function moveLane(dir) {
    var n = clamp(P.lane + dir, 0, 2);
    if (n !== P.lane) {
      P.lane = n;
      P.target = LANES[n];
      audioSlide();
    } else {
      P.tilt += dir * 0.12;
    }
  }

  function doJump() {
    if (G.state !== 'playing') return;
    if (P.grounded || input.coyote > 0) {
      P.vy = 19.5;
      P.grounded = false;
      input.coyote = 0;
      P.sliding = 0;
      audioJump();
      burst(P.x, 0.15, 0.1, 8, 3.2, 0.35, 0.5, 0.2, 1.0, 1.0, 0.4);
    } else {
      input.jumpBuffer = 0.14;
    }
  }

  function doSlide() {
    if (G.state !== 'playing') return;
    if (P.grounded) {
      P.sliding = 0.62;
      audioSlide();
      burst(P.x, 0.2, 0.2, 6, 2.6, 0.3, 0.4, 0.4, 0.9, 1.0, 0.3);
    } else {
      P.vy -= 30;  // queda rapida
    }
  }

  function doBoost() {
    if (G.state !== 'playing') return;
    if (G.energy >= 100 && G.boost <= 0) {
      G.boost = 3.6;
      G.energy = 0;
      G.shake = Math.max(G.shake, 0.5);
      audioBoost();
      burst(P.x, P.y, 0.4, 40, 9, 0.7, 1.1, 0.3, 0.95, 1.0, 1);
    }
  }

  /* ---------- touch ---------- */
  var touch = { x: 0, y: 0, t: 0, active: false };
  canvas.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0];
    touch.x = t.clientX; touch.y = t.clientY; touch.t = performance.now(); touch.active = true;
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchend', function (e) {
    if (!touch.active) return;
    touch.active = false;
    var t = e.changedTouches[0];
    var dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    var adx = Math.abs(dx), ady = Math.abs(dy);

    if (G.state === 'menu' || G.state === 'over') { startGame(); return; }
    if (G.state !== 'playing') return;

    if (adx < 26 && ady < 26) { doJump(); return; }
    if (adx > ady) moveLane(dx > 0 ? 1 : -1);
    else if (dy < 0) doJump();
    else doSlide();
    e.preventDefault();
  }, { passive: false });

  /* =========================================================
     7. AUDIO (procedural, WebAudio)
     ========================================================= */
  var AC = null, master = null, muted = false;
  var musicOn = false, nextNote = 0, step = 0;

  function initAudio() {
    if (AC) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    AC = new Ctx();
    master = AC.createGain();
    master.gain.value = muted ? 0 : 0.55;
    master.connect(AC.destination);
  }

  function tone(freq, dur, type, vol, slideTo, delay) {
    if (!AC || muted) return;
    var t0 = AC.currentTime + (delay || 0);
    var o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol, freqFrom, freqTo) {
    if (!AC || muted) return;
    var t0 = AC.currentTime;
    var len = Math.max(1, Math.floor(AC.sampleRate * dur));
    var buf = AC.createBuffer(1, len, AC.sampleRate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = AC.createBufferSource(); src.buffer = buf;
    var f = AC.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.setValueAtTime(freqFrom, t0);
    f.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);
    f.Q.value = 1.2;
    var g = AC.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0);
  }

  function audioJump() { tone(300, 0.14, 'sine', 0.10, 720); }
  function audioSlide() { noise(0.18, 0.10, 1800, 300); }
  function audioCollect(n) {
    var base = 880 * Math.pow(1.0595, Math.min(n, 12));
    tone(base, 0.10, 'square', 0.055);
    tone(base * 2, 0.07, 'sine', 0.035, null, 0.02);
  }
  function audioHit() { tone(180, 0.35, 'sawtooth', 0.16, 45); noise(0.3, 0.16, 900, 120); }
  function audioBoost() { tone(200, 0.5, 'sawtooth', 0.10, 1400); noise(0.4, 0.08, 400, 4000); }
  function audioOver() {
    [523, 440, 349, 262].forEach(function (f, i) { tone(f, 0.4, 'triangle', 0.10, null, i * 0.16); });
  }

  var SCALE = [0, 2, 3, 5, 7, 8, 10, 12];
  var BASS_PATTERN = [0, 0, 7, 0, 3, 3, 10, 3, 5, 5, 12, 5, 3, 3, 10, 7];
  var ARP_PATTERN = [12, 19, 24, 19, 15, 24, 19, 15, 17, 24, 29, 24, 15, 22, 27, 19];

  function midi(semi) { return 55 * Math.pow(2, semi / 12); }

  function scheduleMusic() {
    if (!AC || muted || !musicOn) return;
    var spb = 0.2174; // ~138 BPM em colcheias
    while (nextNote < AC.currentTime + 0.25) {
      var i = step % 16;
      var t = nextNote - AC.currentTime;
      if (t >= 0) {
        // baixo
        tone(midi(BASS_PATTERN[i]), 0.20, 'triangle', 0.085, null, t);
        // arpejo
        if (i % 2 === 0) tone(midi(ARP_PATTERN[i]), 0.14, 'square', 0.020, null, t);
        // kick
        if (i % 4 === 0) tone(120, 0.13, 'sine', 0.13, 42, t);
      }
      step++;
      nextNote += spb;
    }
  }

  /* =========================================================
     8. LOGICA
     ========================================================= */
  var groundY = 0.5;

  function startGame() {
    initAudio();
    if (AC && AC.state === 'suspended') AC.resume();
    musicOn = true;
    nextNote = AC ? AC.currentTime + 0.1 : 0;
    step = 0;

    G.state = 'playing';
    G.time = 0; G.distance = 0; G.score = 0; G.orbs = 0;
    G.shields = 3; G.energy = 0; G.boost = 0; G.shake = 0; G.flash = 0;
    G.speed = 0; G.baseSpeed = 0; G.dying = 0; G.hitStop = 0;
    G.combo = 0; G.comboTimer = 0; G.mult = 1;
    G.slowT = 0; G.scroll = 0; G.scrollDelta = 0;
    P.x = 0; P.target = 0; P.lane = 1; P.y = STAND_Y; P.vy = 0;
    P.grounded = true; P.sliding = 0; P.tilt = 0; P.invuln = 0; P.spin = 0;
    resetWorld();
    ui.hideAll();
    ui.hud.style.display = 'block';
    ui.turbo.style.display = hasTouch ? 'flex' : 'none';
    syncHud(true);
  }

  function gameOver() {
    G.state = 'over';
    musicOn = false;
    G.isRecord = G.score > G.best;
    if (G.isRecord) {
      G.best = Math.floor(G.score);
      try { localStorage.setItem('neonrunner3d.best', String(G.best)); } catch (e) {}
    }
    audioOver();
    ui.showOver();
  }

  function togglePause() {
    if (G.state === 'playing') {
      G.state = 'paused';
      musicOn = false;
      ui.showPause();
    } else if (G.state === 'paused') {
      G.state = 'playing';
      musicOn = true;
      if (AC) nextNote = Math.max(nextNote, AC.currentTime + 0.05);
      ui.hideAll();
    }
  }

  function toggleMute() {
    muted = !muted;
    if (master) master.gain.value = muted ? 0 : 0.55;
    syncHud(true);
  }

  function playerBox() {
    var hy = (P.sliding > 0 && P.grounded) ? SLIDE_HY : HIT_HY;
    return {
      x0: P.x - 0.38, x1: P.x + 0.38,
      y0: P.y - hy, y1: P.y + hy,
      z0: -0.42, z1: 0.42
    };
  }

  function killPlayer() {
    if (P.invuln > 0 || G.boost > 0) return;
    G.shields--;
    P.invuln = 1.5;
    G.shake = 0.8;
    G.flash = 0.55;
    G.flashColor = [1, 0.15, 0.35];
    G.hitStop = 0.09;
    G.combo = 0; G.comboTimer = 0;
    G.slowT = 0.9;
    G.speed = Math.min(G.speed, G.baseSpeed * 0.62);
    audioHit();
    burst(P.x, P.y, 0.3, 42, 8, 0.7, 1.2, 1.0, 0.25, 0.45, 1);
    if (navigator.vibrate) { try { navigator.vibrate(70); } catch (e) {} }
    if (G.shields <= 0) {
      G.dying = 1.25;
      G.state = 'dying';
      musicOn = false;
      G.shake = 1.4;
      burst(P.x, P.y, 0.3, 90, 14, 1.1, 1.6, 0.35, 0.95, 1.0, 1);
      audioOver();
    }
  }

  function updatePlay(dt) {
    G.time += dt;
    G.hitStop = Math.max(0, G.hitStop - dt);
    var ts = G.hitStop > 0 ? 0.12 : 1;

    // velocidade
    if (G.slowT > 0) G.slowT -= dt;
    G.baseSpeed = Math.min(62, 18 + G.distance * 0.015);
    var boostMul = G.boost > 0 ? 1.42 : 1;
    var slowMul = G.slowT > 0 ? 0.62 : 1;
    var target = G.baseSpeed * boostMul * slowMul;
    G.speed += (target - G.speed) * clamp(dt * 2.4 * ts, 0, 1);

    var s = G.speed * dt;
    G.distance += s;
    G.scrollDelta = s;
    G.scroll += s;
    G.score += s * 0.62 * (G.boost > 0 ? 2 : 1) * G.mult;

    // boost
    if (G.boost > 0) {
      G.boost = Math.max(0, G.boost - dt);
      G.score += s * 0.5;
      if (Math.random() < 0.55) {
        spawnParticle(P.x + rand(-0.5, 0.5), P.y + rand(-0.4, 0.4), rand(0.6, 2.4),
          rand(-1, 1), rand(-0.5, 0.5), rand(4, 9), 0.45, rand(0.5, 1.3), 0.3, 0.95, 1.0);
      }
    }

    // combo
    if (G.comboTimer > 0) {
      G.comboTimer -= dt;
      if (G.comboTimer <= 0) { G.combo = 0; G.mult = 1; }
    }

    // movimento lateral
    var dx = P.target - P.x;
    var stepL = 15.5 * dt * ts;
    if (Math.abs(dx) <= stepL) P.x = P.target;
    else P.x += Math.sign(dx) * stepL;
    P.tilt += ((P.target - P.x) * -0.28 - P.tilt) * clamp(dt * 10, 0, 1);
    P.spin += dt * (2.4 + G.speed * 0.05);

    // pulo / gravidade
    var gy = (P.sliding > 0) ? SLIDE_Y : STAND_Y;
    if (!P.grounded) {
      P.vy -= 92 * dt * ts;
      P.y += P.vy * dt * ts;
      P.airTime += dt;
      if (P.y <= gy) {
        P.y = gy; P.vy = 0; P.grounded = true; P.airTime = 0;
        if (input.jumpBuffer > 0) { input.jumpBuffer = 0; doJump(); }
        else { burst(P.x, 0.08, 0.15, 6, 2.2, 0.3, 0.45, 0.2, 0.9, 1.0, 0.25); }
      }
    } else {
      P.y = gy;
      input.coyote = 0.1;
    }
    if (!P.grounded && Math.random() < 0.75) {
      spawnParticle(P.x + rand(-0.22, 0.22), P.y + rand(-0.18, 0.18), rand(-0.2, 0.4),
        rand(-0.6, 0.6), rand(-1.6, -0.2), rand(-1, 1), 0.32, 0.55, 0.3, 0.9, 1.0);
    }
    if (input.jumpBuffer > 0) input.jumpBuffer -= dt;
    if (P.grounded) input.coyote -= dt;

    if (P.sliding > 0) {
      P.sliding -= dt;
      if (P.sliding <= 0) P.sliding = 0;
    }
    if (P.invuln > 0) P.invuln -= dt;

    /* ---- rolagem do mundo ---- */
    var i, o;
    for (i = 0; i < OBST.length; i++) {
      o = OBST[i];
      if (!o.on) continue;
      o.z += s;
      if (o.z > 16) o.on = false;
    }
    for (i = 0; i < ORBS.length; i++) {
      o = ORBS[i];
      if (!o.on) continue;
      o.pz = o.z;
      o.z += s;
      o.spin += dt * 2.2;
      o.pulse += dt * 5;
      if (o.z > 16) o.on = false;
    }
    for (i = 0; i < RAIL.length; i++) {
      var r = RAIL[i];
      r.z += s;
      if (r.z > 24) r.z -= RAIL.length / 2 * r.len;
    }
    for (i = 0; i < BLD.length; i++) {
      var b = BLD[i];
      b.z += s * 1.02;
      if (b.z > 40) respawnBuilding(b, b.z - BLD.length / 2 * 16 - rand(0, 12));
    }

    /* ---- colisao ---- */
    var pb = playerBox();
    var sv = s; // varredura em z para nao atravessar
    for (i = 0; i < OBST.length; i++) {
      o = OBST[i];
      if (!o.on) continue;
      var oz0 = o.z - o.d / 2, oz1 = o.z + o.d / 2 + sv;
      if (oz1 < pb.z0 || oz0 > pb.z1) continue;
      if (o.x + o.w / 2 < pb.x0 || o.x - o.w / 2 > pb.x1) continue;
      if (o.y1 < pb.y0 || o.y0 > pb.y1) continue;
      killPlayer();
      if (G.state === 'dying') return;
    }

    /* ---- orbes ---- */
    for (i = 0; i < ORBS.length; i++) {
      o = ORBS[i];
      if (!o.on || o.taken) continue;
      var dxx = o.x - P.x, dyy = o.y - P.y;
      var pz = (o.pz === undefined) ? o.z : o.pz;
      if ((pz - 0.85) <= 0.45 && (o.z + 0.85) >= -0.45 &&
          Math.abs(dxx) < 0.9 && Math.abs(dyy) < 1.05) {
        o.on = false;
        o.taken = 1;
        G.orbs++;
        G.combo++;
        G.comboTimer = 2.2;
        G.mult = 1 + Math.min(G.combo, 20) * 0.05;
        var gain = 14 * G.mult * (G.boost > 0 ? 2 : 1);
        G.score += gain;
        G.energy = Math.min(100, G.energy + (G.boost > 0 ? 2 : 7));
        audioCollect(G.combo);
        burst(o.x, o.y, o.z, 12, 5, 0.42, 0.85, 0.25, 1.0, 0.95, 0.6);
      }
    }

    updateSpawner();
  }

  /* =========================================================
     9. PARTICULAS / RASTRO - atualizacao
     ========================================================= */
  function updateParticles(dt, scrollZ) {
    var n = 0, i, p;
    for (i = particles.length - 1; i >= 0; i--) {
      p = particles[i];
      p.l -= dt;
      if (p.l <= 0) { particles.splice(i, 1); continue; }
      p.vy -= 26 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt + scrollZ;
      if (p.y < 0.03) { p.y = 0.03; p.vy *= -0.35; p.vx *= 0.7; p.vz *= 0.7; }
      if (p.z > 30) { particles.splice(i, 1); continue; }
    }
    for (i = 0; i < particles.length && n < MAXP; i++) {
      p = particles[i];
      var k = p.l / p.lm;
      var f = k * k;
      var j = n * 7;
      pData[j] = p.x; pData[j + 1] = p.y; pData[j + 2] = p.z;
      pData[j + 3] = p.r * f; pData[j + 4] = p.g * f; pData[j + 5] = p.b * f;
      pData[j + 6] = p.s * (0.45 + 0.55 * k);
      n++;
    }
    return n;
  }

  function updateTrail(dt, scrollZ, active) {
    for (var i = 0; i < trail.length; i++) trail[i].z += scrollZ;
    while (trail.length && trail[trail.length - 1].z > 26) trail.pop();

    trail.age = (trail.age || 0) + dt;
    if (active && trail.age > 0.018) {
      trail.age = 0;
      trail.unshift({
        x: P.x + rand(-0.1, 0.1),
        y: P.y + rand(-0.12, 0.12),
        z: rand(-0.1, 0.35)
      });
      if (trail.length > TRAIL_MAX) trail.pop();
    }
  }

  /* =========================================================
     10. RENDER
     ========================================================= */
  var proj = m4(), view = m4();
  var aspect = 1;
  var camX = 0, camY = 5.0, camZ = 10.2;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.floor(window.innerWidth * dpr));
    var h = Math.max(1, Math.floor(window.innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
    aspect = canvas.width / canvas.height;
  }
  window.addEventListener('resize', resize);

  var GRID_QUAD = null;

  function drawGrid(scrollZ, pulse) {
    if (!GRID_QUAD) {
      var d = geomQuad(420, 460);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
      GRID_QUAD = { buf: buf, count: 6 };
    }
    gl.useProgram(PROG_GRID.p);
    gl.uniformMatrix4fv(PROG_GRID.u.uProj, false, proj);
    gl.uniformMatrix4fv(PROG_GRID.u.uView, false, view);
    gl.uniform2f(PROG_GRID.u.uScroll, 0, -scrollZ);
    gl.uniform1f(PROG_GRID.u.uCell, CELL);
    gl.uniform3f(PROG_GRID.u.uFog, FOG[0], FOG[1], FOG[2]);
    gl.uniform1f(PROG_GRID.u.uFogD, FOG_D * 1.15);
    gl.uniform3f(PROG_GRID.u.uGridColor, 0.04, 0.30, 0.52);
    gl.uniform3f(PROG_GRID.u.uLineColor, 0.10, 0.85, 1.0);
    gl.uniform1f(PROG_GRID.u.uPulse, pulse);

    gl.bindBuffer(gl.ARRAY_BUFFER, GRID_QUAD.buf);
    gl.enableVertexAttribArray(PROG_GRID.a.aPos);
    gl.vertexAttribPointer(PROG_GRID.a.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  var STAR_N = 420;
  var starData = new Float32Array(STAR_N * 7);
  var starBuf = null;

  function buildStars() {
    for (var i = 0; i < STAR_N; i++) {
      var j = i * 7;
      starData[j] = rand(-260, 260);
      starData[j + 1] = rand(-20, 220);
      starData[j + 2] = rand(-420, 40);
      var c = rand(0.25, 1);
      var hue = Math.random();
      starData[j + 3] = c * (hue < 0.5 ? 1 : 0.5);
      starData[j + 4] = c * 0.8;
      starData[j + 5] = c * (hue < 0.5 ? 0.9 : 1);
      starData[j + 6] = rand(2, 12);
    }
  }

  function drawStars() {
    if (!starBuf) {
      buildStars();
      starBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
      gl.bufferData(gl.ARRAY_BUFFER, starData, gl.STATIC_DRAW);
    }
    gl.useProgram(PROG_POINT.p);
    gl.uniformMatrix4fv(PROG_POINT.u.uProj, false, proj);
    gl.uniformMatrix4fv(PROG_POINT.u.uView, false, view);
    gl.uniform1f(PROG_POINT.u.uScale, 46);
    gl.uniform1f(PROG_POINT.u.uFogD, FOG_D * 0.55);
    gl.uniform1f(PROG_POINT.u.uPower, 1.6);
    gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
    gl.enableVertexAttribArray(PROG_POINT.a.aPos);
    gl.vertexAttribPointer(PROG_POINT.a.aPos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(PROG_POINT.a.aColor);
    gl.vertexAttribPointer(PROG_POINT.a.aColor, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(PROG_POINT.a.aSize);
    gl.vertexAttribPointer(PROG_POINT.a.aSize, 1, gl.FLOAT, false, 28, 24);
    gl.drawArrays(gl.POINTS, 0, STAR_N);
  }

  var ptBuf = null;

  function drawPoints(count) {
    if (count <= 0) return;
    if (!ptBuf) {
      ptBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pData, gl.DYNAMIC_DRAW);
    }
    gl.useProgram(PROG_POINT.p);
    gl.uniformMatrix4fv(PROG_POINT.u.uProj, false, proj);
    gl.uniformMatrix4fv(PROG_POINT.u.uView, false, view);
    gl.uniform1f(PROG_POINT.u.uScale, 150);
    gl.uniform1f(PROG_POINT.u.uFogD, FOG_D);
    gl.uniform1f(PROG_POINT.u.uPower, 1.9);
    gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pData.subarray(0, count * 7));
    gl.enableVertexAttribArray(PROG_POINT.a.aPos);
    gl.vertexAttribPointer(PROG_POINT.a.aPos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(PROG_POINT.a.aColor);
    gl.vertexAttribPointer(PROG_POINT.a.aColor, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(PROG_POINT.a.aSize);
    gl.vertexAttribPointer(PROG_POINT.a.aSize, 1, gl.FLOAT, false, 28, 24);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  var trailData = new Float32Array(TRAIL_MAX * 7);

  function drawTrail() {
    var n = 0, i;
    for (i = 0; i < trail.length; i++) {
      var t = trail[i];
      var k = 1 - i / Math.max(1, trail.length);
      var j = n * 7;
      trailData[j] = t.x; trailData[j + 1] = t.y; trailData[j + 2] = t.z;
      trailData[j + 3] = 0.15 * k; trailData[j + 4] = 0.85 * k; trailData[j + 5] = 1.0 * k;
      trailData[j + 6] = 0.9 * k + 0.15;
      n++;
    }
    if (!n) return;
    if (!trailBuf) {
      trailBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, trailBuf);
      gl.bufferData(gl.ARRAY_BUFFER, trailData, gl.DYNAMIC_DRAW);
    }
    gl.useProgram(PROG_POINT.p);
    gl.uniformMatrix4fv(PROG_POINT.u.uProj, false, proj);
    gl.uniformMatrix4fv(PROG_POINT.u.uView, false, view);
    gl.uniform1f(PROG_POINT.u.uScale, 96);
    gl.uniform1f(PROG_POINT.u.uFogD, FOG_D * 0.8);
    gl.uniform1f(PROG_POINT.u.uPower, 2.2);
    gl.bindBuffer(gl.ARRAY_BUFFER, trailBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, trailData.subarray(0, n * 7));
    gl.enableVertexAttribArray(PROG_POINT.a.aPos);
    gl.vertexAttribPointer(PROG_POINT.a.aPos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(PROG_POINT.a.aColor);
    gl.vertexAttribPointer(PROG_POINT.a.aColor, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(PROG_POINT.a.aSize);
    gl.vertexAttribPointer(PROG_POINT.a.aSize, 1, gl.FLOAT, false, 28, 24);
    gl.drawArrays(gl.POINTS, 0, n);
  }
  var trailBuf = null;

  function render(dt) {
    var boostFx = G.boost > 0 ? 1 : 0;

    // camera
    var shakeX = G.shake > 0 ? rand(-1, 1) * G.shake * 0.55 : 0;
    var shakeY = G.shake > 0 ? rand(-1, 1) * G.shake * 0.4 : 0;
    var tcx = P.x * 0.42;
    camX += (tcx - camX) * clamp(dt * 4.5, 0, 1);
    var fovK = clamp((G.speed - 18) / 44, 0, 1);
    var fov = (66 + fovK * 12 + boostFx * 8) * Math.PI / 180;
    var deathZoom = G.state === 'dying' ? 1 + (1 - G.dying / 1.25) * 0.35 : 1;

    var eyeX = camX + shakeX;
    var eyeY = (4.55 + boostFx * 0.35 + shakeY) * deathZoom;
    var eyeZ = (9.9 + boostFx * 1.4) * deathZoom;
    m4perspective(proj, fov, aspect, 0.1, 620);
    m4lookAt(view, eyeX, eyeY, eyeZ, camX * 0.9, 1.35 + shakeY * 0.5, -9, 0, 1, 0);

    gl.clearColor(FOG[0], FOG[1], FOG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // estrelas
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    drawStars();

    // grid do chao
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
    drawGrid(G.scroll, 0.5 + 0.5 * Math.sin(G.time * 3.0) * (boostFx ? 1 : 0.5));

    // sombra do jogador: ajuda a enxergar a altura no pulo
    if (G.state !== 'over') {
      var hgt = clamp((P.y - STAND_Y) / 2.2, 0, 1);
      gl.useProgram(PROG_MAIN.p);
      gl.uniformMatrix4fv(PROG_MAIN.u.uProj, false, proj);
      gl.uniformMatrix4fv(PROG_MAIN.u.uView, false, view);
      gl.uniform3f(PROG_MAIN.u.uFog, FOG[0], FOG[1], FOG[2]);
      gl.uniform1f(PROG_MAIN.u.uFogD, FOG_D);
      gl.uniform3f(PROG_MAIN.u.uLight, -0.35, -0.75, -0.55);
      gl.uniform3f(PROG_MAIN.u.uColor, 0.0, 0.0, 0.0);
      gl.uniform3f(PROG_MAIN.u.uEmissive, 0.0, 0.0, 0.0);
      gl.uniform1f(PROG_MAIN.u.uAlpha, 0.5 * (1.0 - hgt * 0.6));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      m4compose(MODEL, P.x, 0.035, 0, 0, 0, 0, 1, 1, 1);
      setNormalFromModel();
      gl.uniformMatrix4fv(PROG_MAIN.u.uModel, false, MODEL);
      gl.uniformMatrix3fv(PROG_MAIN.u.uNormal, false, NORMAL);
      drawMesh(MESH_QUAD);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.uniform1f(PROG_MAIN.u.uAlpha, 1.0);
    }

    // geometria solida
    gl.disable(gl.BLEND);
    gl.useProgram(PROG_MAIN.p);
    gl.uniformMatrix4fv(PROG_MAIN.u.uProj, false, proj);
    gl.uniformMatrix4fv(PROG_MAIN.u.uView, false, view);
    gl.uniform3f(PROG_MAIN.u.uFog, FOG[0], FOG[1], FOG[2]);
    gl.uniform1f(PROG_MAIN.u.uFogD, FOG_D);
    gl.uniform3f(PROG_MAIN.u.uLight, -0.35, -0.75, -0.55);
    gl.uniform1f(PROG_MAIN.u.uAlpha, 1.0);

    var i, o, b, r;

    // predios
    for (i = 0; i < BLD.length; i++) {
      b = BLD[i];
      var hue = b.hue;
      var cr = 0.35 + 0.65 * Math.abs(Math.sin(hue * 6.28));
      var cg = 0.35 + 0.65 * Math.abs(Math.sin(hue * 6.28 + 2.1));
      var cb = 0.35 + 0.65 * Math.abs(Math.sin(hue * 6.28 + 4.2));
      drawBox(b.x, b.y, b.z, b.w, b.h, b.d,
        0.02 + cr * 0.05, 0.02 + cg * 0.05, 0.06 + cb * 0.09,
        cr * 0.10, cg * 0.10, cb * 0.16);
    }

    // trilhos laterais
    for (i = 0; i < RAIL.length; i++) {
      r = RAIL[i];
      var railC = boostFx ? [0.25, 1.0, 0.9] : [0.05, 0.72, 1.0];
      drawBox(r.x, r.y, r.z, 0.13, 0.07, r.len, railC[0], railC[1], railC[2], 0.05, 0.36, 0.5);
      drawBox(r.x, r.y + 0.8, r.z, 0.055, 0.055, r.len,
        railC[0], railC[1], railC[2], 0.12, 0.72, 0.9);
    }

    // obstaculos
    for (i = 0; i < OBST.length; i++) {
      o = OBST[i];
      if (!o.on) continue;
      var col = OBS_COLORS[o.type];
      var h = o.y1 - o.y0, cy = (o.y0 + o.y1) / 2;
      var pz = Math.sin(G.time * 6 + o.z * 0.3) * 0.5 + 0.5;
      drawBox(o.x, cy, o.z, o.w, h, o.d,
        col.c[0], col.c[1], col.c[2],
        col.e[0] * (0.8 + pz * 0.5), col.e[1] * (0.8 + pz * 0.5), col.e[2] * (0.8 + pz * 0.5));
      // faixa de alerta
      drawBox(o.x, o.y1 + 0.06, o.z, o.w * 1.02, 0.09, o.d * 1.05,
        1, 1, 1, col.e[0] * 1.6, col.e[1] * 1.6, col.e[2] * 1.6);
    }

    // orbes
    for (i = 0; i < ORBS.length; i++) {
      o = ORBS[i];
      if (!o.on) continue;
      var pl = 0.9 + Math.sin(o.pulse) * 0.12;
      m4compose(MODEL, o.x, o.y, o.z, 0, o.spin, 0, 0.42 * pl, 0.42 * pl, 0.42 * pl);
      setNormalFromModel();
      gl.uniformMatrix4fv(PROG_MAIN.u.uModel, false, MODEL);
      gl.uniformMatrix3fv(PROG_MAIN.u.uNormal, false, NORMAL);
      gl.uniform3f(PROG_MAIN.u.uColor, 0.15, 1.0, 0.9);
      gl.uniform3f(PROG_MAIN.u.uEmissive, 0.25, 1.25, 1.1);
      drawMesh(MESH_OCTA);
      // nucleo
      m4compose(MODEL, o.x, o.y, o.z, o.spin * 1.7, o.spin * 1.3, 0, 0.2, 0.2, 0.2);
      setNormalFromModel();
      gl.uniformMatrix4fv(PROG_MAIN.u.uModel, false, MODEL);
      gl.uniformMatrix3fv(PROG_MAIN.u.uNormal, false, NORMAL);
      gl.uniform3f(PROG_MAIN.u.uColor, 1, 1, 1);
      gl.uniform3f(PROG_MAIN.u.uEmissive, 1.6, 1.6, 1.6);
      drawMesh(MESH_BOX);
    }

    // jogador
    if (G.state !== 'over') {
      var blink = (P.invuln > 0 && Math.floor(P.invuln * 14) % 2 === 0) ? 0.25 : 1;
      var py = P.y;
      var sliding = (P.sliding > 0 && P.grounded);
      var sy = sliding ? SLIDE_HY * 1.07 : STAND_HY;
      var sxz = sliding ? 0.72 : 0.55;
      var boostGlow = boostFx ? 1.6 : 1;
      m4compose(MODEL, P.x, py, 0, 0, P.spin, P.tilt * 1.6, sxz, sy, sxz);
      setNormalFromModel();
      gl.uniformMatrix4fv(PROG_MAIN.u.uModel, false, MODEL);
      gl.uniformMatrix3fv(PROG_MAIN.u.uNormal, false, NORMAL);
      gl.uniform3f(PROG_MAIN.u.uColor, 0.85 * blink, 0.95 * blink, 1.0 * blink);
      gl.uniform3f(PROG_MAIN.u.uEmissive,
        0.10 * boostGlow, 0.75 * boostGlow * blink, 1.05 * boostGlow * blink);
      drawMesh(MESH_OCTA);

      // asas
      drawBox(P.x - 0.62, py, 0.12, 0.5, 0.10, 0.75, 0.2, 0.9, 1.0, 0.15, 1.1, 1.4);
      drawBox(P.x + 0.62, py, 0.12, 0.5, 0.10, 0.75, 0.2, 0.9, 1.0, 0.15, 1.1, 1.4);
      // escudo
      if (P.invuln > 0) {
        var sc = 1.5 + Math.sin(G.time * 20) * 0.08;
        m4compose(MODEL, P.x, py, 0, 0, G.time * 3, 0, sc, sc, sc);
        setNormalFromModel();
        gl.uniformMatrix4fv(PROG_MAIN.u.uModel, false, MODEL);
        gl.uniformMatrix3fv(PROG_MAIN.u.uNormal, false, NORMAL);
        gl.uniform3f(PROG_MAIN.u.uColor, 1.0, 0.3, 0.5);
        gl.uniform3f(PROG_MAIN.u.uEmissive, 0.5, 0.05, 0.2);
        gl.uniform1f(PROG_MAIN.u.uAlpha, 0.5);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        drawMesh(MESH_OCTA);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.uniform1f(PROG_MAIN.u.uAlpha, 1.0);
      }
    }

    /* ---- pontos aditivos ---- */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    drawTrail();
    var pcount = updateParticles(lastDt, G.scrollDelta);
    drawPoints(pcount);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /* =========================================================
     11. UI
     ========================================================= */
  var ui = {};
  function $(id) { return document.getElementById(id); }

  function initUI() {
    ui.hud = $('hud');
    ui.score = $('score');
    ui.best = $('best');
    ui.dist = $('dist');
    ui.spd = $('spd');
    ui.orbs = $('orbs');
    ui.shells = $('shells');
    ui.energyFill = $('energy-fill');
    ui.turbo = $('btn-turbo');
    ui.combo = $('combo');
    ui.menu = $('screen-menu');
    ui.pause = $('screen-pause');
    ui.over = $('screen-over');
    ui.finalScore = $('final-score');
    ui.finalStats = $('final-stats');
    ui.newRecord = $('new-record');
    ui.mute = $('btn-mute');
    ui.flash = $('flash');
    ui.countdown = null;

    $('btn-play').addEventListener('click', startGame);
    $('btn-again').addEventListener('click', startGame);
    $('btn-resume').addEventListener('click', togglePause);
    $('btn-restart').addEventListener('click', startGame);
    $('btn-quit').addEventListener('click', function () {
      G.state = 'menu';
      musicOn = false;
      ui.hideAll();
      ui.menu.style.display = 'flex';
      ui.hud.style.display = 'none';
    });
    ui.mute.addEventListener('click', function (e) { e.stopPropagation(); toggleMute(); });
    $('btn-pause').addEventListener('click', function (e) { e.stopPropagation(); togglePause(); });

    ui.turbo.addEventListener('touchstart', function (e) { e.preventDefault(); e.stopPropagation(); doBoost(); }, { passive: false });
    ui.turbo.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); doBoost(); });

    ui.hideAll = function () {
      ui.menu.style.display = 'none';
      ui.pause.style.display = 'none';
      ui.over.style.display = 'none';
    };
    ui.showPause = function () { ui.hideAll(); ui.pause.style.display = 'flex'; };
    ui.showOver = function () {
      ui.hideAll();
      ui.hud.style.display = 'none';
      ui.over.style.display = 'flex';
      ui.finalScore.textContent = Math.floor(G.score).toLocaleString('pt-BR');
      ui.finalStats.innerHTML =
        '<span>' + Math.floor(G.distance) + ' m</span>' +
        '<span>' + G.orbs + ' nucleos</span>' +
        '<span>' + Math.floor(G.speed * 3.6) + ' km/h max</span>';
      ui.newRecord.style.display = G.isRecord ? 'block' : 'none';
      ui.best.textContent = 'RECORDE ' + G.best.toLocaleString('pt-BR');
    };
    ui.best.textContent = 'RECORDE ' + G.best.toLocaleString('pt-BR');
  }

  var lastHud = {};
  function syncHud(force) {
    var sc = Math.floor(G.score);
    if (force || lastHud.sc !== sc) { ui.score.textContent = sc.toLocaleString('pt-BR'); lastHud.sc = sc; }
    var ds = Math.floor(G.distance);
    if (force || lastHud.ds !== ds) { ui.dist.textContent = ds + ' m'; lastHud.ds = ds; }
    var sp = Math.floor(G.speed * 3.6);
    if (force || lastHud.sp !== sp) { ui.spd.textContent = sp + ' km/h'; lastHud.sp = sp; }
    if (force || lastHud.orbs !== G.orbs) { ui.orbs.textContent = G.orbs; lastHud.orbs = G.orbs; }
    if (force || lastHud.sh !== G.shields) {
      var html = '';
      for (var i = 0; i < G.maxShields; i++) {
        html += '<i class="' + (i < G.shields ? 'on' : 'off') + '"></i>';
      }
      ui.shells.innerHTML = html;
      lastHud.sh = G.shields;
    }
    var en = Math.round(G.energy);
    if (force || lastHud.en !== en) {
      ui.energyFill.style.width = en + '%';
      ui.energyFill.className = en >= 100 ? 'full' : '';
      lastHud.en = en;
    }
    var cm = G.mult > 1.001 ? 'x' + G.mult.toFixed(2) : '';
    if (force || lastHud.cm !== cm) { ui.combo.textContent = cm; lastHud.cm = cm; }
    if (force || lastHud.mu !== muted) {
      ui.mute.textContent = muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
      lastHud.mu = muted;
    }
  }

  function updateFlash(dt) {
    if (G.flash > 0) {
      G.flash = Math.max(0, G.flash - dt * 1.8);
      var a = G.flash * 0.7;
      ui.flash.style.background =
        'radial-gradient(circle at 50% 55%, rgba(' +
        Math.round(G.flashColor[0] * 255) + ',' + Math.round(G.flashColor[1] * 255) + ',' +
        Math.round(G.flashColor[2] * 255) + ',0) 30%, rgba(' +
        Math.round(G.flashColor[0] * 255) + ',' + Math.round(G.flashColor[1] * 255) + ',' +
        Math.round(G.flashColor[2] * 255) + ',' + a.toFixed(3) + ') 100%)';
      ui.flash.style.opacity = '1';
    } else if (ui.flash.style.opacity !== '0') {
      ui.flash.style.opacity = '0';
    }
  }

  /* =========================================================
     12. LOOP
     ========================================================= */
  var lastT = 0, lastDt = 0.016;
  var hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  function frame(t) {
    requestAnimationFrame(frame);
    if (!lastT) lastT = t;
    var dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    lastDt = dt;

    resize();

    if (G.state === 'playing') {
      updatePlay(dt);
      G.shake = Math.max(0, G.shake - dt * 2.6);
      if (G.time > 0.2 && !hasTouch) ui.turbo.style.display = 'none';
    } else if (G.state === 'dying') {
      var ts = clamp(G.dying / 1.25, 0, 1);
      updatePlay(dt * (0.25 + ts * 0.35));
      G.shake = Math.max(0, G.shake - dt * 1.6);
      G.dying -= dt;
      if (G.dying <= 0) gameOver();
    } else if (G.state === 'menu') {
      // cena de fundo animada
      G.speed = 16;
      G.time += dt;
      var s2 = G.speed * dt;
      G.scroll += s2;
      G.scrollDelta = s2;
      for (var i = 0; i < RAIL.length; i++) {
        RAIL[i].z += s2;
        if (RAIL[i].z > 24) RAIL[i].z -= RAIL.length / 2 * RAIL[i].len;
      }
      for (i = 0; i < BLD.length; i++) {
        BLD[i].z += s2;
        if (BLD[i].z > 40) respawnBuilding(BLD[i], BLD[i].z - BLD.length / 2 * 16 - rand(0, 12));
      }
      P.y = STAND_Y + 0.75 + Math.sin(G.time * 2) * 0.35;
      P.spin += dt * 1.4;
      P.tilt = Math.sin(G.time * 0.7) * 0.2;
      P.x = Math.sin(G.time * 0.45) * 1.2;
      P.invuln = 0; P.sliding = 0;
    } else {
      G.time += dt;
      G.scrollDelta = 0;
      G.shake = Math.max(0, G.shake - dt * 2.6);
    }

    if (G.state === 'paused') { G.scrollDelta = 0; render(dt); return; }

    updateTrail(dt, G.scrollDelta || 0, G.state === 'playing' && G.boost > 0);
    render(dt);

    if (G.state === 'playing' || G.state === 'dying') syncHud(false);
    updateFlash(dt);
    scheduleMusic();

    if (G.state === 'menu') ui.turbo.style.display = 'none';
  }

  /* =========================================================
     BOOT
     ========================================================= */
  try {
    initPools();
    initUI();
    resetWorld();
    resize();
    m4identity(m4());
    requestAnimationFrame(frame);
  } catch (err) {
    var fb2 = document.getElementById('fallback');
    if (fb2) {
      fb2.style.display = 'flex';
      fb2.querySelector('.fb-title').textContent = 'Erro ao iniciar';
      fb2.querySelector('.fb-text').textContent = String(err && err.message || err);
    }
    if (window.console) console.error(err);
  }

  // gancho de depuracao / automacao
  window.NEON = {
    G: G, P: P, OBST: OBST, ORBS: ORBS,
    start: startGame, jump: doJump, slide: doSlide,
    boost: doBoost, lane: moveLane
  };
})();

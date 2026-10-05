// Genera parcelario_chubut.min.json a partir de parcelario_chubut.geojson.
//
//   node mapas/generar_parcelario.mjs
//
// El GeoJSON original pesa ~8 MB. El sistema no lo usa directamente: lo
// proyecta a las coordenadas del mapa SVG, simplifica los bordes (~10 m) y
// guarda los vértices como enteros con codificación delta (~1 MB).
// Volver a correrlo cada vez que se actualice el parcelario.
//
// Formato de salida:
//   { v:1, q:100, p:[ [cx, cy, deptoCod, ha, renspa, nombre, chacra, anillos], ... ] }
//   - cx, cy: punto interior de la parcela (unidades SVG × q, enteros).
//   - renspa / nombre / chacra: 0 cuando el dato no existe.
//   - anillos: [[x0, y0, dx1, dy1, dx2, dy2, ...], ...]  (× q, enteros;
//     el primero es el contorno exterior, los siguientes son huecos).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRADA = path.join(DIR, "parcelario_chubut.geojson");
const SALIDA = path.join(DIR, "parcelario_chubut.min.json");

// Debe coincidir con CHUBUT_PROY en sistema_crecer.jsx.
const PROY = { ax: 71.108998, bx: 5147.2825, ay: -98.849024, by: -4137.6114 };
const Q = 100;

const proyectar = ([lon, lat]) => [PROY.ax * lon + PROY.bx, PROY.ay * lat + PROY.by];

function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  let dmax = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = L > 1e-12
      ? Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L
      : Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  const izq = douglasPeucker(pts.slice(0, idx + 1), eps);
  return izq.slice(0, -1).concat(douglasPeucker(pts.slice(idx), eps));
}

function areaAnillo(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s) / 2;
}

function dentro(pt, anillos) {
  let c = false;
  for (const r of anillos)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
  return c;
}

// Punto donde poner el marcador. El centroide de una parcela con forma de L
// o de U puede caer afuera; en ese caso se toma el centro del tramo interior
// más ancho de una línea horizontal que cruza la parcela.
function puntoInterior(anillos) {
  const ext = anillos[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ext.length - 1; i < ext.length; j = i++) {
    const f = ext[j][0] * ext[i][1] - ext[i][0] * ext[j][1];
    a += f; cx += (ext[j][0] + ext[i][0]) * f; cy += (ext[j][1] + ext[i][1]) * f;
  }
  const c = Math.abs(a) > 1e-12 ? [cx / (3 * a), cy / (3 * a)] : ext[0];
  if (dentro(c, anillos)) return c;
  const ys = ext.map(p => p[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  let mejor = null;
  for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const y = y0 + (y1 - y0) * t, xs = [];
    for (const r of anillos)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2)
      if (!mejor || xs[k + 1] - xs[k] > mejor.ancho) mejor = { ancho: xs[k + 1] - xs[k], p: [(xs[k] + xs[k + 1]) / 2, y] };
  }
  return mejor ? mejor.p : c;
}

function codificarAnillo(r) {
  const out = [];
  let px = 0, py = 0;
  for (const [x, y] of r) {
    const qx = Math.round(x * Q), qy = Math.round(y * Q);
    if (out.length && qx === px && qy === py) continue;
    out.push(qx - px, qy - py);
    px = qx; py = qy;
  }
  return out;
}

const texto = v => (v === null || v === undefined || String(v).trim() === "" ? 0 : String(v).trim());

const geo = JSON.parse(fs.readFileSync(ENTRADA, "utf8"));
const vistos = new Set();
let vertices = 0, descartadas = 0;
const p = [];

for (const f of geo.features) {
  const g = f.geometry;
  if (!g) { descartadas++; continue; }
  const poligonos = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  // Se conserva el polígono más grande; el parcelario trae uno por parcela.
  const pol = poligonos
    .map(poly => poly.map(r => r.map(proyectar)))
    .sort((m, n) => areaAnillo(n[0]) - areaAnillo(m[0]))[0];
  if (!pol || pol[0].length < 4) { descartadas++; continue; }

  const eps = Math.min(0.01, Math.sqrt(areaAnillo(pol[0])) * 0.05);
  const anillos = pol
    .map(r => {
      const abierto = r.slice(0, -1);
      const s = douglasPeucker(r, eps).slice(0, -1);
      return s.length >= 3 ? s : abierto;
    })
    .filter(r => r.length >= 3);
  if (!anillos.length) { descartadas++; continue; }

  const [ix, iy] = puntoInterior(anillos);
  let cx = Math.round(ix * Q), cy = Math.round(iy * Q);
  const depto = String(f.properties.depto || "").padStart(3, "0");
  // El id de la parcela en el sistema es depto + punto interior, así que
  // tiene que ser único: ante un empate se corre el punto 1 cm del mapa (~10 m).
  while (vistos.has(`${depto}-${cx}-${cy}`)) cx++;
  vistos.add(`${depto}-${cx}-${cy}`);

  const cod = anillos.map(codificarAnillo);
  vertices += cod.reduce((s, r) => s + r.length / 2, 0);
  p.push([
    cx, cy, depto,
    Math.round((Number(f.properties.area) || 0) / 100) / 100,
    texto(f.properties.renspa), texto(f.properties.nom_establ), texto(f.properties.chacra),
    cod,
  ]);
}

fs.writeFileSync(SALIDA, JSON.stringify({ v: 1, q: Q, generado: new Date().toISOString().slice(0, 10), p }));
const kb = (fs.statSync(SALIDA).size / 1024).toFixed(0);
console.log(`${p.length} parcelas · ${vertices} vértices · ${descartadas} descartadas · ${kb} KB → ${path.relative(process.cwd(), SALIDA)}`);

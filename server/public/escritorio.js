import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Escritório 3D: o mesmo estado do palco 2D, desenhado como uma sala onde cada
 * agente tem a sua mesa. O orquestrador fica na mesa da frente, perto da TV;
 * os especialistas, em fileiras.
 *
 * Os dados são os do painel: `/v1/stage` uma vez, depois só `/v1/stream`. Nada
 * aqui é novo no servidor — a sala é outra forma de desenhar os mesmos cinco
 * estados.
 *
 * Tudo é feito de formas básicas no código, sem modelo 3D para baixar: o que
 * pesa é só o Three.js, que vem do CDN pelo import map.
 */

// --- Formatação -----------------------------------------------------------

const BR1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const BRint = new Intl.NumberFormat('pt-BR');

/** 1234 → "1,2 mil"; 2,4M → "2,4 mi". Abaixo de mil, o inteiro. */
function tk(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${BR1.format(v / 1_000_000)} mi`;
  if (v >= 1_000) return `${BR1.format(v / 1_000)} mil`;
  return BRint.format(v);
}

// --- Paleta ---------------------------------------------------------------

// Os mesmos tons do tema escuro de `styles.css`: o personagem tem de ser
// reconhecível de um painel para o outro.
const COR_PAPEL = {
  orquestrador: '#fb923c',
  designer: '#e879f9',
  frontend: '#60a5fa',
  backend: '#4ade80',
  revisor: '#fbbf24',
  pesquisador: '#a78bfa',
  devops: '#2dd4bf',
  dados: '#fb7185',
  qa: '#38bdf8',
  generico: '#94a3b8',
};

const MADEIRA = '#a0673c';
const MADEIRA_ESCURA = '#6b4226';
const PAREDE = '#231d1a';
const GRAFITE = '#1f2328';

const reduzirMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- Geometria da sala ----------------------------------------------------

// Fileiras de especialistas: três mesas por fileira, quatro unidades entre
// uma fileira e outra. A sala cresce para trás da câmera conforme o time.
const COLUNAS = [-0.5, 4, 8.5];
const FILEIRA_Z0 = -1;
const FILEIRA_PASSO = 4;
const MESA_LIDER = new THREE.Vector3(4, 0, -5.6);
// Corredor entre a mesa do orquestrador e a primeira fileira.
const CORREDOR_Z = -3.9;
// Onde o personagem fica, relativo à mesa.
const ASSENTO = new THREE.Vector3(0, 0, -1.05);

function dimensoesSala(especialistas) {
  const fileiras = Math.max(3, Math.ceil(especialistas / COLUNAS.length));
  const zFrente = FILEIRA_Z0 + (fileiras - 1) * FILEIRA_PASSO + 2.5;
  return { xMin: -12, xMax: 12, zMin: -9, zMax: Math.max(9, zFrente) };
}

// --- Peças ----------------------------------------------------------------

function material(cor, extra = {}) {
  return new THREE.MeshStandardMaterial({ color: cor, roughness: 0.85, ...extra });
}

function malha(geometria, mat, { x = 0, y = 0, z = 0, sombra = true } = {}) {
  const m = new THREE.Mesh(geometria, mat);
  m.position.set(x, y, z);
  m.castShadow = sombra;
  m.receiveShadow = true;
  return m;
}

function caixa(w, h, d, cor, pos = {}) {
  const mat = typeof cor === 'string' ? material(cor) : cor;
  return malha(new THREE.BoxGeometry(w, h, d), mat, pos);
}

function cilindro(rTopo, rBase, h, cor, pos = {}, segmentos = 20) {
  const mat = typeof cor === 'string' ? material(cor) : cor;
  return malha(new THREE.CylinderGeometry(rTopo, rBase, h, segmentos), mat, pos);
}

function texturaDeCanvas(w, h, desenhar) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  desenhar(canvas.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Tábuas do piso: cada quadro da textura cobre 4×4 unidades da sala. */
function texturaTabuas() {
  const t = texturaDeCanvas(512, 512, (ctx, w, h) => {
    const tons = ['#4a3324', '#523826', '#45301f', '#583c29'];
    const largura = w / 8;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = tons[i % tons.length];
      ctx.fillRect(i * largura, 0, largura, h);
      // Emenda de tábua em altura diferente em cada faixa.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(i * largura, ((i * 197) % h), largura, 3);
      ctx.fillRect(i * largura, 0, 2, h);
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function quadro(desenhar, w, h) {
  const t = texturaDeCanvas(256, Math.round((256 * h) / w), desenhar);
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 }));
}

function planta(x, z, altura = 1.1) {
  const g = new THREE.Group();
  g.add(cilindro(0.34, 0.28, 0.55, '#c2410c', { y: 0.275 }));
  g.add(cilindro(0.3, 0.3, 0.04, '#3f2a1c', { y: 0.54 }));
  const verde = material('#3f9b4a');
  const tronco = malha(new THREE.CapsuleGeometry(0.17, altura * 0.6, 4, 10), verde, { y: 0.56 + altura * 0.45 });
  const bracoE = malha(new THREE.CapsuleGeometry(0.11, 0.3, 4, 8), verde, { x: -0.24, y: 0.56 + altura * 0.5 });
  const bracoD = malha(new THREE.CapsuleGeometry(0.1, 0.25, 4, 8), verde, { x: 0.22, y: 0.56 + altura * 0.7 });
  g.add(tronco, bracoE, bracoD);
  g.position.set(x, 0, z);
  return g;
}

// --- A sala ---------------------------------------------------------------

/** Piso, paredes e mobília fixa. Devolve as peças que mudam com o tempo. */
function montarSala(sala, mundo) {
  const W = sala.xMax - sala.xMin;
  const D = sala.zMax - sala.zMin;
  const cx = (sala.xMin + sala.xMax) / 2;
  const cz = (sala.zMin + sala.zMax) / 2;
  const ALTURA = 5.5;

  const tabuas = texturaTabuas();
  tabuas.repeat.set(W / 4, D / 4);
  mundo.add(caixa(W, 0.2, D, new THREE.MeshStandardMaterial({ map: tabuas, roughness: 0.9 }), { x: cx, y: -0.1, z: cz, sombra: false }));

  const fundo = sala.zMin - 0.15;
  const esquerda = sala.xMin - 0.15;
  mundo.add(caixa(W + 0.3, ALTURA, 0.3, PAREDE, { x: cx - 0.15, y: ALTURA / 2, z: fundo, sombra: false }));
  mundo.add(caixa(0.3, ALTURA, D, PAREDE, { x: esquerda, y: ALTURA / 2, z: cz, sombra: false }));
  mundo.add(caixa(W, 0.16, 0.06, '#120f0d', { x: cx, y: 0.08, z: sala.zMin + 0.03, sombra: false }));
  mundo.add(caixa(0.06, 0.16, D, '#120f0d', { x: sala.xMin + 0.03, y: 0.08, z: cz, sombra: false }));

  // Janelas na parede da esquerda: a única luz "de fora" da sala.
  const vidro = new THREE.MeshStandardMaterial({ color: '#9fb9d4', emissive: '#7f9fc4', emissiveIntensity: 0.55 });
  for (const z of [-5.6, -1.4]) {
    const j = new THREE.Group();
    j.add(caixa(0.08, 2.0, 2.6, '#0f0d0c', { sombra: false }));
    for (const [dy, dz] of [[-0.48, -0.63], [-0.48, 0.63], [0.48, -0.63], [0.48, 0.63]]) {
      j.add(caixa(0.03, 0.88, 1.18, vidro, { x: 0.04, y: dy, z: dz, sombra: false }));
    }
    j.position.set(sala.xMin + 0.04, 2.9, z);
    mundo.add(j);
  }

  // Quadros na parede do fundo, à esquerda da TV.
  const cartaz1 = quadro((ctx, w, h) => {
    ctx.fillStyle = '#efe6d6';
    ctx.fillRect(0, 0, w, h);
    const barras = [0.35, 0.6, 0.45, 0.8, 0.55];
    barras.forEach((v, i) => {
      ctx.fillStyle = Object.values(COR_PAPEL)[i];
      ctx.fillRect(34 + i * 40, h - 40 - v * (h - 110), 28, v * (h - 110));
    });
    ctx.fillStyle = '#292524';
    ctx.font = 'bold 22px system-ui';
    ctx.fillText('tokens/dia', 34, 44);
  }, 1.3, 1.7);
  cartaz1.position.set(-4.6, 3.0, sala.zMin + 0.02);
  const cartaz2 = quadro((ctx, w, h) => {
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fb923c';
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.42, w * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f5f5f4';
    ctx.font = 'bold 30px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('cache é', w / 2, h * 0.8);
    ctx.fillText('ouro', w / 2, h * 0.8 + 34);
  }, 1.1, 1.5);
  cartaz2.position.set(-2.7, 3.1, sala.zMin + 0.02);
  mundo.add(cartaz1, cartaz2);

  // TV com os números do dia. O canvas é redesenhado a cada mudança.
  const canvasTV = document.createElement('canvas');
  canvasTV.width = 768;
  canvasTV.height = 432;
  const texTV = new THREE.CanvasTexture(canvasTV);
  texTV.colorSpace = THREE.SRGBColorSpace;
  const tv = new THREE.Group();
  tv.add(caixa(3.3, 1.95, 0.12, '#0a0a0a', { sombra: false }));
  const tela = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 1.75), new THREE.MeshBasicMaterial({ map: texTV }));
  tela.position.z = 0.065;
  tv.add(tela);
  tv.position.set(1.2, 3.3, sala.zMin + 0.08);
  mundo.add(tv);

  // Letreiro com brilho: material sem luz, então ele "acende" sozinho.
  const letreiro = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 1.35),
    new THREE.MeshBasicMaterial({
      transparent: true,
      map: texturaDeCanvas(1024, 300, (ctx, w, h) => {
        ctx.fillStyle = '#0d0b0a';
        ctx.beginPath();
        ctx.roundRect(4, 4, w - 8, h - 8, 26);
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.shadowColor = '#fb923c';
        ctx.shadowBlur = 28;
        ctx.fillStyle = '#ffd7b0';
        ctx.font = '600 104px system-ui';
        ctx.fillText('token·monitor', w / 2, 158);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#a8a29e';
        ctx.font = '500 36px system-ui';
        ctx.fillText('E S C R I T Ó R I O   D E   A G E N T E S', w / 2, 236);
      }),
    }),
  );
  letreiro.position.set(6.9, 3.5, sala.zMin + 0.03);
  mundo.add(letreiro);

  // Relógio com a hora de verdade.
  const relogio = new THREE.Group();
  const face = cilindro(0.6, 0.6, 0.08, '#f5f5f4', {}, 40);
  face.rotation.x = Math.PI / 2;
  relogio.add(face);
  const aro = malha(new THREE.TorusGeometry(0.6, 0.05, 8, 40), material('#292524'));
  relogio.add(aro);
  const ponteiro = (comprimento, largura, cor) => {
    const pivo = new THREE.Group();
    pivo.add(caixa(largura, comprimento, 0.02, cor, { y: comprimento / 2 - 0.05, z: 0.06, sombra: false }));
    relogio.add(pivo);
    return pivo;
  };
  const ponteiros = {
    hora: ponteiro(0.32, 0.06, '#1c1917'),
    minuto: ponteiro(0.48, 0.04, '#1c1917'),
    segundo: ponteiro(0.52, 0.015, '#dc2626'),
  };
  relogio.position.set(10.6, 3.7, sala.zMin + 0.06);
  mundo.add(relogio);

  // Canto do café, no fundo à esquerda.
  const balcaoX = sala.xMin + 1.9;
  const balcaoZ = sala.zMin + 0.6;
  mundo.add(caixa(3.2, 1.0, 0.9, '#3f2d22', { x: balcaoX, y: 0.5, z: balcaoZ }));
  mundo.add(caixa(3.3, 0.06, 1.0, '#d6d3d1', { x: balcaoX, y: 1.03, z: balcaoZ }));
  mundo.add(caixa(0.6, 0.75, 0.5, '#1c1917', { x: balcaoX - 0.8, y: 1.43, z: balcaoZ - 0.05 }));
  mundo.add(malha(new THREE.SphereGeometry(0.04, 10, 8), new THREE.MeshBasicMaterial({ color: '#ef4444' }), { x: balcaoX - 0.62, y: 1.68, z: balcaoZ + 0.21, sombra: false }));
  for (const dx of [0.1, 0.4, 0.75]) {
    mundo.add(cilindro(0.08, 0.07, 0.16, '#fafaf9', { x: balcaoX + dx, y: 1.14, z: balcaoZ + 0.1 }));
  }
  const bebedouro = new THREE.Group();
  bebedouro.add(caixa(0.55, 1.0, 0.55, '#e7e5e4', { y: 0.5 }));
  bebedouro.add(cilindro(0.22, 0.24, 0.6, new THREE.MeshStandardMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.7, roughness: 0.2 }), { y: 1.3 }));
  bebedouro.position.set(sala.xMin + 4.1, 0, sala.zMin + 0.5);
  mundo.add(bebedouro);

  // Mesa redonda de reunião.
  mundo.add(cilindro(1.25, 1.25, 0.08, MADEIRA, { x: -6.8, y: 0.82, z: -1.4 }, 40));
  mundo.add(cilindro(0.12, 0.45, 0.8, MADEIRA_ESCURA, { x: -6.8, y: 0.4, z: -1.4 }));
  const papel = material('#f5f5f4');
  const folha1 = caixa(0.42, 0.01, 0.3, papel, { x: -7.1, y: 0.87, z: -1.6 });
  folha1.rotation.y = 0.4;
  const folha2 = caixa(0.42, 0.01, 0.3, papel, { x: -6.4, y: 0.87, z: -1.1 });
  folha2.rotation.y = -0.3;
  mundo.add(folha1, folha2);

  // Sala de estar na frente, à esquerda.
  const salaZ = sala.zMax - 3.2;
  mundo.add(caixa(4.6, 0.02, 4.4, '#5b4636', { x: sala.xMin + 3, y: 0.01, z: salaZ, sombra: false }));
  const tecido = material('#334a6b');
  const sofa = new THREE.Group();
  sofa.add(caixa(1.0, 0.42, 2.9, tecido, { x: 0.1, y: 0.3 }));
  sofa.add(caixa(0.32, 0.95, 2.9, tecido, { x: -0.42, y: 0.6 }));
  sofa.add(caixa(1.0, 0.62, 0.26, tecido, { x: 0.1, y: 0.4, z: -1.45 }));
  sofa.add(caixa(1.0, 0.62, 0.26, tecido, { x: 0.1, y: 0.4, z: 1.45 }));
  for (const dz of [-0.68, 0.68]) {
    sofa.add(malha(new RoundedBoxGeometry(0.75, 0.16, 1.3, 2, 0.06), material('#3d5a80'), { x: 0.15, y: 0.58, z: dz }));
  }
  sofa.position.set(sala.xMin + 0.75, 0, salaZ);
  mundo.add(sofa);
  mundo.add(caixa(1.0, 0.06, 1.5, MADEIRA, { x: sala.xMin + 2.9, y: 0.45, z: salaZ }));
  for (const [dx, dz] of [[-0.4, -0.6], [0.4, -0.6], [-0.4, 0.6], [0.4, 0.6]]) {
    mundo.add(caixa(0.06, 0.42, 0.06, MADEIRA_ESCURA, { x: sala.xMin + 2.9 + dx, y: 0.21, z: salaZ + dz }));
  }
  mundo.add(caixa(0.4, 0.01, 0.3, papel, { x: sala.xMin + 2.8, y: 0.485, z: salaZ - 0.2 }));
  mundo.add(cilindro(0.07, 0.06, 0.13, '#fafaf9', { x: sala.xMin + 3.1, y: 0.545, z: salaZ + 0.35 }));

  mundo.add(planta(sala.xMin + 0.6, sala.zMax - 0.6, 1.2));
  mundo.add(planta(sala.xMin + 0.6, -3.4, 0.9));
  mundo.add(planta(sala.xMax - 0.6, sala.zMin + 0.7, 1.3));

  return { canvasTV, texTV, ponteiros };
}

// --- Mesas ----------------------------------------------------------------

function montarMesa(cor, largura = 2.4) {
  const g = new THREE.Group();
  const tampo = caixa(largura, 0.1, 1.2, MADEIRA, { y: 0.78 });
  g.add(tampo);
  for (const lado of [-1, 1]) {
    g.add(caixa(0.08, 0.74, 1.1, MADEIRA_ESCURA, { x: lado * (largura / 2 - 0.08), y: 0.37 }));
  }
  g.add(caixa(largura - 0.2, 0.5, 0.05, MADEIRA_ESCURA, { y: 0.45, z: 0.5 }));

  // Monitor de lado, virado para quem senta: não esconde o rosto.
  const monitor = new THREE.Group();
  monitor.add(cilindro(0.04, 0.04, 0.3, GRAFITE, { y: 0.15 }));
  monitor.add(caixa(0.36, 0.02, 0.24, GRAFITE, { y: 0.01 }));
  monitor.add(caixa(0.95, 0.58, 0.05, '#111318', { y: 0.55 }));
  const matTela = new THREE.MeshStandardMaterial({ color: '#0b0f17', emissive: cor, emissiveIntensity: 0.05 });
  const tela = malha(new THREE.PlaneGeometry(0.88, 0.5), matTela, { y: 0.55, z: 0.03, sombra: false });
  monitor.add(tela);
  monitor.position.set(-largura / 2 + 0.55, 0.83, 0.2);
  monitor.rotation.y = Math.atan2(-monitor.position.x, ASSENTO.z - monitor.position.z);
  g.add(monitor);

  g.add(caixa(0.7, 0.03, 0.22, GRAFITE, { y: 0.845, z: -0.3 }));
  g.add(caixa(0.12, 0.03, 0.18, GRAFITE, { x: 0.5, y: 0.845, z: -0.3 }));
  g.add(cilindro(0.07, 0.06, 0.15, '#fafaf9', { x: largura / 2 - 0.45, y: 0.905, z: 0.3 }));
  g.add(caixa(0.4, 0.01, 0.3, material('#f5f5f4'), { x: -0.15, y: 0.835, z: 0.3 }));

  // Luminária: a cúpula é sem luz, só acesa.
  const lum = new THREE.Group();
  lum.add(cilindro(0.12, 0.14, 0.04, GRAFITE, { y: 0.02 }));
  const haste = caixa(0.03, 0.5, 0.03, GRAFITE, { y: 0.27 });
  haste.rotation.z = -0.25;
  lum.add(haste);
  const cupula = malha(new THREE.ConeGeometry(0.13, 0.16, 16, 1, true), new THREE.MeshBasicMaterial({ color: '#fde6b8', side: THREE.DoubleSide }), { x: -0.1, y: 0.52 });
  cupula.rotation.z = 0.5;
  lum.add(cupula);
  lum.position.set(largura / 2 - 0.25, 0.83, -0.15);
  g.add(lum);

  // Cadeira atrás do assento.
  const cadeira = new THREE.Group();
  cadeira.add(caixa(0.75, 0.08, 0.7, GRAFITE, { y: 0.5 }));
  cadeira.add(caixa(0.75, 0.85, 0.08, GRAFITE, { y: 0.95, z: -0.36 }));
  cadeira.add(cilindro(0.04, 0.04, 0.45, '#0f1115', { y: 0.24 }));
  cadeira.add(cilindro(0.3, 0.3, 0.04, '#0f1115', { y: 0.03 }));
  cadeira.position.set(0, 0, ASSENTO.z - 0.45);
  g.add(cadeira);

  return { grupo: g, matTela };
}

// --- Personagens ----------------------------------------------------------

// Medidas do corpo. Chapéu, rosto e membros saem daqui.
const CORPO = { largura: 1.05, altura: 0.9, fundo: 0.85, centro: 0.95 };
const TOPO = CORPO.centro + CORPO.altura / 2;
const FRENTE = CORPO.fundo / 2;
const MEIA = CORPO.largura / 2;
// Altura dos olhos: um pouco acima do meio, como no painel 2D.
const OLHOS_Y = 1.0;
// Balão e painel ficam acima da etiqueta, para nenhum cobrir o outro.
const ALTURA_BOLHAS = [2.6, 2.82, 3.12];

const tom = (cor, fator) => new THREE.Color(cor).multiplyScalar(fator).getStyle();
const clarear = (cor, t) => new THREE.Color(cor).lerp(new THREE.Color('#ffffff'), t).getStyle();

/**
 * Plástico macio de brinquedo: verniz por cima da cor dá o brilho de quina
 * que separa o personagem do fundo.
 */
function plastico(cor, extra = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: cor,
    roughness: 0.42,
    clearcoat: 0.7,
    clearcoatRoughness: 0.3,
    ...extra,
  });
}

/**
 * Pinta a geometria por altura, do tom escuro embaixo ao claro em cima — é o
 * mesmo degradê do corpo no SVG, agora no vértice.
 */
function degrade(geometria, corBaixo, corCima) {
  const pos = geometria.attributes.position;
  geometria.computeBoundingBox();
  const { min, max } = geometria.boundingBox;
  const a = new THREE.Color(corBaixo);
  const b = new THREE.Color(corCima);
  const c = new THREE.Color();
  const cores = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - min.y) / (max.y - min.y || 1);
    c.copy(a).lerp(b, Math.pow(t, 0.8));
    cores.set([c.r, c.g, c.b], i * 3);
  }
  geometria.setAttribute('color', new THREE.BufferAttribute(cores, 3));
  return geometria;
}

/** Acessório de cabeça por papel: é o que distingue dois personagens além da cor. */
function montarChapeu(chapeu, cor) {
  const g = new THREE.Group();
  const escuro = tom(cor, 0.5);
  const tecido = (c) => plastico(c, { roughness: 0.7, clearcoat: 0.15 });
  const metal = plastico(GRAFITE, { roughness: 0.35, metalness: 0.4 });

  // Faixa que dá a volta na cabeça: frente, laterais e fundo, rente ao corpo.
  const faixa = (mat, altura, y) => {
    const r = 0.03;
    g.add(malha(new RoundedBoxGeometry(CORPO.largura + 0.04, altura, 0.05, 2, r), mat, { y, z: FRENTE }));
    g.add(malha(new RoundedBoxGeometry(CORPO.largura + 0.04, altura, 0.05, 2, r), mat, { y, z: -FRENTE }));
    for (const lado of [-1, 1]) {
      g.add(malha(new RoundedBoxGeometry(0.05, altura, CORPO.fundo + 0.04, 2, r), mat, { x: lado * MEIA, y }));
    }
  };

  switch (chapeu) {
    case 'headset': {
      const arco = malha(new THREE.TorusGeometry(MEIA + 0.06, 0.045, 10, 32, Math.PI), metal);
      arco.position.y = OLHOS_Y + 0.02;
      g.add(arco);
      for (const lado of [-1, 1]) {
        const concha = malha(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 24), metal, { x: lado * (MEIA + 0.06), y: OLHOS_Y });
        concha.rotation.z = Math.PI / 2;
        const almofada = malha(new THREE.TorusGeometry(0.12, 0.05, 8, 20), plastico(cor, { roughness: 0.8 }), { x: lado * (MEIA + 0.13), y: OLHOS_Y });
        almofada.rotation.y = Math.PI / 2;
        g.add(concha, almofada);
      }
      const haste = malha(new THREE.CapsuleGeometry(0.022, 0.42, 4, 8), metal, { x: -MEIA - 0.02, y: OLHOS_Y - 0.2, z: 0.24 });
      haste.rotation.x = Math.PI / 2 - 0.5;
      g.add(haste);
      g.add(malha(new THREE.SphereGeometry(0.06, 14, 10), plastico('#111'), { x: -MEIA + 0.02, y: OLHOS_Y - 0.32, z: FRENTE + 0.04 }));
      break;
    }
    case 'beret': {
      const boina = malha(new THREE.SphereGeometry(0.5, 28, 14), tecido(escuro), { x: 0.08, y: TOPO + 0.02 });
      boina.scale.set(1, 0.28, 1);
      boina.rotation.z = 0.18;
      g.add(boina, malha(new THREE.CapsuleGeometry(0.03, 0.06, 4, 8), tecido(escuro), { x: 0.05, y: TOPO + 0.17 }));
      break;
    }
    case 'cap': {
      const copa = malha(new THREE.SphereGeometry(0.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), tecido(escuro), { y: TOPO - 0.04 });
      copa.scale.y = 0.55;
      const aba = malha(new THREE.CylinderGeometry(0.34, 0.34, 0.035, 28, 1, false, -Math.PI / 2, Math.PI), tecido(escuro), { y: TOPO - 0.02, z: 0.28 });
      aba.scale.z = 0.85;
      g.add(copa, aba, malha(new THREE.SphereGeometry(0.05, 12, 8), tecido(cor), { y: TOPO + 0.24 }));
      break;
    }
    case 'helmet': {
      const amarelo = plastico('#facc15', { roughness: 0.3, clearcoat: 1 });
      const casco = malha(new THREE.SphereGeometry(0.62, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), amarelo, { y: TOPO - 0.12 });
      casco.scale.y = 0.62;
      const aba = malha(new THREE.TorusGeometry(0.6, 0.04, 8, 36), amarelo, { y: TOPO - 0.12 });
      aba.rotation.x = Math.PI / 2;
      const crista = malha(new RoundedBoxGeometry(0.12, 0.12, 1.0, 2, 0.05), plastico('#eab308', { clearcoat: 1 }), { y: TOPO + 0.2 });
      g.add(casco, aba, crista);
      break;
    }
    case 'headlamp': {
      faixa(plastico(GRAFITE, { roughness: 0.8 }), 0.1, TOPO - 0.13);
      const lampada = malha(new THREE.CylinderGeometry(0.12, 0.1, 0.12, 24), metal, { y: TOPO - 0.13, z: FRENTE + 0.08 });
      lampada.rotation.x = Math.PI / 2;
      const luz = malha(new THREE.CircleGeometry(0.09, 24), new THREE.MeshBasicMaterial({ color: '#fef9c3', toneMapped: false }), { y: TOPO - 0.13, z: FRENTE + 0.145, sombra: false });
      g.add(lampada, luz);
      break;
    }
    case 'visor': {
      // Viseira translúcida por cima do rosto, de orelha a orelha.
      const vidro = new THREE.MeshPhysicalMaterial({ color: '#67e8f9', emissive: '#22d3ee', emissiveIntensity: 0.35, transparent: true, opacity: 0.45, roughness: 0.05, clearcoat: 1 });
      g.add(malha(new RoundedBoxGeometry(CORPO.largura + 0.06, 0.26, 0.08, 3, 0.04), vidro, { y: OLHOS_Y + 0.02, z: FRENTE + 0.06, sombra: false }));
      for (const lado of [-1, 1]) {
        g.add(malha(new THREE.SphereGeometry(0.07, 14, 10), metal, { x: lado * (MEIA + 0.04), y: OLHOS_Y + 0.02, z: FRENTE - 0.05 }));
      }
      break;
    }
    case 'band': {
      faixa(tecido('#f5f5f4'), 0.11, TOPO - 0.14);
      g.add(malha(new RoundedBoxGeometry(0.3, 0.06, 0.06, 2, 0.02), tecido(cor), { y: TOPO - 0.14, z: FRENTE + 0.03 }));
      for (const [dx, rz] of [[0.1, 0.5], [0.22, 0.9]]) {
        const ponta = malha(new RoundedBoxGeometry(0.07, 0.3, 0.04, 2, 0.02), tecido('#f5f5f4'), { x: dx, y: TOPO - 0.3, z: -FRENTE - 0.03 });
        ponta.rotation.z = rz;
        g.add(ponta);
      }
      break;
    }
    case 'glasses': {
      const aro = plastico('#18181b', { roughness: 0.3 });
      const lente = new THREE.MeshPhysicalMaterial({ color: '#ffffff', transparent: true, opacity: 0.12, roughness: 0, clearcoat: 1 });
      for (const lado of [-1, 1]) {
        g.add(malha(new THREE.TorusGeometry(0.15, 0.03, 10, 28), aro, { x: lado * 0.21, y: OLHOS_Y, z: FRENTE + 0.08, sombra: false }));
        g.add(malha(new THREE.CircleGeometry(0.14, 24), lente, { x: lado * 0.21, y: OLHOS_Y, z: FRENTE + 0.08, sombra: false }));
      }
      g.add(malha(new THREE.CapsuleGeometry(0.02, 0.1, 4, 8), aro, { y: OLHOS_Y + 0.04, z: FRENTE + 0.08, sombra: false }).rotateZ(Math.PI / 2));
      break;
    }
    case 'explorer': {
      const palha = plastico('#ca8a04', { roughness: 0.8, clearcoat: 0.1 });
      const aba = malha(new THREE.CylinderGeometry(0.74, 0.78, 0.05, 40), plastico('#a16207', { roughness: 0.8, clearcoat: 0.1 }), { y: TOPO + 0.03 });
      const copa = malha(new THREE.CapsuleGeometry(0.38, 0.12, 6, 24), palha, { y: TOPO + 0.2 });
      copa.scale.y = 0.75;
      g.add(aba, copa, malha(new THREE.CylinderGeometry(0.405, 0.405, 0.07, 32), tecido(escuro), { y: TOPO + 0.1 }));
      break;
    }
    default:
      break;
  }
  return g;
}

// --- Rostos ---------------------------------------------------------------

/**
 * O rosto é uma tela escura no corpo, e os olhos são desenhados nela, acesos.
 * Cada estado tem a sua expressão; trocar de estado troca só a textura.
 */
const EXPRESSAO_DO_ESTADO = {
  parado: 'normal',
  pensando: 'pensando',
  trabalhando: 'focado',
  concluido: 'feliz',
  erro: 'erro',
};

const rostos = new Map();

function texturaRosto(cor, expressao) {
  const chave = `${cor}|${expressao}`;
  if (rostos.has(chave)) return rostos.get(chave);

  const brilho = expressao === 'erro' ? '#fca5a5' : clarear(cor, 0.55);
  const t = texturaDeCanvas(256, 152, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = brilho;
    ctx.strokeStyle = brilho;
    ctx.shadowColor = brilho;
    ctx.shadowBlur = 18;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 13;
    const cx = w / 2;
    const cy = h / 2;
    const olho = (x, y, largura, altura) => {
      ctx.beginPath();
      ctx.roundRect(x - largura / 2, y - altura / 2, largura, altura, Math.min(largura, altura) / 2);
      ctx.fill();
    };
    for (const lado of [-1, 1]) {
      const x = cx + lado * 50;
      switch (expressao) {
        case 'piscando':
          olho(x, cy + 6, 40, 9);
          break;
        case 'pensando':
          // Olhando para cima e para o lado, como quem procura a resposta.
          olho(x + 12, cy - 16, 30, 42);
          break;
        case 'focado':
          // Olhos baixos, no teclado.
          olho(x, cy + 14, 42, 20);
          break;
        case 'feliz':
          ctx.beginPath();
          ctx.arc(x, cy + 14, 20, Math.PI * 1.1, Math.PI * 1.9);
          ctx.stroke();
          break;
        case 'erro':
          ctx.beginPath();
          ctx.moveTo(x - 15, cy - 15);
          ctx.lineTo(x + 15, cy + 15);
          ctx.moveTo(x + 15, cy - 15);
          ctx.lineTo(x - 15, cy + 15);
          ctx.stroke();
          break;
        default:
          olho(x, cy, 34, 54);
      }
    }
    // Bochechas: dão o ar de brinquedo sem precisar de boca.
    if (expressao === 'feliz' || expressao === 'normal') {
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#fb7185';
      for (const lado of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + lado * 96, cy + 38, 16, 9, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  });
  rostos.set(chave, t);
  return t;
}

// --- Objetos de mesa ------------------------------------------------------

/**
 * O que cada papel segura no painel 2D fica na mesa aqui: as mãos estão
 * ocupadas com o teclado.
 */
function montarObjeto(objeto, cor) {
  const g = new THREE.Group();
  const escuro = plastico('#16181d', { roughness: 0.5 });
  const aceso = (c) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });

  switch (objeto) {
    case 'card': {
      // Tablet num suporte, com a lista de tarefas acesa.
      const tablet = new THREE.Group();
      tablet.add(malha(new RoundedBoxGeometry(0.34, 0.26, 0.025, 2, 0.02), escuro));
      for (let i = 0; i < 3; i++) {
        tablet.add(malha(new THREE.PlaneGeometry(0.2 - i * 0.04, 0.03), aceso(i ? '#e7e5e4' : cor), { x: -0.04 + i * 0.02, y: 0.07 - i * 0.06, z: 0.014, sombra: false }));
      }
      tablet.position.y = 0.14;
      tablet.rotation.x = -0.35;
      g.add(tablet);
      break;
    }
    case 'picture': {
      // Cavalete com um quadro de formas coloridas.
      const quadroArte = new THREE.Group();
      quadroArte.add(malha(new RoundedBoxGeometry(0.32, 0.26, 0.03, 2, 0.01), plastico('#f5f5f4', { roughness: 0.8 })));
      const formas = [['#60a5fa', -0.07, 0.03, 0.06], [cor, 0.06, -0.02, 0.08], ['#facc15', 0.08, 0.07, 0.04]];
      for (const [c, x, y, r] of formas) {
        quadroArte.add(malha(new THREE.CircleGeometry(r, 20), plastico(c), { x, y, z: 0.017, sombra: false }));
      }
      quadroArte.position.y = 0.2;
      quadroArte.rotation.x = -0.2;
      g.add(quadroArte);
      for (const lado of [-1, 1]) {
        const perna = malha(new THREE.CapsuleGeometry(0.012, 0.3, 4, 6), plastico(MADEIRA_ESCURA), { x: lado * 0.11, y: 0.15, z: -0.03 });
        perna.rotation.z = lado * -0.15;
        g.add(perna);
      }
      break;
    }
    case 'screen': {
      // Segundo monitor, pequeno, com código.
      const tela = new THREE.Group();
      tela.add(malha(new RoundedBoxGeometry(0.42, 0.28, 0.03, 2, 0.015), escuro));
      const codigo = CODIGO.clone();
      codigo.needsUpdate = true;
      codigo.repeat.set(1, 0.5);
      tela.add(malha(new THREE.PlaneGeometry(0.38, 0.24), new THREE.MeshBasicMaterial({ map: codigo, color: cor, toneMapped: false }), { z: 0.017, sombra: false }));
      tela.position.y = 0.26;
      tela.rotation.x = -0.15;
      g.add(tela, malha(new THREE.CylinderGeometry(0.015, 0.015, 0.12, 8), escuro, { y: 0.07 }), malha(new THREE.CylinderGeometry(0.08, 0.08, 0.015, 16), escuro, { y: 0.01 }));
      break;
    }
    case 'rack': {
      // Mini servidor com luzes piscando.
      g.add(malha(new RoundedBoxGeometry(0.26, 0.36, 0.24, 2, 0.03), escuro, { y: 0.18 }));
      for (let i = 0; i < 3; i++) {
        g.add(malha(new THREE.PlaneGeometry(0.16, 0.025), aceso(i === 1 ? '#facc15' : cor), { x: -0.02, y: 0.08 + i * 0.1, z: 0.121, sombra: false }));
        g.add(malha(new THREE.CircleGeometry(0.014, 10), aceso('#ef4444'), { x: 0.09, y: 0.08 + i * 0.1, z: 0.121, sombra: false }));
      }
      break;
    }
    case 'pipeline': {
      // Esteira com três pacotes passando.
      g.add(malha(new RoundedBoxGeometry(0.46, 0.04, 0.14, 2, 0.015), escuro, { y: 0.02 }));
      [cor, '#e7e5e4', '#facc15'].forEach((c, i) => {
        g.add(malha(new RoundedBoxGeometry(0.1, 0.1, 0.1, 2, 0.02), plastico(c), { x: -0.15 + i * 0.15, y: 0.09 }));
      });
      break;
    }
    case 'chart': {
      // Gráfico de barras de mesa.
      g.add(malha(new RoundedBoxGeometry(0.4, 0.03, 0.16, 2, 0.01), escuro, { y: 0.015 }));
      [0.12, 0.22, 0.16, 0.3].forEach((h, i) => {
        g.add(malha(new RoundedBoxGeometry(0.07, h, 0.07, 2, 0.015), plastico(i === 3 ? cor : clarear(cor, 0.5)), { x: -0.13 + i * 0.087, y: 0.03 + h / 2 }));
      });
      break;
    }
    case 'checklist': {
      // Prancheta com três itens marcados.
      const prancheta = new THREE.Group();
      prancheta.add(malha(new RoundedBoxGeometry(0.26, 0.34, 0.02, 2, 0.015), plastico(MADEIRA, { roughness: 0.7 })));
      prancheta.add(malha(new THREE.PlaneGeometry(0.22, 0.28), plastico('#fafaf9', { roughness: 0.9 }), { y: -0.01, z: 0.012, sombra: false }));
      prancheta.add(malha(new RoundedBoxGeometry(0.1, 0.04, 0.03, 2, 0.01), metal(), { y: 0.16, z: 0.01 }));
      for (let i = 0; i < 3; i++) {
        prancheta.add(malha(new THREE.PlaneGeometry(0.04, 0.04), plastico(cor), { x: -0.07, y: 0.07 - i * 0.08, z: 0.014, sombra: false }));
        prancheta.add(malha(new THREE.PlaneGeometry(0.1, 0.015), plastico('#a8a29e'), { x: 0.03, y: 0.07 - i * 0.08, z: 0.014, sombra: false }));
      }
      prancheta.position.y = 0.05;
      prancheta.rotation.x = -Math.PI / 2 + 0.25;
      g.add(prancheta);
      break;
    }
    case 'lens': {
      // Lupa deitada na mesa.
      const lupa = new THREE.Group();
      lupa.add(malha(new THREE.TorusGeometry(0.1, 0.022, 10, 28), metal()));
      lupa.add(malha(new THREE.CircleGeometry(0.095, 24), new THREE.MeshPhysicalMaterial({ color: '#bae6fd', transparent: true, opacity: 0.35, roughness: 0, clearcoat: 1 })));
      const cabo = malha(new THREE.CapsuleGeometry(0.025, 0.16, 4, 8), plastico(cor), { x: 0.17, y: -0.17 });
      cabo.rotation.z = Math.PI / 4;
      lupa.add(cabo);
      lupa.rotation.x = -Math.PI / 2;
      lupa.position.y = 0.03;
      g.add(lupa);
      break;
    }
    case 'book': {
      // Livro aberto, as duas metades em V.
      for (const lado of [-1, 1]) {
        const metade = new THREE.Group();
        metade.add(malha(new RoundedBoxGeometry(0.18, 0.025, 0.24, 2, 0.008), plastico(cor), {}));
        metade.add(malha(new THREE.BoxGeometry(0.16, 0.012, 0.22), plastico('#fafaf9', { roughness: 0.9 }), { y: 0.016 }));
        metade.children.forEach((m) => (m.position.x = lado * 0.09));
        metade.rotation.z = lado * -0.18;
        metade.position.y = 0.04;
        g.add(metade);
      }
      break;
    }
    default: {
      // Faísca: o genérico só tem a ideia, flutuando.
      const faisca = malha(new THREE.OctahedronGeometry(0.08), aceso(clarear(cor, 0.3)), { y: 0.2, sombra: false });
      faisca.userData.gira = true;
      g.add(faisca);
    }
  }
  return g;

  function metal() {
    return plastico('#9ca3af', { roughness: 0.3, metalness: 0.6 });
  }
}

/** Sombra de contato: uma mancha suave embaixo de quem anda. */
const SOMBRA_CONTATO = texturaDeCanvas(128, 128, (ctx) => {
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
});

/** Linhas de código que sobem no painel holográfico de quem trabalha. */
const CODIGO = texturaDeCanvas(256, 256, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  let y = 10;
  let semente = 7;
  const aleatorio = () => {
    semente = (semente * 9301 + 49297) % 233280;
    return semente / 233280;
  };
  while (y < h - 8) {
    const recuo = Math.floor(aleatorio() * 4) * 18;
    ctx.fillStyle = `rgba(255,255,255,${0.55 + aleatorio() * 0.45})`;
    ctx.fillRect(14 + recuo, y, 40 + aleatorio() * 150, 7);
    y += 16;
  }
});
CODIGO.wrapT = THREE.RepeatWrapping;

const ROTULO_ESTADO = {
  parado: 'parado',
  pensando: 'pensando…',
  trabalhando: 'trabalhando',
  concluido: 'concluiu',
  erro: 'erro',
};

class Personagem {
  constructor(agente, mesa, mundo, pontoDaMesa) {
    this.agente = agente.agent;
    this.papel = agente.role;
    this.cor = COR_PAPEL[agente.role] ?? COR_PAPEL.generico;
    this.mesa = mesa;
    this.fase = Math.random() * Math.PI * 2;
    this.estado = 'parado';
    this.desde = performance.now() / 1000;
    this.burst = null;
    this.modo = 'sentado';
    this.rota = [];
    this.alvo = 0;
    this.proximaPausa = this.desde + 20 + Math.random() * 70;
    this.piscarEm = this.desde + 2 + Math.random() * 4;

    // Ponto de onde ele sai e para onde volta.
    this.assento = pontoDaMesa.clone().add(ASSENTO);
    this.saida = mesa.saida;

    this.raiz = new THREE.Group();
    this.raiz.position.copy(this.assento);
    this.raiz.scale.setScalar(1.25);
    this.corpo = new THREE.Group();
    this.raiz.add(this.corpo);

    const cor = this.cor;

    // Corpo: bloco bem arredondado, com degradê do tom escuro embaixo ao claro
    // em cima, e verniz por cima.
    this.matCorpo = plastico('#ffffff', { vertexColors: true, emissive: '#000000' });
    const geoCorpo = degrade(
      new RoundedBoxGeometry(CORPO.largura, CORPO.altura, CORPO.fundo, 6, 0.24),
      tom(cor, 0.68),
      clarear(cor, 0.04),
    );
    this.corpo.add(malha(geoCorpo, this.matCorpo, { y: CORPO.centro }));

    // Rosto: tela escura e brilhante embutida na frente, com os olhos acesos.
    const tela = malha(
      new RoundedBoxGeometry(0.8, 0.5, 0.06, 4, 0.1),
      plastico('#12151c', { roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 }),
      { y: OLHOS_Y, z: FRENTE - 0.01, sombra: false },
    );
    this.matRosto = new THREE.MeshBasicMaterial({ map: texturaRosto(cor, 'normal'), transparent: true, toneMapped: false, depthWrite: false });
    const rosto = malha(new THREE.PlaneGeometry(0.74, 0.44), this.matRosto, { y: OLHOS_Y, z: FRENTE + 0.025, sombra: false });
    this.corpo.add(tela, rosto);
    this.expressao = 'normal';

    // Pernas e braços em cápsula, com pé e mão redondos no tom do corpo.
    const membro = plastico(tom(cor, 0.72), { roughness: 0.5 });
    const ponta = plastico(clarear(cor, 0.1), { roughness: 0.45 });
    this.pernas = [[-0.3, 0.22], [0.3, 0.22], [-0.3, -0.22], [0.3, -0.22]].map(([x, z]) => {
      const pivo = new THREE.Group();
      pivo.position.set(x, 0.52, z);
      pivo.add(malha(new THREE.CapsuleGeometry(0.085, 0.3, 6, 12), membro, { y: -0.22 }));
      const pe = malha(new THREE.SphereGeometry(0.11, 16, 10), ponta, { y: -0.43, z: 0.03 });
      pe.scale.set(1, 0.6, 1.25);
      pivo.add(pe);
      this.corpo.add(pivo);
      return pivo;
    });

    this.bracos = [-1, 1].map((lado) => {
      const pivo = new THREE.Group();
      pivo.position.set(lado * (MEIA + 0.04), 0.98, 0.06);
      const braco = malha(new THREE.CapsuleGeometry(0.075, 0.24, 6, 12), membro, { y: -0.16 });
      pivo.add(braco, malha(new THREE.SphereGeometry(0.1, 16, 12), ponta, { y: -0.34 }));
      this.corpo.add(pivo);
      return pivo;
    });

    // Antena com a bolinha acesa: brilha mais quando ele está ativo.
    this.antena = new THREE.Group();
    this.antena.position.set(0.24, TOPO - 0.04, -0.18);
    this.antena.add(malha(new THREE.CapsuleGeometry(0.022, 0.26, 4, 8), membro, { y: 0.15 }));
    this.matAntena = new THREE.MeshStandardMaterial({ color: clarear(cor, 0.35), emissive: cor, emissiveIntensity: 0.4, roughness: 0.3 });
    this.antena.add(malha(new THREE.SphereGeometry(0.075, 16, 12), this.matAntena, { y: 0.33 }));
    this.corpo.add(this.antena);

    this.corpo.add(montarChapeu(agente.hat, cor));

    // Sombra de contato, sempre no chão, que acompanha quem anda.
    const sombra = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 1.1),
      new THREE.MeshBasicMaterial({ map: SOMBRA_CONTATO, transparent: true, depthWrite: false }),
    );
    sombra.rotation.x = -Math.PI / 2;
    sombra.position.y = 0.015;
    this.raiz.add(sombra);

    // O objeto do papel, na mesa, ao lado do teclado.
    this.objeto = montarObjeto(agente.prop, cor);
    this.objeto.position.copy(this.assento).add(new THREE.Vector3(0.32, 0.83, 1.33));
    this.objeto.rotation.y = -0.35;
    this.objeto.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    mundo.add(this.objeto);

    // Balão de pensamento: três bolinhas subindo.
    this.balao = new THREE.Group();
    const nuvem = new THREE.MeshStandardMaterial({ color: '#f5f5f4', roughness: 0.4 });
    this.bolhas = [[-0.25, 0.06], [0, 0.09], [0.3, 0.15]].map(([x, r], i) => {
      const b = malha(new THREE.SphereGeometry(r, 14, 10), nuvem, { x, y: ALTURA_BOLHAS[i], z: 0.2, sombra: false });
      this.balao.add(b);
      return b;
    });
    this.balao.visible = false;
    this.raiz.add(this.balao);


    // Painel holográfico atrás de quem trabalha, sempre virado para a câmera.
    const codigo = CODIGO.clone();
    codigo.needsUpdate = true;
    this.painel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, 0.72),
      new THREE.MeshBasicMaterial({ map: codigo, color: cor, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.painel.position.copy(this.assento).add(new THREE.Vector3(0, 3.65, -0.3));
    this.painel.visible = false;
    mundo.add(this.painel);

    // Faíscas de token: cubinhos que sobem do teclado.
    const faisca = new THREE.MeshBasicMaterial({ color: cor });
    this.faiscas = Array.from({ length: 6 }, (_, i) => {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), faisca);
      f.visible = false;
      f.userData.vida = i / 6;
      mundo.add(f);
      return f;
    });

    this.el = document.createElement('div');
    this.el.className = 'etiqueta';
    this.el.style.setProperty('--papel', cor);
    const ponto = document.createElement('span');
    ponto.className = 'ponto';
    this.elNome = document.createElement('b');
    this.elNome.textContent = agente.displayName ?? agente.agent;
    this.elEstado = document.createElement('span');
    this.elEstado.className = 'estado';
    this.el.append(ponto, this.elNome, this.elEstado);
    // Etiqueta logo acima da cabeça; balão e painel ficam acima dela.
    this.etiqueta = new CSS2DObject(this.el);
    this.etiqueta.position.set(0, 1.85, 0);
    this.etiqueta.center.set(0.5, 1);
    this.raiz.add(this.etiqueta);

    this.raiz.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    mundo.add(this.raiz);

    this.aplicar(agente.live ?? { state: 'parado' });
    this.uso(agente.usage);
  }

  /** Estado vindo do servidor (stage ou stream). */
  aplicar(live) {
    const estado = ROTULO_ESTADO[live.state] ? live.state : 'parado';
    if (estado !== this.estado) {
      this.estado = estado;
      this.desde = performance.now() / 1000;
    }
    this.burst = live.burst ?? null;
    // Chamado pelo modelo no meio do café: volta para a mesa.
    if (estado !== 'parado' && this.modo !== 'sentado' && !this.voltando) this.voltar();
    this.rotular();
  }

  uso(usage) {
    if (!usage) return;
    this.el.title = `hoje: ${tk(usage.totalTokens)} tokens em ${BRint.format(usage.requests)} chamadas`;
  }

  rotular() {
    let texto = ROTULO_ESTADO[this.estado];
    if (this.modo === 'pausa') texto = 'pausa para o café';
    else if (this.modo === 'andando') texto = this.voltando ? 'voltando para a mesa' : 'indo tomar café';
    else if ((this.estado === 'trabalhando' || this.estado === 'concluido') && this.burst?.totalTokens) {
      texto += ` · ${tk(this.burst.totalTokens)}`;
    }
    this.elEstado.textContent = texto;
    this.el.dataset.estado = this.modo === 'sentado' ? this.estado : 'parado';
  }

  livreParaPausa() {
    return this.estado === 'parado' && this.modo === 'sentado' && !reduzirMovimento;
  }

  irAoCafe(vaga) {
    this.vaga = vaga;
    vaga.ocupada = true;
    this.rota = [this.assento.clone(), ...this.saida, vaga.ponto.clone()];
    this.alvo = 1;
    this.modo = 'andando';
    this.voltando = false;
    this.rotular();
  }

  voltar() {
    // Refaz o caminho andado, do ponto em que está até o assento.
    const feitos = this.rota.slice(0, this.alvo).reverse();
    this.rota = [this.raiz.position.clone(), ...feitos];
    this.alvo = 1;
    this.modo = 'andando';
    this.voltando = true;
    this.rotular();
  }

  atualizar(dt, t, camera) {
    const desde = t - this.desde;
    const corpo = this.corpo;
    corpo.position.set(0, 0, 0);
    corpo.rotation.set(0, 0, 0);
    corpo.scale.set(1, 1, 1);
    // Sentado, os braços descansam na mesa em vez de pender ao lado do corpo.
    const repouso = this.modo === 'sentado' ? -1.0 : 0;
    for (const b of this.bracos) b.rotation.set(repouso, 0, 0);
    for (const p of this.pernas) p.rotation.set(0, 0, 0);
    this.antena.rotation.set(0, 0, 0);
    this.matCorpo.emissive.set('#000000');

    const ativo = this.modo === 'sentado';
    this.balao.visible = ativo && this.estado === 'pensando';
    this.painel.visible = ativo && this.estado === 'trabalhando';
    this.mesa.matTela.emissiveIntensity = ativo && this.estado === 'trabalhando' ? 0.9 : 0.05;

    // Expressão do estado; fora da mesa, cara de café. Pisca de tempos em
    // tempos, menos quando os olhos já são um traço.
    let expressao = ativo ? EXPRESSAO_DO_ESTADO[this.estado] : this.modo === 'pausa' ? 'feliz' : 'normal';
    if (t > this.piscarEm) {
      const fechado = t - this.piscarEm < 0.13;
      if (fechado && (expressao === 'normal' || expressao === 'pensando' || expressao === 'focado')) expressao = 'piscando';
      if (!fechado) this.piscarEm = t + 2.5 + Math.random() * 4;
    }
    if (expressao !== this.expressao) {
      this.expressao = expressao;
      this.matRosto.map = texturaRosto(this.cor, expressao);
    }

    const aceso = ativo && (this.estado === 'pensando' || this.estado === 'trabalhando');
    this.matAntena.emissiveIntensity = aceso ? 1.2 + Math.sin(t * 8) * 0.5 : 0.4;
    for (const o of this.objeto.children) {
      if (o.userData.gira) o.rotation.y = t * 1.5;
    }

    if (this.modo === 'andando') return this.andar(dt, t);
    if (this.modo === 'pausa') {
      if (!reduzirMovimento) corpo.position.y = Math.sin(t * 2 + this.fase) * 0.02;
      if (t > this.fimPausa) this.voltar();
      return;
    }

    if (this.painel.visible) this.painel.quaternion.copy(camera.quaternion);
    if (reduzirMovimento) return;

    switch (this.estado) {
      case 'pensando': {
        corpo.position.y = Math.sin(t * 2.2 + this.fase) * 0.03;
        corpo.rotation.z = Math.sin(t * 1.4) * 0.06;
        this.antena.rotation.z = Math.sin(t * 3) * 0.35;
        this.bolhas.forEach((b, i) => {
          b.position.y = ALTURA_BOLHAS[i] + Math.max(0, Math.sin(t * 4 - i * 0.9)) * 0.08;
        });
        break;
      }
      case 'trabalhando': {
        corpo.position.y = Math.abs(Math.sin(t * 9 + this.fase)) * 0.035;
        this.bracos.forEach((b, i) => {
          b.rotation.x = -0.9 + Math.sin(t * 18 + i * Math.PI) * 0.35;
        });
        this.antena.rotation.x = Math.sin(t * 6) * 0.15;
        this.painel.material.map.offset.y -= dt * 0.35;
        this.faiscar(dt);
        break;
      }
      case 'concluido': {
        if (desde < 0.7) corpo.position.y = Math.sin((desde / 0.7) * Math.PI) * 0.55;
        if (desde < 0.7) this.bracos.forEach((b, i) => b.rotation.set(0, 0, (i ? 1 : -1) * 2.4));
        break;
      }
      case 'erro': {
        if (desde < 0.8) corpo.position.x = Math.sin(desde * 60) * 0.07 * (1 - desde / 0.8);
        this.matCorpo.emissive.set('#dc2626');
        this.matCorpo.emissiveIntensity = 0.25 + 0.2 * Math.sin(t * 6);
        break;
      }
      default: {
        // Parado: só respira.
        corpo.scale.y = 1 + Math.sin(t * 2 + this.fase) * 0.015;
        corpo.position.y = Math.sin(t * 2 + this.fase) * 0.01;
      }
    }
    if (this.estado !== 'trabalhando') for (const f of this.faiscas) f.visible = false;
  }

  faiscar(dt) {
    for (const f of this.faiscas) {
      f.userData.vida = (f.userData.vida + dt / 1.3) % 1;
      const v = f.userData.vida;
      if (v < dt / 1.3) f.userData.dx = (Math.random() - 0.5) * 0.7;
      f.visible = true;
      f.position.copy(this.assento).add(new THREE.Vector3(f.userData.dx ?? 0, 0.95 + v * 1.4, 0.75));
      f.rotation.set(v * 6, v * 4, 0);
      f.scale.setScalar(1 - v * 0.8);
    }
  }

  andar(dt, t) {
    const velocidade = this.voltando ? 2.6 : 1.7;
    const alvo = this.rota[this.alvo];
    const pos = this.raiz.position;
    const falta = alvo.clone().sub(pos);
    falta.y = 0;
    const d = falta.length();
    const passo = velocidade * dt;

    if (d > 0.001) {
      const direcao = Math.atan2(falta.x, falta.z);
      this.raiz.rotation.y = girarPara(this.raiz.rotation.y, direcao, dt * 10);
    }
    if (d <= passo) {
      pos.copy(alvo);
      this.alvo += 1;
      if (this.alvo >= this.rota.length) return this.chegou(t);
    } else {
      pos.addScaledVector(falta.normalize(), passo);
    }

    const ciclo = t * 11;
    this.pernas.forEach((p, i) => {
      p.rotation.x = Math.sin(ciclo + (i % 2 === (i < 2 ? 0 : 1) ? 0 : Math.PI)) * 0.5;
    });
    this.bracos.forEach((b, i) => {
      b.rotation.x = Math.sin(ciclo + i * Math.PI) * 0.4;
    });
    this.corpo.position.y = Math.abs(Math.sin(ciclo)) * 0.06;
    this.corpo.rotation.z = Math.sin(ciclo) * 0.05;
  }

  chegou(t) {
    if (this.voltando) {
      this.modo = 'sentado';
      this.voltando = false;
      this.raiz.rotation.y = 0;
      if (this.vaga) this.vaga.ocupada = false;
      this.vaga = null;
      this.proximaPausa = t + 50 + Math.random() * 90;
    } else {
      this.modo = 'pausa';
      this.raiz.rotation.y = Math.PI;
      this.fimPausa = t + 8 + Math.random() * 7;
    }
    this.rotular();
  }

  descartar(mundo) {
    mundo.remove(this.raiz, this.painel, this.objeto, ...this.faiscas);
    this.etiqueta.removeFromParent();
    this.el.remove();
  }
}

function girarPara(atual, alvo, fator) {
  let delta = ((alvo - atual + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return atual + delta * Math.min(1, fator);
}

// --- Cena -----------------------------------------------------------------

const container = document.getElementById('cena');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const rotulos = new CSS2DRenderer();
rotulos.domElement.style.position = 'absolute';
rotulos.domElement.style.inset = '0';
rotulos.domElement.style.pointerEvents = 'none';
container.appendChild(rotulos.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0c0a09');

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = !reduzirMovimento;
controls.enablePan = false;
controls.minZoom = 0.7;
controls.maxZoom = 3;
// A câmera fica sempre do lado aberto da sala: as duas paredes ficam atrás.
controls.minAzimuthAngle = 0.1;
controls.maxAzimuthAngle = Math.PI / 2 - 0.1;
controls.minPolarAngle = 0.55;
controls.maxPolarAngle = 1.2;

// Reflexo de uma sala genérica: é o que dá o brilho de verniz no plástico
// dos personagens. Fraco, para não clarear a sala, que é noturna.
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.18;

scene.add(new THREE.HemisphereLight('#ffe9d0', '#2a1c12', 1.1));
// Contraluz fria vinda do fundo: contorna os personagens contra o piso escuro.
const contraluz = new THREE.DirectionalLight('#a5c4ff', 1.1);
contraluz.position.set(-12, 10, -14);
scene.add(contraluz);
const sol = new THREE.DirectionalLight('#ffe2bf', 2.2);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
sol.shadow.bias = -0.0004;
scene.add(sol, sol.target);
const lampadas = [new THREE.PointLight('#ffcf9a', 30, 14, 1.6), new THREE.PointLight('#ffcf9a', 30, 14, 1.6)];
scene.add(...lampadas);

let mundo = null;
let sala = null;
let pecas = null;
let personagens = new Map();
let vagasCafe = [];
let alcanceCamera = 14;

function enquadrar() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  const aspecto = w / h;
  // A sala vista de quina ocupa mais na largura que na altura: em tela
  // estreita é a largura que manda.
  const meiaAltura = Math.max(alcanceCamera * 0.62 + 2.2, (alcanceCamera * 1.02) / aspecto);
  camera.left = -meiaAltura * aspecto;
  camera.right = meiaAltura * aspecto;
  camera.top = meiaAltura;
  camera.bottom = -meiaAltura;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  rotulos.setSize(w, h);
}
addEventListener('resize', enquadrar);

/** Monta sala, mesas e personagens a partir do elenco. Refeito quando o elenco muda. */
function montarCena(agentes) {
  if (mundo) {
    for (const p of personagens.values()) p.descartar(mundo);
    scene.remove(mundo);
  }
  mundo = new THREE.Group();
  scene.add(mundo);
  personagens = new Map();

  const ordenados = [...agentes].sort((a, b) => a.order - b.order || a.agent.localeCompare(b.agent));
  const lider = ordenados.find((a) => a.role === 'orquestrador') ?? null;
  const time = ordenados.filter((a) => a !== lider);

  sala = dimensoesSala(time.length);
  pecas = montarSala(sala, mundo);

  // Tapete sob a mesa do orquestrador.
  mundo.add(caixa(5.4, 0.02, 3.6, material(new THREE.Color(COR_PAPEL.orquestrador).multiplyScalar(0.25).getStyle()), { x: MESA_LIDER.x, y: 0.01, z: MESA_LIDER.z - 0.5, sombra: false }));

  vagasCafe = [
    { ponto: new THREE.Vector3(sala.xMin + 1.3, 0, sala.zMin + 1.75), ocupada: false },
    { ponto: new THREE.Vector3(sala.xMin + 2.6, 0, sala.zMin + 1.85), ocupada: false },
  ];
  const caminhoCafe = new THREE.Vector3(sala.xMin + 4.5, 0, CORREDOR_Z);

  const colocar = (agente, ponto, largura, ladoSaida) => {
    const cor = COR_PAPEL[agente?.role] ?? COR_PAPEL.generico;
    const mesa = montarMesa(cor, largura);
    mesa.grupo.position.copy(ponto);
    mundo.add(mesa.grupo);
    if (!agente) return;
    // Sai pelo corredor ao lado da mesa, depois pelo corredor da frente até o café.
    const corredorX = ponto.x + ladoSaida * (largura / 2 + 1.05);
    const assento = ponto.clone().add(ASSENTO);
    mesa.saida = [
      new THREE.Vector3(corredorX, 0, assento.z),
      new THREE.Vector3(corredorX, 0, CORREDOR_Z),
      caminhoCafe,
    ];
    personagens.set(agente.agent, new Personagem(agente, mesa, mundo, ponto));
  };

  colocar(lider, MESA_LIDER, 3.2, 1);
  const fileiras = Math.max(3, Math.ceil(time.length / COLUNAS.length));
  for (let i = 0; i < fileiras * COLUNAS.length; i++) {
    const ponto = new THREE.Vector3(COLUNAS[i % COLUNAS.length], 0, FILEIRA_Z0 + Math.floor(i / COLUNAS.length) * FILEIRA_PASSO);
    // Mesa sem dono também aparece: a sala parece um escritório, não uma grade.
    colocar(time[i] ?? null, ponto, 2.4, -1);
  }

  const centro = new THREE.Vector3((sala.xMin + sala.xMax) / 2, 0.5, (sala.zMin + sala.zMax) / 2);
  // Meia largura da sala projetada, com a câmera a 45° das paredes.
  alcanceCamera = (sala.xMax - sala.xMin + sala.zMax - sala.zMin) * 0.3536;
  controls.target.copy(centro);
  camera.position.copy(centro).add(new THREE.Vector3(1, 0.95, 1.05).multiplyScalar(40));
  // Em tela estreita a sala inteira já ocupa a largura toda.
  camera.zoom = container.clientWidth > 700 ? 1.15 : 1;
  sol.position.copy(centro).add(new THREE.Vector3(9, 16, 8));
  sol.target.position.copy(centro);
  const s = alcanceCamera + 3;
  Object.assign(sol.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 60 });
  sol.shadow.camera.updateProjectionMatrix();
  lampadas[0].position.set(2, 4.6, -3);
  lampadas[1].position.set(6, 4.6, sala.zMax - 4);
  controls.update();
  enquadrar();
}

// --- TV -------------------------------------------------------------------

const tvInfo = { nome: '', totais: null };

function desenharTV() {
  if (!pecas) return;
  const ctx = pecas.canvasTV.getContext('2d');
  const { width: w, height: h } = pecas.canvasTV;
  const lista = [...personagens.values()];
  const ativos = lista.filter((p) => p.estado === 'pensando' || p.estado === 'trabalhando').length;

  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 26px system-ui';
  ctx.fillText(`PAINEL · ${tvInfo.nome.toUpperCase()}`, 40, 56);

  ctx.fillStyle = ativos ? '#4ade80' : '#f5f5f4';
  ctx.font = '700 46px system-ui';
  ctx.fillText(ativos ? `${ativos} trabalhando agora` : 'Time disponível', 40, 124);

  const blocos = [
    ['tokens hoje', tk(tvInfo.totais?.totalTokens)],
    ['chamadas', BRint.format(tvInfo.totais?.requests ?? 0)],
    ['no time', String(lista.length)],
  ];
  blocos.forEach(([rotulo, valor], i) => {
    const x = 40 + i * 236;
    ctx.fillStyle = '#111b2e';
    ctx.fillRect(x, 170, 216, 200);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 24px system-ui';
    ctx.fillText(rotulo, x + 20, 214);
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 54px system-ui';
    ctx.fillText(valor, x + 20, 300);
  });
  pecas.texTV.needsUpdate = true;
}

// --- Dados ----------------------------------------------------------------

const params = new URLSearchParams(location.search);
let projeto = params.get('project');
let nomesDoElenco = '';

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} em ${url}`);
  return r.json();
}

function avisar(texto) {
  const el = document.getElementById('aviso');
  el.hidden = !texto;
  el.textContent = texto ?? '';
}

async function carregarPalco({ refazer = false } = {}) {
  const q = projeto ? `?project=${encodeURIComponent(projeto)}&period=day` : '?period=day';
  const stage = await get(`/v1/stage${q}`);
  projeto = stage.project;
  tvInfo.totais = stage.totals;

  const nomes = stage.agents.map((a) => `${a.agent}:${a.role}`).join('|');
  if (refazer || nomes !== nomesDoElenco) {
    nomesDoElenco = nomes;
    montarCena(stage.agents);
  } else {
    for (const a of stage.agents) personagens.get(a.agent)?.uso(a.usage);
  }
  avisar(stage.agents.length ? null : 'Nenhum agente neste projeto ainda. Conecte um projeto ou rode `npm run demo`.');
  desenharTV();
  return stage;
}

// Rajada de eventos vira uma recarga só.
let recarga = null;
function recarregarDepois() {
  clearTimeout(recarga);
  recarga = setTimeout(() => carregarPalco().catch(() => {}), 1500);
}

function conectar() {
  const es = new EventSource(`/v1/stream?project=${encodeURIComponent(projeto)}`);
  const conn = document.getElementById('conn');
  const marcar = (on) => {
    conn.dataset.on = String(on);
    conn.lastChild.textContent = on ? 'conectado ao stream' : 'sem stream';
  };
  es.addEventListener('open', () => marcar(true));
  es.addEventListener('error', () => marcar(false));
  es.addEventListener('hello', (e) => {
    marcar(true);
    for (const a of JSON.parse(e.data).agents) personagens.get(a.agent)?.aplicar(a);
    desenharTV();
  });
  es.addEventListener('activity', (e) => {
    const a = JSON.parse(e.data);
    const p = personagens.get(a.agent);
    if (p) p.aplicar(a);
    else recarregarDepois();
    desenharTV();
  });
  es.addEventListener('event', recarregarDepois);
  es.addEventListener('roster', recarregarDepois);
}

async function montarSeletor() {
  const projetos = await get('/v1/projects');
  const sel = document.getElementById('projeto');
  for (const p of projetos.filter((x) => !x.archivedAt)) {
    const op = document.createElement('option');
    op.value = p.id;
    op.textContent = p.name;
    op.selected = p.id === projeto;
    sel.append(op);
  }
  sel.addEventListener('change', () => {
    location.search = `?project=${encodeURIComponent(sel.value)}`;
  });
  tvInfo.nome = projetos.find((p) => p.id === projeto)?.name ?? projeto;
  document.getElementById('voltar').href = `/?project=${encodeURIComponent(projeto)}`;
  desenharTV();
}

// --- Laço -----------------------------------------------------------------

const relogio = new THREE.Clock();

function pausas(t) {
  const emPausa = [...personagens.values()].filter((p) => p.modo !== 'sentado').length;
  if (emPausa >= vagasCafe.length) return;
  for (const p of personagens.values()) {
    if (!p.livreParaPausa() || t < p.proximaPausa) continue;
    const vaga = vagasCafe.find((v) => !v.ocupada);
    if (!vaga) return;
    p.irAoCafe(vaga);
    return;
  }
}

function moverPonteiros() {
  if (!pecas) return;
  const d = new Date();
  const s = d.getSeconds() + d.getMilliseconds() / 1000;
  const m = d.getMinutes() + s / 60;
  const h = (d.getHours() % 12) + m / 60;
  pecas.ponteiros.segundo.rotation.z = -(s / 60) * Math.PI * 2;
  pecas.ponteiros.minuto.rotation.z = -(m / 60) * Math.PI * 2;
  pecas.ponteiros.hora.rotation.z = -(h / 12) * Math.PI * 2;
}

function quadroDoLaco() {
  const dt = Math.min(relogio.getDelta(), 0.1);
  const t = performance.now() / 1000;
  pausas(t);
  for (const p of personagens.values()) p.atualizar(dt, t, camera);
  moverPonteiros();
  controls.update();
  renderer.render(scene, camera);
  rotulos.render(scene, camera);
}

renderer.setAnimationLoop(quadroDoLaco);

try {
  await carregarPalco();
  await montarSeletor();
  conectar();
} catch (err) {
  console.error(err);
  avisar(`Não deu para carregar o escritório: ${err.message}`);
}

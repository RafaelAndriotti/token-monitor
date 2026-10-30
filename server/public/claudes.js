import { useId } from 'react';
import { html } from 'htm/react';

/**
 * Os personagens, em SVG desenhado à mão — nenhuma imagem para carregar,
 * nenhum render 3D.
 *
 * O volume não vem de faces chapadas: a silhueta do corpo é um hexágono de
 * cantos arredondados, e o topo e a lateral entram por cima como faces
 * igualmente arredondadas, cada uma com o seu gradiente. Braços, pernas e
 * antena são formas de ponta redonda com um gradiente lateral, que lê como
 * cilindro macio em vez de cubo.
 *
 * Todas as cores saem da mesma variável `--role` por `color-mix` em
 * `styles.css`, então trocar o papel troca o personagem inteiro — corpo,
 * acessório de cabeça e o que ele segura.
 *
 * Quem anima é o CSS, pelo atributo `data-state` na raiz do SVG: o React muda
 * o estado e sai do caminho.
 *
 * Estados: parado · pensando · trabalhando · concluido · erro
 */

// --- Geometria ------------------------------------------------------------

/** Anda de `a` na direção de `b`, no máximo metade do caminho. */
function towards(a, b, r) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(r, len / 2) / len;
  return [a[0] + dx * t, a[1] + dy * t];
}

/**
 * Polígono de cantos arredondados: cada vértice vira uma quadrática que passa
 * por ele. É o que tira a aresta viva dos cubos.
 */
function roundPoly(points, r) {
  const n = points.length;
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const entrada = towards(cur, prev, r);
    const saida = towards(cur, next, r);
    d += `${i === 0 ? 'M' : 'L'}${entrada[0].toFixed(1)} ${entrada[1].toFixed(1)}`;
    d += ` Q${cur[0]} ${cur[1]} ${saida[0].toFixed(1)} ${saida[1].toFixed(1)}`;
  }
  return `${d} Z`;
}

/** As três faces de um bloco macio, cada uma com o seu gradiente. */
function Soft({ x, y, w, h, d = 10, r = 10, fill, top, side }) {
  const A = [x, y];
  const B = [x + d, y - d];
  const C = [x + w + d, y - d];
  const D = [x + w + d, y + h - d];
  const E = [x + w, y + h];
  const F = [x, y + h];
  const G = [x + w, y]; // canto onde as três faces se encontram

  return html`
    <g>
      <path fill=${fill} d=${roundPoly([A, B, C, D, E, F], r)} />
      <path fill=${top} d=${roundPoly([A, B, C, G], Math.min(r * 0.8, d * 0.9))} />
      <path fill=${side} d=${roundPoly([G, C, D, E], Math.min(r * 0.8, d * 0.9))} />
    </g>
  `;
}

/** Um membro: ponta redonda e gradiente lateral, para ler como cilindro. */
function Limb({ x, y, w, h, fill, rotate }) {
  const corpo = html`
    <g>
      <rect x=${x} y=${y} width=${w} height=${h} rx=${w / 2} fill=${fill} />
      <ellipse class="vx-sheen" cx=${x + w * 0.34} cy=${y + h * 0.3} rx=${w * 0.17} ry=${h * 0.2} />
    </g>
  `;
  return rotate ? html`<g transform=${rotate}>${corpo}</g>` : corpo;
}

// --- Acessório de cabeça --------------------------------------------------
// Fica em cima do corpo, no tom escuro `vx-gear`. A cabeça ocupa x 48..132,
// y 62..130, com a face de topo subindo até y≈42.

const HATS = {
  // Orquestrador: fone com microfone — ele coordena os outros.
  headset: html`
    <g>
      <path class="vx-gear-stroke" d="M44 82 Q44 42 90 40 Q136 42 136 82" stroke-width="9" />
      <rect class="vx-gear" x="33" y="74" width="17" height="28" rx="8.5" />
      <rect class="vx-gear" x="130" y="74" width="17" height="28" rx="8.5" />
      <path class="vx-gear-stroke" d="M47 101 Q54 116 68 116" stroke-width="5" />
      <circle class="vx-gear" cx="71" cy="116" r="5.5" />
    </g>
  `,
  // Designer: boina inclinada, pousada no topo da cabeça.
  beret: html`
    <g transform="rotate(-10 90 50)">
      <path class="vx-gear" d="M52 54 Q52 37 90 37 Q128 37 128 54 Q110 63 90 63 Q66 63 52 54 Z" />
      <circle class="vx-gear" cx="112" cy="34" r="6" />
    </g>
  `,
  // Frontend: boné com aba virada para a esquerda.
  cap: html`
    <g>
      <path class="vx-gear" d="M52 57 Q52 32 90 32 Q128 32 128 57 Q90 63 52 57 Z" />
      <path class="vx-gear" d="M55 55 Q31 55 33 63 Q37 69 57 65 Z" />
    </g>
  `,
  // Backend: capacete de obra, com aba em volta e crista.
  helmet: html`
    <g>
      <path class="vx-gear" d="M57 55 Q57 32 90 32 Q123 32 123 55 Q90 61 57 55 Z" />
      <path class="vx-gear" d="M41 53 Q90 65 139 53 Q139 61 90 63 Q41 61 41 53 Z" />
      <path class="vx-gear-stroke" d="M90 34 L90 54" stroke-width="6" />
    </g>
  `,
  // Revisor: óculos em volta dos olhos, sem preencher.
  glasses: html`
    <g>
      <rect class="vx-gear-stroke" x="60" y="74" width="28" height="32" rx="12" fill="none" stroke-width="5" />
      <rect class="vx-gear-stroke" x="92" y="74" width="28" height="32" rx="12" fill="none" stroke-width="5" />
      <path class="vx-gear-stroke" d="M88 88 Q90 85 92 88" stroke-width="5" />
      <path class="vx-gear-stroke" d="M60 84 Q52 80 46 79" stroke-width="5" />
      <path class="vx-gear-stroke" d="M120 84 Q128 80 134 79" stroke-width="5" />
    </g>
  `,
  // Pesquisador: chapéu de aba larga.
  explorer: html`
    <g>
      <path class="vx-gear" d="M40 55 Q90 68 140 55 Q140 64 90 66 Q40 64 40 55 Z" />
      <path class="vx-gear" d="M67 57 Q67 33 90 33 Q113 33 113 57 Q90 61 67 57 Z" />
    </g>
  `,
  // Dados: viseira de contabilista.
  visor: html`
    <g>
      <path class="vx-gear" d="M46 62 Q90 54 134 62 Q134 56 90 49 Q46 56 46 62 Z" />
      <path class="vx-gear" d="M44 62 Q90 56 136 62 Q136 72 90 76 Q44 72 44 62 Z" />
    </g>
  `,
  // DevOps: lanterna de cabeça.
  headlamp: html`
    <g>
      <path class="vx-gear" d="M46 60 Q90 52 134 60 Q134 70 90 74 Q46 70 46 60 Z" />
      <circle class="vx-gear" cx="90" cy="63" r="13" />
      <circle class="vx-lamp vx-led" cx="90" cy="63" r="7" />
    </g>
  `,
  // QA: faixa na testa, com as pontas soltas.
  band: html`
    <g>
      <path class="vx-gear" d="M46 61 Q90 53 134 61 Q134 71 90 75 Q46 71 46 61 Z" />
      <path class="vx-gear-stroke" d="M48 72 Q40 80 30 86" stroke-width="5" />
      <path class="vx-gear-stroke" d="M55 74 Q48 84 42 92" stroke-width="5" />
    </g>
  `,
};

// --- O que cada papel segura ---------------------------------------------
// Espaço local de ~66x62, posicionado à direita do corpo. `vx-soft` é o tom
// pálido do papel; `vx-mark` é a marca por cima dele.

function SoftCard({ x, y, w, h, d = 9, r = 9 }) {
  return html`<${Soft}
    x=${x}
    y=${y}
    w=${w}
    h=${h}
    d=${d}
    r=${r}
    fill="var(--role-soft)"
    top="var(--role-soft-top)"
    side="var(--role-soft-side)"
  />`;
}

const PROPS = {
  // Orquestrador: o quadro onde o plano é escrito.
  card: html`
    <g>
      <${SoftCard} x=${6} y=${16} w=${52} h=${40} />
      <rect class="vx-mark" x="14" y="26" width="30" height="4" rx="2" />
      <rect class="vx-mark" x="14" y="36" width="36" height="4" rx="2" />
      <rect class="vx-mark" x="14" y="46" width="22" height="4" rx="2" />
    </g>
  `,
  // Designer: a tela com a composição.
  picture: html`
    <g>
      <${SoftCard} x=${6} y=${16} w=${52} h=${40} />
      <circle class="vx-mark" cx="21" cy="28" r="5" />
      <path class="vx-mark" d="M12 50 Q20 40 26 34 Q34 40 36 44 Q40 39 43 37 Q48 43 52 50 Z" />
    </g>
  `,
  // Frontend: a janela com o código.
  screen: html`
    <g>
      <${SoftCard} x=${4} y=${14} w=${56} h=${38} />
      <path class="vx-mark-stroke" d="M22 25 L14 33 L22 41" />
      <path class="vx-mark-stroke" d="M42 25 L50 33 L42 41" />
      <path class="vx-mark-stroke" d="M35 23 L29 43" />
      <rect class="vx-mark" x="18" y="56" width="28" height="4" rx="2" />
    </g>
  `,
  // Backend: o rack, com uma luz por slot.
  rack: html`
    <g>
      <${SoftCard} x=${10} y=${14} w=${42} h=${13} d=${8} r=${6} />
      <${SoftCard} x=${10} y=${31} w=${42} h=${13} d=${8} r=${6} />
      <${SoftCard} x=${10} y=${48} w=${42} h=${13} d=${8} r=${6} />
      <circle class="vx-mark vx-led" cx="18" cy="20.5" r="3" />
      <circle class="vx-mark vx-led" cx="18" cy="37.5" r="3" style=${{ animationDelay: '180ms' }} />
      <circle class="vx-mark vx-led" cx="18" cy="54.5" r="3" style=${{ animationDelay: '360ms' }} />
    </g>
  `,
  // Revisor: o diff sob a lupa.
  lens: html`
    <g>
      <${SoftCard} x=${12} y=${12} w=${48} h=${36} />
      <rect class="vx-mark" x="20" y="21" width="26" height="4" rx="2" />
      <rect class="vx-mark" x="20" y="31" width="18" height="4" rx="2" />
      <g class="vx-lens">
        <circle class="vx-glass" cx="22" cy="49" r="13" />
        <path class="vx-mark-stroke" d="M32 59 L41 68" stroke-width="5" />
      </g>
    </g>
  `,
  // Pesquisador: o livro aberto, com a ideia acima dele.
  book: html`
    <g>
      <${SoftCard} x=${6} y=${28} w=${52} h=${32} r=${8} />
      <path class="vx-mark-stroke" d="M32 30 L32 58" stroke-width="4" />
      <rect class="vx-mark" x="13" y="38" width="13" height="3.5" rx="1.75" />
      <rect class="vx-mark" x="13" y="47" width="13" height="3.5" rx="1.75" />
      <rect class="vx-mark" x="38" y="38" width="13" height="3.5" rx="1.75" />
      <rect class="vx-mark" x="38" y="47" width="13" height="3.5" rx="1.75" />
      <circle class="vx-mark vx-led" cx="32" cy="9" r="9" />
      <path class="vx-mark-stroke" d="M32 20 L32 24" stroke-width="4" />
    </g>
  `,
  // Dados: as barras.
  chart: html`
    <g>
      <${SoftCard} x=${6} y=${14} w=${54} h=${42} />
      <rect class="vx-mark vx-bar" x="15" y="34" width="9" height="16" rx="4.5" />
      <rect class="vx-mark vx-bar" x="29" y="26" width="9" height="24" rx="4.5" style=${{
        animationDelay: '160ms',
      }} />
      <rect class="vx-mark vx-bar" x="43" y="30" width="9" height="20" rx="4.5" style=${{
        animationDelay: '320ms',
      }} />
    </g>
  `,
  // DevOps: o pipeline, três estágios ligados.
  pipeline: html`
    <g>
      <${SoftCard} x=${6} y=${16} w=${18} h=${18} d=${7} r=${7} />
      <${SoftCard} x=${6} y=${42} w=${18} h=${18} d=${7} r=${7} />
      <${SoftCard} x=${38} y=${29} w=${20} h=${20} d=${7} r=${8} />
      <path class="vx-mark-stroke" d="M26 25 Q32 28 36 33" stroke-width="3.5" />
      <path class="vx-mark-stroke" d="M26 51 Q32 48 36 44" stroke-width="3.5" />
      <circle class="vx-mark vx-led" cx="48" cy="39" r="4" />
    </g>
  `,
  // QA: a lista com os vistos.
  checklist: html`
    <g>
      <${SoftCard} x=${8} y=${12} w=${50} h=${46} />
      <path class="vx-mark-stroke" d="M15 24 L19 28 L26 20" stroke-width="3.5" />
      <path class="vx-mark-stroke" d="M15 37 L19 41 L26 33" stroke-width="3.5" />
      <path class="vx-mark-stroke" d="M15 50 L19 54 L26 46" stroke-width="3.5" />
      <rect class="vx-mark" x="32" y="23" width="20" height="3.5" rx="1.75" />
      <rect class="vx-mark" x="32" y="36" width="20" height="3.5" rx="1.75" />
      <rect class="vx-mark" x="32" y="49" width="14" height="3.5" rx="1.75" />
    </g>
  `,
  // Genérico: só o brilho.
  spark: html`
    <g>
      <${SoftCard} x=${10} y=${20} w=${44} h=${34} />
      <path
        class="vx-mark"
        d="M32 23 Q35 34 41 37 Q48 40 41 43 Q35 46 32 57 Q29 46 23 43 Q16 40 23 37 Q29 34 32 23 Z"
      />
    </g>
  `,
};

// A boca só aparece no fim do ciclo; a largura é a mesma nos dois casos.
const MOUTHS = {
  parado: 'M74 112 Q90 118 106 112',
  pensando: 'M76 113 Q90 113 104 113',
  trabalhando: 'M72 110 Q90 120 108 110',
  concluido: 'M72 108 Q90 124 108 108',
  erro: 'M74 118 Q90 108 106 118',
};

/** As pernas: alturas e inclinações diferentes, para o apoio não ficar mecânico. */
const LEGS = [
  { x: 48, h: 19, rot: -11 },
  { x: 66, h: 24, rot: -5 },
  { x: 84, h: 27, rot: 0 },
  { x: 102, h: 24, rot: 5 },
  { x: 120, h: 19, rot: 11 },
];

export function ClaudeFigure({ prop = 'spark', hat = null, state = 'parado', size = 198 }) {
  // Cada figura tem os seus gradientes: um id compartilhado faria todos os
  // personagens da tela herdarem a cor de um só.
  const uid = useId().replace(/:/g, '');
  const g = (nome) => `url(#${uid}-${nome})`;

  const acessorio = PROPS[prop] ?? PROPS.spark;
  const chapeu = hat ? HATS[hat] : null;
  const boca = MOUTHS[state] ?? MOUTHS.parado;

  return html`
    <svg
      class="claude"
      data-state=${state}
      viewBox="0 0 232 186"
      width=${size}
      height=${(size * 186) / 232}
      role="presentation"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id=${`${uid}-front`} x1="0.1" y1="0" x2="0.7" y2="1">
          <stop offset="0" class="stop-lite" />
          <stop offset="0.55" class="stop-base" />
          <stop offset="1" class="stop-deep" />
        </linearGradient>
        <linearGradient id=${`${uid}-top`} x1="0" y1="1" x2="0.5" y2="0">
          <stop offset="0" class="stop-top" />
          <stop offset="1" class="stop-top-lite" />
        </linearGradient>
        <linearGradient id=${`${uid}-side`} x1="0" y1="0" x2="1" y2="0.6">
          <stop offset="0" class="stop-side" />
          <stop offset="1" class="stop-side-deep" />
        </linearGradient>
        <linearGradient id=${`${uid}-limb`} x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0" class="stop-limb" />
          <stop offset="1" class="stop-limb-deep" />
        </linearGradient>
      </defs>

      <!-- Sombra em duas camadas: a de fora, maior e mais fraca, faz a difusão
           sem custar um filtro de desfoque em cada personagem da tela. -->
      <g class="vx-shadow">
        <ellipse class="vx-shadow-far" cx="92" cy="166" rx="62" ry="13" />
        <ellipse class="vx-shadow-near" cx="92" cy="166" rx="42" ry="8" />
      </g>

      <g class="vx-float">
        <!-- Pensando: três bolhas subindo à esquerda da cabeça -->
        <g class="vx-think">
          <circle cx="18" cy="40" r="4.5" />
          <circle cx="32" cy="27" r="6" style=${{ animationDelay: '160ms' }} />
          <circle cx="48" cy="13" r="7.5" style=${{ animationDelay: '320ms' }} />
        </g>

        <!-- Lampejos em volta do corpo -->
        <g class="vx-sparks">
          <path d="M34 76 Q26 72 20 68" />
          <path d="M30 92 Q22 92 14 92" />
          <path d="M34 108 Q26 112 20 116" />
          <path d="M150 70 Q158 66 164 62" />
          <path d="M154 86 Q162 85 169 84" />
        </g>

        <!-- Antena, alta o bastante para passar por cima do chapéu -->
        <g class="vx-antenna">
          <${Limb} x=${87} y=${28} w=${7} h=${38} fill=${g('limb')} />
          <circle class="vx-ball" cx="90.5" cy="24" r="8" />
        </g>

        <!-- Pernas, atrás do corpo -->
        <g class="vx-legs">
          ${LEGS.map(
            // A abertura vai no atributo do grupo de fora; o balanço é CSS no
            // de dentro, senão a animação substituiria a abertura.
            (l, i) => html`<g key=${l.x} transform=${`rotate(${l.rot} ${l.x + 6.5} 124)`}>
              <g class="vx-leg" style=${{ animationDelay: `${i * 90}ms` }}>
                <${Limb} x=${l.x} y=${118} w=${13} h=${l.h + 8} fill=${g('limb')} />
              </g>
            </g>`,
          )}
        </g>

        <!-- Braços, abertos para fora -->
        <${Limb} x=${33} y=${92} w=${14} h=${30} fill=${g('limb')} rotate="rotate(-20 40 96)" />
        <g class="vx-arm-right">
          <${Limb} x=${133} y=${92} w=${14} h=${30} fill=${g('limb')} rotate="rotate(16 140 96)" />
        </g>

        <!-- Corpo -->
        <${Soft}
          x=${48}
          y=${62}
          w=${84}
          h=${68}
          d=${20}
          r=${20}
          fill=${g('front')}
          top=${g('top')}
          side=${g('side')}
        />
        <!-- O brilho que tira o aspecto chapado da frente -->
        <ellipse class="vx-sheen vx-sheen-body" cx="70" cy="78" rx="15" ry="11" />

        <!-- Olhos -->
        <g class="vx-eyes">
          <rect class="vx-eye" x="66" y="80" width="16" height="21" rx="8" />
          <rect class="vx-eye" x="98" y="80" width="16" height="21" rx="8" />
        </g>

        <path class="vx-mouth" d=${boca} />

        <!-- Acessório de cabeça, por cima do corpo e dos olhos -->
        ${chapeu ? html`<g class="vx-hat">${chapeu}</g>` : null}

        <!-- O que ele segura -->
        <g class="vx-prop" transform="translate(152, 58)">${acessorio}</g>

        <!-- Selos de fim -->
        <g class="vx-badge vx-badge-ok">
          <circle cx="36" cy="142" r="15" />
          <path d="M29 142 L34 147.5 L44 136" />
        </g>
        <g class="vx-badge vx-badge-err">
          <circle cx="36" cy="142" r="15" />
          <path d="M30 136 L42 148 M42 136 L30 148" />
        </g>
      </g>
    </svg>
  `;
}

import React, { useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { Coordinates, AppItem, UIConfig, Workspace } from '../types';
import { getIcon } from '../iconMap';
import { CornerUpLeft } from 'lucide-react';
import { SmartIcon } from './SmartIcon';
import { RovylLogo } from './RovylLogo';
import { uiString } from '../strings';
import { RadialHud } from './RadialHud';
import {
  filterRadialApps,
  getRootRadialApps,
  isWorkspacePickItem,
  parseWorkspacePickIndex,
} from '../utils/workspaceRadial';
import { clampDwellMs, directionCommitPx } from '../constants/radialDwell';

// PERF FIX #3: Module-level weather cache — persists across menu open/close cycles
// Prevents a new HTTP fetch on every menu open; refreshes only after 10 minutes or location change
const weatherCache: { data: { temp: number; condition: string } | null; lastFetch: number; location: string } = {
  data: null, lastFetch: 0, location: ''
};
const WEATHER_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Subconjunto da API Battery — evita `BatteryManager` quando o TS/DOM local não o expõe. */
type ZenithBattery = {
  level: number;
  addEventListener(type: 'levelchange', listener: () => void): void;
  removeEventListener(type: 'levelchange', listener: () => void): void;
};

// Helper to extract a normalized path from a command string for deduplication
const normalizePathForDedup = (item: any): string => {
  if (!item) return '';
  // NEVER use item.description as it might be "Quick Access Folder" or "Application"
  let pathStr = item.command || '';
  
  // 1. Handle commands with multiple arguments (e.g. "exe" "path" or code "path")
  // We want the LAST argument which is usually the file/folder path
  const allQuotes = [...pathStr.matchAll(/"([^"]+)"/g)];
  if (allQuotes.length > 0) {
    // If multiple quotes, take the last one (the folder path)
    // If one quote and it's an IDE command, take that quote
    pathStr = allQuotes[allQuotes.length - 1][1];
  } else {
    // No quotes, handle unquoted IDE prefixes (e.g., code C:\Path)
    const lower = pathStr.toLowerCase();
    const ideCommands = ['antigravity', 'cursor', 'code', 'vs code', 'vscode', 'code.exe', 'cursor.exe', 'antigravity.exe'];
    for (const cmd of ideCommands) {
      if (lower.startsWith(cmd + ' ')) {
        pathStr = pathStr.substring(cmd.length + 1).trim();
        break;
      }
    }
  }
  
  // 3. Absolute Normalization
  // - Lowercase for case-insensitivity
  // - Replace all backslashes with forward slashes
  // - Trim any trailing slashes or spaces
  // - Ensure drive letter is consistent (c: vs C:)
  let normalized = pathStr
    .toLowerCase()
    .trim()
    .replace(/[\\/]+/g, '/')     // Multiple slashes to single forward slash
    .replace(/\/+$/, '')         // Remove trailing slashes
    .replace(/^(['"]+)|(['"]+)$/g, ''); // Remove wrapping quotes if they managed to survive
    
  // Handle Windows Drive Letter consistency (e.g., c:/path -> c:/path)
  // We keep it lowercase as we already called .toLowerCase()
  if (/^[a-z]:/.test(normalized)) {
    // Already lowercased, just return
    return normalized;
  }
  
  return normalized;
};

/**
 * O nível raiz é reconstruído (array novo) sempre que o efeito de sincronização corre — em modo
 * `picker` os itens são sintéticos. Trocar a lista por uma equivalente re-renderiza a roda inteira
 * e, agora que a abertura é uma transição CSS presa à identidade do nível, faria a roda "renascer".
 */
function sameRadialLevel(a: AppItem[], b: AppItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.id === b[i].id && item.label === b[i].label);
}

/** When "recent folders" is enabled but MRU fetch is empty or fails, show one explicit slice — never auto-launch the parent IDE. */
function buildRecentsEmptyFallback(parent: AppItem): AppItem[] {
  return [
    {
      id: `${parent.id}__recents-empty-fallback`,
      label: uiString('menu.recents_fallback'),
      command: parent.command,
      commandType: parent.commandType || 'app',
      iconName: parent.iconName || 'AppWindow',
      iconSource: parent.iconSource || 'lucide',
      customIconUrl: parent.customIconUrl,
      description: parent.label,
    },
  ];
}

/** Parent IDE setting: MRU slices open a terminal cwd'd to the project path (see executeCommand + IDE branch). */
function applyOpenTerminalForRecents(recents: AppItem[], parent: AppItem): AppItem[] {
  const commands = (parent.terminalCommands || []).filter((command) => command.trim().length > 0);
  if (!parent.openTerminalForRecents && commands.length === 0) return recents;
  return recents.map((recent) => ({
    ...recent,
    openTerminal: parent.openTerminalForRecents || commands.length > 0,
    terminalCommands: commands.length > 0 ? commands : recent.terminalCommands,
    launchMode: parent.launchMode,
  }));
}

/**
 * Calibração da roda. Extraída para módulo porque o gate da licença desenha a MESMA roda
 * (bloqueada): raio, tamanho de tile e respiração têm de vir daqui, nunca de constantes paralelas.
 */
export function computeRadialLayout({
  numberOfApps,
  iconSizePx,
  minGap,
  menuRadius,
  activationThreshold,
  viewportSize,
}: {
  numberOfApps: number;
  iconSizePx: number;
  minGap: number;
  menuRadius: number;
  activationThreshold?: number;
  viewportSize: { width: number; height: number };
}): { actualMenuRadius: number; actualIconSize: number } {
  // Allow the menu to occupy up to 52% of the smallest screen dimension (Phase 3)
  const maxScreenRadius = Math.min(viewportSize.width, viewportSize.height) * 0.52;
  const sinHalfSlice = numberOfApps > 1 ? Math.sin(Math.PI / numberOfApps) : 0;

  // Icon size ramps continuously with the item count rather than stepping at
  // 4 and 6 items: a sparse wheel reads better slightly compact, a dense one
  // wants the configured size, and adding one app should not resize the rest.
  const density = Math.max(0, Math.min(1, (numberOfApps - 3) / 6));
  let currentIconSize = Math.round(iconSizePx * (0.82 + 0.18 * density));

  // The ring grows only as fast as the icons need to keep a constant edge gap
  // between neighbours.
  const neighbourGap = minGap + 14;
  const packedRadius = (size: number) =>
    numberOfApps > 1 ? (size + neighbourGap) / 2 / sinHalfSlice : 0;

  // Floor: clear of the central hub, clear of the centre dead zone that
  // cancels selection, and scaled by the saved radius.
  const radiusScale = (menuRadius + minGap) / 150;
  const floorRadius = (size: number) =>
    Math.max(
      size * 1.1 + minGap + 12,                // hub is size * 1.2 wide
      (activationThreshold ?? 60) + size / 2 + 8, // stay outside the dead zone
      92,
    ) * radiusScale;

  let targetRadius = Math.max(floorRadius(currentIconSize), packedRadius(currentIconSize));

  // If the ring outgrows the screen, shrink the icons instead of overlapping.
  if (targetRadius > maxScreenRadius && numberOfApps > 1) {
    const possibleScale = (2 * maxScreenRadius * sinHalfSlice - neighbourGap) / currentIconSize;
    const scaleFactor = Math.max(0.5, Math.min(1.0, possibleScale));
    currentIconSize = Math.round(currentIconSize * scaleFactor);
    targetRadius = Math.max(floorRadius(currentIconSize), packedRadius(currentIconSize));
  }

  return { actualMenuRadius: targetRadius, actualIconSize: currentIconSize };
}

/**
 * Escurecimento do radial: poça radial em smoothstep de 9 stops (2 stops tão largos fazem
 * banding a 8-bit, e banding lê-se como borrão). Partilhado com o gate da licença.
 */
export function radialScrimGradient(
  position: { x: number; y: number },
  backdropOpacity: number,
  backdropRadius: number,
): string {
  const scrimPeak = 0.22 + backdropOpacity * 0.3;
  const scrimRadius = Math.round(backdropRadius * 2);
  const stops = [0, 0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88, 1]
    .map((t) => {
      const falloff = 1 - (3 * t * t - 2 * t * t * t);
      return `rgba(4,5,7,${(scrimPeak * falloff).toFixed(3)}) ${Math.round(t * scrimRadius)}px`;
    })
    .join(', ');
  return `radial-gradient(circle at ${Math.round(position.x)}px ${Math.round(position.y)}px, ${stops})`;
}

interface RadialMenuProps {
  /**
   * Whether the Start Menu scan is still to come. An empty wheel is otherwise indistinguishable
   * from one that has lost its shortcuts, and at login the scan is deferred twenty seconds.
   */
  discoveryPhase?: 'idle' | 'waiting' | 'scanning';
  isOpen: boolean;
  position: Coordinates;
  viewportSize: { width: number; height: number };
  /** Pass `selectedApp` when launching an item that may not exist in saved config (e.g. MRU `recent-*` ids). */
  onClose: (selectedId: string | null, selectedApp?: AppItem | null) => void;
  apps: AppItem[];
  config: UIConfig;
  triggerSource?: 'mmb' | 'mmb-click' | 'shortcut';
  onWorkspaceSwitch?: (workspaceIndex: number) => void;
  currentWorkspace?: Workspace;
  /** False enquanto o HWND oculto recebe o primeiro paint transparente. */
  animationReady?: boolean;
  /** Atualização descarregada e à espera de reinício — selo no hub. */
  updateReady?: boolean;
}

/**
 * Executar sem clique ("mira sustentada"): parar sobre um alvo durante `dwellMs` lança-o.
 *
 * O atraso de armar conta-se a partir do PRIMEIRO PAINT da roda, não de `openingTimeRef`. Esse é
 * escrito dentro do `flushSync` de `openMenu`, antes de o main revelar o HWND — e a revelação tem
 * um fallback de 120ms (240ms a restaurar de minimizado). Medido de lá, o atraso podia expirar com
 * a roda ainda invisível e cada tile ainda `pointer-events: none`: o utilizador levava com um
 * lançamento antes de ver o que quer que fosse.
 *
 * `INSTANT_ARM_DISPLACEMENT_PX` é deslocamento OBSERVADO desde uma referência posta por um
 * `mousemove` anterior — nunca `hasMoved`, que mede a distância ao CENTRO da roda e portanto já
 * está verdadeiro assim que o ponteiro está parado longe do centro, que é o caso perigoso.
 */
const INSTANT_ARM_DELAY_MS = 120;
const INSTANT_ARM_DISPLACEMENT_PX = 24;
/** Absorve o clique reflexo que chega logo a seguir a um lançamento por tempo. */
const INSTANT_QUARANTINE_MS = 300;
/**
 * Assentar antes de contar.
 *
 * Sem isto o temporizador media "há quanto tempo estou nesta cunha", não "há quanto tempo estou
 * parado num alvo" — e em modo ângulo uma cunha não tem limite de distância. Num nível com UM
 * item a cunha é o plano todo: atravessar a zona morta arrancava o relógio e 400ms depois lançava,
 * fizesse o ponteiro o que fizesse pelo caminho.
 *
 * A contagem só começa quando o ponteiro fica dentro de `DWELL_SETTLE_PX` durante
 * `DWELL_SETTLE_MS`. Enquanto se move, o que se reagenda é este `setTimeout` — não há um commit
 * do React por frame, que é o que uma reposição direta do arco custaria.
 */
const DWELL_SETTLE_PX = 10;
const DWELL_SETTLE_MS = 90;
/**
 * Já a contar, a tolerância é outra — e maior. As duas fases medem coisas diferentes: assentar
 * pergunta "a mão parou?", contar pergunta "a mão continua neste alvo?". Com um só raio, e ainda
 * medido a partir da última amostra em MOVIMENTO, uma contagem de 1.1s herdava um orçamento quase
 * gasto e um arrastar lento ficava preso num ciclo — o arco a aparecer e a morrer sem nunca abrir.
 */
const DWELL_HOLD_PX = 26;
/**
 * Abaixo disto o arco nao e informacao, e um flash: apareceria e morreria dentro do mesmo par de
 * frames. Com a espera opcional (0ms) isso passou a ser um caso REAL e nao teorico, portanto a
 * contagem curta executa sem desenhar nada — o feedback dessa escolha e a propria app a abrir.
 */
const DWELL_ARC_MIN_MS = 90;
/**
 * Mira por direcao — o modo em que a execucao sem clique vive.
 *
 * O ponteiro esta escondido e estacionado no centro da roda, portanto a fatia sai do VETOR que a
 * mao desenhou desde ai, nao da posicao onde o cursor por acaso ja estava. O vetor e acumulado a
 * partir dos deltas de cada `mousemove`, o que o torna imune ao ponto de partida — que era
 * exatamente o defeito: abrir a roda com o rato em baixo acendia o item de baixo ao primeiro
 * tremor, e a mira sustentada lancava-o sem ninguem ter escolhido nada.
 *
 * O vetor e limitado a um multiplo da sensibilidade porque isto e uma DIRECAO, nao uma posicao:
 * sem teto, virar do topo para o fundo depois de um gesto largo obrigava a desfazer o caminho
 * todo. Com teto, inverter custa sempre mais ou menos o mesmo.
 *
 * O fator nao e livre: o que sobra acima do limiar (1.5x ele) e a folga que separa "comprometido"
 * de "de volta ao centro", e tem de ser maior que `DWELL_HOLD_PX` -- senao um tremor que a mira
 * sustentada ainda aceita como mao parada ja desfazia a direcao, e o arco morria sozinho.
 */
const DIRECTION_CLAMP_FACTOR = 2.5;
/**
 * O `SetCursorPos` do estacionamento chega ao DOM como um `mousemove` normal — e como um salto de
 * centenas de pixeis, que somado ao vetor apontaria para o lado oposto ao do gesto. Enquanto um
 * estacionamento esta pendente, a amostra que aterra no centro (ou que salta mais do que uma mao
 * consegue num evento) e a do teleporte: serve de nova referencia e o seu delta e deitado fora.
 */
const PARK_LANDING_PX = 28;
const PARK_JUMP_PX = 120;
/** Sem aterragem nenhuma — Windows sem helper, outro sistema — o gesto volta ao normal. */
const PARK_TIMEOUT_MS = 400;
/** Folga ate a borda da janela; passar disto pede um reencosto antes de o cursor sair (e reaparecer). */
const PARK_STRAY_MARGIN_PX = 140;

interface RadialMenuItemProps {
  app: AppItem;
  index: number;
  isActive: boolean;
  /** Circular distance in slices from the aimed one; `null` while nothing is aimed. */
  angularDistance: number | null;
  actualMenuRadius: number;
  actualIconSize: number;
  totalApps: number;
  /** Narrow style props so parent config identity does not bust memo for every App re-render. */
  backdropOpacity: number;
  hoverColor: string;
  showLabels: boolean;
  alwaysShowAppLabels: boolean;
  folderStackLength: number;
  /** `false` keeps the slice collapsed at the hub — the frame before the bloom and the whole closed state. */
  bloom: boolean;
  /** Small chip inside the label pill (workspace number, "recentes"…). Omitted when the slice has no hint. */
  shortcutHint?: string;
  /**
   * Duração do arco de mira sustentada. Definido SÓ no tile que tem o temporizador a correr —
   * `undefined` em todos os outros, para que o `React.memo` deles não seja invalidado a cada dwell.
   */
  dwellMs?: number;
  /** Id da tentativa. Mudar remonta o `<svg>` e é isso que reinicia a animação CSS. */
  dwellKey?: number;
  onClick: (app: AppItem) => void;
}

/**
 * Labels sit OUTSIDE the wheel, on the side the slice points to, so a dense wheel never
 * stacks a pill over the neighbouring icon (the old below-the-icon placement did).
 */
export function getLabelPlacement(angleDeg: number, iconSize: number) {
  const rad = angleDeg * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const edge = iconSize / 2 + 10;

  if (cos > 0.35) return { x: edge, y: 0, originX: '0%', originY: '-50%' };
  if (cos < -0.35) return { x: -edge, y: 0, originX: '-100%', originY: '-50%' };
  if (sin < 0) return { x: 0, y: -edge, originX: '-50%', originY: '-100%' };
  return { x: 0, y: edge, originX: '-50%', originY: '0%' };
}

/**
 * Destaque binário: a fatia apontada acende e todas as outras ficam iguais entre si. Variar a
 * presença pela distância angular fazia os vizinhos parecerem parcialmente selecionados.
 *
 * A opacidade do contentor NÃO é o canal de "não selecionado". Cada fatia traz o seu próprio fundo,
 * e o alfa multiplica esse fundo também: a 0.5 o tile deixava de ser um objeto e passava a ser uma
 * mancha sobre o desktop — pior ainda com ícone monocromático (workspaces) e wallpaper claro, onde
 * o glifo branco a meio alfa desaparecia. Aqui a opacidade só dá o afastamento mínimo; a seleção
 * lê-se por cor, anel e escala, que são sinais que não destroem o contraste do que está por baixo.
 */
function getSlicePresence(distance: number | null) {
  if (distance === null) return { opacity: 0.96, scale: 1 };
  if (distance === 0) return { opacity: 1, scale: 1.06 };
  return { opacity: 0.9, scale: 1 };
}

/**
 * Alinha um valor à grelha de pixels FÍSICOS do monitor. A roda posiciona cada fatia por
 * trigonometria, o que produz coordenadas fracionárias (`84.0, 48.5`). Um tile tem três contornos
 * a 1px — borda clara, anel escuro exterior e luz interior — e em meio-pixel cada um deles é
 * espalhado por dois pixels físicos com alfas diferentes: é isso que se lê como aresta "à mão",
 * com rebarba e pontos irregulares. Com escala do Windows a 125/150% o erro nem sequer é de meio
 * pixel CSS, por isso não basta arredondar — tem de se dividir pelo `devicePixelRatio`.
 */
/**
 * Retângulo arredondado que COMEÇA no topo, ao centro.
 *
 * O caminho implícito de um `<rect>` arranca no fim do arco superior esquerdo, ou seja deslocado
 * para a direita pelo raio do canto — o anel de progresso começava a encher num ponto arbitrário
 * da aresta de cima, e o desvio mudava com o tamanho do ícone porque o raio também muda. Um
 * relógio que não começa às doze lê-se como um erro.
 */
export function roundedRectPathFromTop(size: number, inset: number, radius: number): string {
  const near = inset;
  const far = size - inset;
  const mid = size / 2;
  const r = Math.max(0, Math.min(radius, (far - near) / 2));
  return [
    `M ${mid} ${near}`,
    `L ${far - r} ${near}`,
    `A ${r} ${r} 0 0 1 ${far} ${near + r}`,
    `L ${far} ${far - r}`,
    `A ${r} ${r} 0 0 1 ${far - r} ${far}`,
    `L ${near + r} ${far}`,
    `A ${r} ${r} 0 0 1 ${near} ${far - r}`,
    `L ${near} ${near + r}`,
    `A ${r} ${r} 0 0 1 ${near + r} ${near}`,
    'Z',
  ].join(' ');
}

export function snapToDevicePixel(value: number): number {
  const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.round(value * ratio) / ratio;
}

/** Mantém ícones e rótulos legíveis quando o utilizador escolhe um hover claro ou escuro. */
function getReadableForeground(background: string): '#000000' | '#FFFFFF' {
  const hex = background.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#000000';
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.56 ? '#000000' : '#FFFFFF';
}

function normalizeHoverColor(value?: string): string {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value!.toUpperCase() : '#FFFFFF';
}

const RadialMenuItem = React.memo(({
  app,
  index,
  isActive,
  angularDistance,
  actualMenuRadius,
  actualIconSize,
  totalApps,
  backdropOpacity,
  hoverColor,
  showLabels,
  alwaysShowAppLabels,
  folderStackLength,
  bloom,
  shortcutHint,
  dwellMs,
  dwellKey,
  onClick,
}: RadialMenuItemProps) => {
  const Icon = getIcon(app.iconName);
  const [remoteIconFailed, setRemoteIconFailed] = React.useState(false);
  React.useEffect(() => {
    setRemoteIconFailed(false);
  }, [app.customIconUrl]);
  const sliceAngle = 360 / totalApps;
  const angleDeg = (index * sliceAngle) - 90;
  const angleRad = angleDeg * (Math.PI / 180);
  const pos = {
    x: actualMenuRadius * Math.cos(angleRad),
    y: actualMenuRadius * Math.sin(angleRad),
  };

  // PERF FIX #2: useMemo instead of IIFE so this only recomputes when app.command/label/iconSource change
  const shouldUseCustomIcon = React.useMemo(() => {
    const LUCIDE_ICON_EXCEPTIONS = [
      'Microsoft.WindowsTerminal',
      'WindowsTerminal',
      'Terminal',
      'cmd.exe',
      'powershell.exe'
    ];
    const isException = LUCIDE_ICON_EXCEPTIONS.some(exception =>
      app.command?.toLowerCase().includes(exception.toLowerCase()) ||
      app.label?.toLowerCase().includes(exception.toLowerCase())
    );
    if (isException) return false;
    return app.iconSource === 'native' && !!app.customIconUrl;
  }, [app.command, app.label, app.iconSource, app.customIconUrl]);

  const labelPlacement = React.useMemo(
    () => getLabelPlacement(angleDeg, actualIconSize),
    [angleDeg, actualIconSize],
  );

  const hasRasterIcon = Boolean(app.customIconUrl) && !remoteIconFailed;
  /**
   * Ícone por resolver: item nativo, com comando, mas ainda sem imagem. Acontece logo depois de
   * uma restauração ou da primeira descoberta, enquanto o PowerShell extrai os ícones — e um
   * glifo genérico nesse momento parece um ícone errado, não um ícone em falta.
   */
  const iconPending = app.iconSource === 'native' && !app.customIconUrl && Boolean(app.command);
  /**
   * O indicador tem prazo. Um ícone que nunca vai resolver — alvo inválido, app desinstalada —
   * deixava a fatia a girar indefinidamente, e uma espera sem fim lê-se pior do que um ícone
   * genérico. Passados 10 segundos, mostra-se o glifo e a fatia fica utilizável.
   */
  const [pendingExpired, setPendingExpired] = React.useState(false);
  React.useEffect(() => {
    if (!iconPending) {
      setPendingExpired(false);
      return;
    }
    const timer = window.setTimeout(() => setPendingExpired(true), 10000);
    return () => window.clearTimeout(timer);
  }, [iconPending, app.command]);
  const presence = getSlicePresence(angularDistance);
  const activeForeground = getReadableForeground(hoverColor);
  /**
   * Anel concêntrico com o tile. O que tem de ser concêntrico é a LINHA MÉDIA do traço, não a sua
   * aresta exterior: o retângulo está encolhido 1.25 de cada lado (metade dos 2.5 de traço), por
   * isso a linha média corre 5.75px por fora do tile e o raio certo é 18 + 5.75, não 18 + 7.
   * O limite também se mede contra o lado REAL do retângulo — contra a caixa do SVG, um ícone no
   * mínimo caía no recorte silencioso do browser, que é exatamente o que este limite evita.
   */
  const dwellRingSize = actualIconSize + 14;
  const dwellRingInset = (dwellRingSize - actualIconSize) / 2 - 1.25;
  const dwellRingRadius = Math.min(18 + dwellRingInset, (dwellRingSize - 2.5) / 2);
  const dwellRingPath = roundedRectPathFromTop(dwellRingSize, 1.25, dwellRingRadius);

  return (
    <div
      /**
       * O invólucro NUNCA recebe cliques. A sua caixa de layout fica na origem do ponto da fatia e
       * cresce para a direita e para baixo, enquanto o tile é PINTADO centrado nesse ponto (o
       * `-translate-*-1/2` é transform, não layout). A caixa fica meio tile fora do sítio, e a da
       * fatia de cima à esquerda chega a invadir o centro da roda — clicar no canto superior
       * esquerdo do hub caía nela, sempre na mesma, e executava-a. Quem recebe o clique passa a
       * ser o tile, cuja área de acerto acompanha o transform e portanto coincide com o desenho.
       */
      className="zn-radial-slice absolute top-0 left-0 pointer-events-none"
      style={{
        /* Um único transform por fatia: posição + presença. O hover só troca este valor. */
        ['--zn-tf' as string]: bloom
          ? `translate3d(${snapToDevicePixel(pos.x)}px, ${snapToDevicePixel(pos.y)}px, 0) scale(${presence.scale})`
          : 'translate3d(0px, 0px, 0) scale(0.2)',
        ['--zn-op' as string]: bloom ? presence.opacity : 0,
        zIndex: isActive ? 200 : 100,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick(app);
      }}
    >
      <div className="relative flex items-center justify-center -translate-x-1/2 -translate-y-1/2">
        {/*
          Arco de mira sustentada. Só aparece em `startDwell`, a partir de uma mira RESOLVIDA DE
          NOVO nesse instante, e tanto o `startDwell` como o `fireDwell` revalidam a terna
          `{nível, índice, id}` — um antes de desenhar, o outro antes de abrir. É por isso que o
          que o anel mostra e o que vai executar não podem divergir: acender um ícone e abrir outro
          é o que o comentário do `resolveAimAtPoint` chama o pior defeito possível num lançador.

          `pathLength={1}` normaliza o perímetro: o traço anima de 1 para 0 sem aritmética nenhuma
          sobre o comprimento real do caminho, que muda com o tamanho do ícone.
        */}
        {dwellMs != null && (
          <svg
            key={dwellKey}
            /**
             * `z-10`, por baixo do tile. O anel corre inteiramente FORA do quadrado do tile, por
             * isso nada dele se perde — e por cima passava a cortar o selo de pasta, que vive no
             * `z-30` de dentro do invólucro e é maior do que a folga entre o tile e o anel.
             */
            className="absolute pointer-events-none z-10"
            /**
             * Centragem explícita. Um filho absoluto de um contentor flex herda a posição estática
             * do alinhamento do flex, o que já o centraria — mas depender disso deixa o anel a
             * meio tile de distância se alguém trocar `justify-center` por outra coisa.
             */
            style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
            width={dwellRingSize}
            height={dwellRingSize}
            viewBox={`0 0 ${dwellRingSize} ${dwellRingSize}`}
            shapeRendering="geometricPrecision"
            aria-hidden
          >
            {/*
              Três camadas, pela mesma razão que o tile tem contorno duplo: o anel corre FORA da
              placa opaca do tile, portanto o que está por trás dele é o escurecimento e, através
              dele, um wallpaper que não controlamos. Sozinho, branco a 18% não se lê sobre fundo
              claro — e um anel de progresso invisível é a única coisa que avisa que algo está
              prestes a abrir sozinho.

              Invólucro escuro OPACO por baixo (o mesmo papel do `0 0 0 1px rgba(0,0,0,.5)` do
              tile), depois a pista, depois o arco. A pista pode ser translúcida porque já tem o
              invólucro por baixo — não é o alfa a fazer de canal de desênfase.
            */}
            <path
              d={dwellRingPath}
              fill="none"
              stroke="rgba(0,0,0,0.55)"
              strokeWidth={4.5}
            />
            <path
              d={dwellRingPath}
              fill="none"
              stroke="rgba(255,255,255,0.30)"
              strokeWidth={2.5}
            />
            <path
              className="zn-dwell-arc"
              d={dwellRingPath}
              fill="none"
              stroke={hoverColor}
              strokeWidth={2.5}
              pathLength={1}
              style={{ ['--zn-dwell-ms' as string]: `${dwellMs}ms` }}
            />
          </svg>
        )}

        {/* WRAPPER FOR BADGE & MASKED CONTENT */}
        <div
          className={`relative z-20 ${bloom ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none cursor-default'}`}
          style={{
            width: `${actualIconSize}px`,
            height: `${actualIconSize}px`,
          }}
        >
          {/* INNER MASKED CONTAINER (Overflow Hidden) */}
          <div
            /**
             * `overflow-hidden` liga uma máscara arredondada, e o Chromium suaviza máscaras pior
             * que bordas — os cantos ficam serrilhados sobre uma janela transparente. A máscara só
             * existe para cortar ícones rasterizados, portanto só se liga quando há um.
             */
            className={`w-full h-full rounded-[18px] flex items-center justify-center transition-[background-color,border-color,box-shadow] duration-150 relative ${hasRasterIcon ? 'overflow-hidden' : ''}`}
            style={{
              /**
               * O tile precisa de se sustentar sozinho sobre um desktop que não controlamos: o
               * fundo é quase opaco e a borda em repouso é forte o suficiente para o recortar sem
               * depender do escurecimento global nem do contraste do wallpaper.
               */
              /**
               * Fundo TOTALMENTE opaco. A janela é `transparent: true`: com alfa < 1 cada pixel é
               * pré-multiplicado e requantizado a 8 bits ao ser composto pelo Windows. Nos lados
               * retos a cobertura é 0% ou 100% e o erro não existe; na curva os pixels têm
               * cobertura parcial e o arredondamento cai ora para cima ora para baixo — a linha
               * fica irregular, com pontos mais claros e outros a desaparecer. A 0.985 a diferença
               * visual para opaco é nula, mas o custo na aresta não é.
               */
              backgroundColor: isActive
                ? hoverColor
                : `rgb(${12 + Math.round(backdropOpacity * 10)}, ${12 + Math.round(backdropOpacity * 10)}, ${12 + Math.round(backdropOpacity * 10)})`,
              border: isActive ? `1px solid ${hoverColor}` : `1px solid rgba(255,255,255,${0.28 + backdropOpacity * 0.08})`,
              color: isActive ? activeForeground : '#fff',
              /**
               * Contorno duplo: borda clara por dentro + anel escuro de 1px por fora.
               * O tile separa-se do desktop sozinho — em fundo claro lê-se o anel, em fundo
               * escuro lê-se a borda — sem depender do escurecimento global.
               */
              /* `inset` no topo = uma única fonte de luz para toda a roda: os tiles lêem-se como objetos. */
              boxShadow: isActive
                ? `0 0 0 1px rgba(0,0,0,0.45), 0 0 0 5px ${hoverColor}24, 0 12px 28px rgba(0,0,0,0.5)`
                : 'inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(0,0,0,0.5), 0 8px 22px rgba(0,0,0,0.42)',
            }}
          >
            {/* Icon Container: Show either native icon OR vector icon, not both */}
            <div className="w-full h-full flex items-center justify-center relative">
              {app.customIconUrl && !remoteIconFailed ? (
                /* Native / remote favicon */
                <SmartIcon
                  src={app.customIconUrl!}
                  alt={app.label}
                  className="object-contain relative z-10"
                  size={actualIconSize}
                  referenceScale={0.88}
                  onError={() => setRemoteIconFailed(true)}
                />
              ) : (
                /* Vector Icon (Only when no custom icon) */
                /**
                 * Glifo monocromático (workspaces, atalhos sem ícone nativo) não tem cor própria a
                 * segurá-lo: a legibilidade vem toda do traço, por isso é mais grosso que o de um
                 * ícone de app, que chega com a sua própria forma e cor.
                 */
                <Icon size={Math.round(actualIconSize * 0.55)} strokeWidth={1.75} />
              )}

              {/* A wait is said with an indicator, not with an icon that is not the app's. */}
              {iconPending && !pendingExpired && !hasRasterIcon && (
                <span
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ background: 'rgba(6,7,9,0.72)' }}
                  aria-label="Fetching icon"
                >
                  <span
                    className="rounded-full border-2 border-white/15 border-t-white/70 animate-spin"
                    style={{
                      width: Math.round(actualIconSize * 0.3),
                      height: Math.round(actualIconSize * 0.3),
                    }}
                  />
                </span>
              )}
            </div>
          </div>

          {/* FOLDER BADGE (Outside Mask, Inside Wrapper) */}
          {app.type === 'folder' && (
            <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center border-2 border-[#1A1A1A] z-30 shadow-md">
              <div className="w-1 h-1 bg-black rounded-full" />
              <div className="w-1 h-1 bg-black rounded-full ml-0.5" />
            </div>
          )}
        </div>

        {showLabels && (
          <div
            className="zn-radial-label absolute pointer-events-none z-30"
            style={{
              left: '50%',
              top: '50%',
              /* Âncora (fica fora da roda) + deslocamento + escala num só transform. */
              ['--zn-tf' as string]:
                `translate(${labelPlacement.originX}, ${labelPlacement.originY})` +
                ` translate3d(${snapToDevicePixel(labelPlacement.x)}px, ${snapToDevicePixel(labelPlacement.y)}px, 0)` +
                ` scale(${alwaysShowAppLabels ? (isActive ? 1 : 0.94) : (isActive ? 1 : 0.9)})`,
              /** Rótulo também tem plate próprio: dimmá-lo a 0.72 apagava o texto, não o destaque. */
              ['--zn-op' as string]: alwaysShowAppLabels
                ? (isActive ? 1 : 0.9)
                : (isActive ? 1 : 0),
            }}
          >
            <div
              className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-full whitespace-nowrap"
              style={{
                background: isActive ? hoverColor : 'rgba(6,7,9,0.95)',
                border: `1px solid ${isActive ? hoverColor : 'rgba(255,255,255,0.2)'}`,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.45), 0 6px 18px rgba(0,0,0,0.45)',
                paddingRight: shortcutHint ? undefined : '0.75rem',
              }}
            >
              <span
                className="text-[12px] leading-none"
                style={{
                  color: isActive ? activeForeground : 'rgba(255,255,255,0.7)',
                  fontFamily: 'var(--font-radial)',
                  fontWeight: 500,
                  letterSpacing: '-0.005em',
                }}
              >
                {app.label}
              </span>
              {shortcutHint && (
                <span
                  className="text-[10px] leading-none px-1.5 py-1 rounded-[5px]"
                  style={{
                    color: isActive ? activeForeground : 'rgba(255,255,255,0.5)',
                    background: isActive
                      ? (activeForeground === '#000000' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.14)')
                      : 'rgba(255,255,255,0.10)',
                  }}
                >
                  {shortcutHint}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

const RadialMenuInner: React.FC<RadialMenuProps> = ({
  isOpen,
  position,
  viewportSize,
  onClose,
  apps,
  config,
  triggerSource = 'shortcut',
  onWorkspaceSwitch,
  currentWorkspace,
  animationReady = true,
  updateReady = false,
  discoveryPhase = 'idle',
}) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isCenterActive, setIsCenterActive] = useState(false);
  const [hasMoved, setHasMoved] = useState(false);
  /**
   * "Esta roda começou a fechar". Escrito SINCRONAMENTE por todos os caminhos de cancelamento —
   * Escape, botão direito, menu de contexto e o evento de toggle do trigger — antes do `onClose`.
   *
   * Existe porque `!stateRef.current.isOpen` chega tarde: passa por `onClose` → `setIsMenuOpen`
   * do App → batching do React → render. Um clique não sofre com isso (o listener já foi
   * desmontado), mas um temporizador de mira sustentada sobrevive a essa janela e dispararia
   * contra uma roda que o utilizador acabou de mandar embora. Antes disto a ref existia mas nunca
   * era lida: descrevia uma proteção que não estava lá.
   */
  const closingRef = useRef(false);
  const isCenterActiveRef = useRef(isCenterActive);
  const openingTimeRef = useRef<number>(0);
  /**
   * A abertura é uma transição CSS, não uma animação JS: as fatias montam colapsadas no hub e
   * um único `rAF` depois passam ao estado final — o compositor faz o resto. Uma re-renderização
   * por abertura (e por nível), em vez de uma mola por ícone a cada frame.
   */
  const [bloom, setBloom] = useState(false);

  /**
   * Motor da mira sustentada.
   *
   * Regra de desenho que governa tudo o que está aqui: ARMAR É UM FACTO OBSERVADO. O gesto só
   * passa a poder executar depois de um `mousemove` REAL cair a mais de `INSTANT_ARM_DISPLACEMENT_PX`
   * de uma referência posta por um `mousemove` real anterior. Nada é inferido do estado da roda,
   * porque o estado perigoso — ponteiro parado longe do centro, com uma fatia já acesa — é
   * indistinguível de uma mira deliberada se não se olhar para o movimento.
   */
  const levelGenRef = useRef(0);
  const dwellArmedRef = useRef(false);
  const dwellBaselineRef = useRef<{ x: number; y: number } | null>(null);
  const dwellTimerRef = useRef<number | null>(null);
  const dwellTargetRef = useRef<{ gen: number; index: number; itemId: string } | null>(null);
  /** Alvo à espera de que a mão assente; ainda não conta nem desenha nada. */
  const dwellPendingRef = useRef<{ gen: number; index: number; itemId: string } | null>(null);
  const dwellSettleTimerRef = useRef<number | null>(null);
  /** Ponto onde a tentativa atual começou — é contra ele que se mede se o ponteiro parou. */
  const dwellAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const dwellStartedAtRef = useRef(0);
  const paintReadyAtRef = useRef<number | null>(null);
  const quarantineUntilRef = useRef(0);
  const dwellSeqRef = useRef(0);
  /**
   * O efeito de interação regista os listeners uma vez por abertura, e o motor está definido
   * depois dele (precisa do `handleAppClick`). Uma ref é o que liga os dois sem inverter a ordem
   * do ficheiro nem recriar listeners a cada render.
   */
  const armAndTrackDwellRef = useRef<
    (point: { x: number; y: number }, aim: { isCenter: boolean; index: number | null }) => void
  >(() => {});
  /** Um commit por início/cancelamento de arco. Zero por frame: a animação é CSS. */
  const [dwellTick, setDwellTick] = useState<{ index: number; key: number } | null>(null);

  /**
   * Estado da mira por direção. `gestureVectorRef` é o deslocamento acumulado desde o centro —
   * o ponteiro virtual que a roda mira; `gestureSampleRef` é a última posição REAL, só para
   * calcular o delta seguinte. Zero em ambos significa "ainda não há direção": nada aceso.
   */
  const gestureVectorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const gestureSampleRef = useRef<{ x: number; y: number } | null>(null);
  /** Instante em que se pediu um estacionamento; `0` quando não há nenhum por aterrar. */
  const gestureParkAtRef = useRef(0);

  const resetDirectionGesture = useCallback((expectPark: boolean) => {
    gestureVectorRef.current = { x: 0, y: 0 };
    gestureSampleRef.current = null;
    gestureParkAtRef.current = expectPark ? Date.now() : 0;
  }, []);

  useEffect(() => {
    isCenterActiveRef.current = isCenterActive;
  }, [isCenterActive]);

  /** Mata o temporizador e o arco. NÃO desarma: estar no hub cancela a contagem, não o gesto. */
  const cancelDwell = useCallback(() => {
    if (dwellTimerRef.current !== null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    if (dwellSettleTimerRef.current !== null) {
      window.clearTimeout(dwellSettleTimerRef.current);
      dwellSettleTimerRef.current = null;
    }
    dwellPendingRef.current = null;
    dwellAnchorRef.current = null;
    /** O commit só acontece se havia mesmo um arco no ecrã — chamadas repetidas não custam nada. */
    if (dwellTargetRef.current !== null) {
      dwellTargetRef.current = null;
      setDwellTick(null);
    }
  }, []);

  /** Volta ao estado em que executar exige um deslocamento novo e observado. */
  const disarmDwell = useCallback(() => {
    cancelDwell();
    dwellArmedRef.current = false;
    dwellBaselineRef.current = null;
  }, [cancelDwell]);

  /** Reposição total — abrir e fechar. */
  const resetDwell = useCallback(() => {
    disarmDwell();
    paintReadyAtRef.current = null;
    quarantineUntilRef.current = 0;
  }, [disarmDwell]);

  // Folder Navigation State
  // Seeded with the root level, not the raw app list: in picker mode the two
  // differ, and mounting with the wrong one costs a frame of the wrong wheel.
  const [rawLevelApps, setCurrentLevelApps] = useState<AppItem[]>(() => getRootRadialApps(config, apps));
  /**
   * Type-ahead: what has been typed since the wheel opened, and the level narrowed to match.
   *
   * Past about a dozen shortcuts a slice is 30° or less and aiming stops being the skill it was —
   * the wheel that made eight targets effortless makes twenty a lottery. Typing narrows the ring
   * until the remaining slices are wide again; aiming still does the launching.
   *
   * The narrowing is applied HERE, between the state and everything that reads it, and that is the
   * whole implementation. Layout, hit-testing, the dwell timer, the folder stack and the render all
   * read `currentLevelApps`; none of them needs to know a filter exists, and none of them can fall
   * out of step with one. The twenty-six places that SET the level are equally untouched — they
   * write the level, not the view of it.
   */
  const [typeAhead, setTypeAhead] = useState('');
  const currentLevelApps = React.useMemo(
    () => filterRadialApps(rawLevelApps, typeAhead),
    [rawLevelApps, typeAhead],
  );
  const typeAheadRef = useRef(typeAhead);
  typeAheadRef.current = typeAhead;
  /** A level change is a new set of names, so whatever was typed no longer means anything. */
  useEffect(() => { setTypeAhead(''); }, [rawLevelApps]);
  const [folderStack, setFolderStack] = useState<{ label: string, apps: AppItem[] }[]>([]);
  const [isLoadingRecents, setIsLoadingRecents] = useState(false);
  /**
   * Uma busca de MRU em curso não muda o nível: as fatias do nível ANTERIOR continuam à vista e o
   * efeito de mudança de nível não corre, portanto nada desarma sozinho. Enquanto o hub roda,
   * ninguém executa nada por tempo — o utilizador já escolheu e está à espera.
   */
  const isLoadingRecentsRef = useRef(isLoadingRecents);
  isLoadingRecentsRef.current = isLoadingRecents;

  const menuRef = useRef<HTMLDivElement>(null);
  const configRef = useRef(config);
  configRef.current = config;
  /**
   * O tempo escolhido é o TOTAL até abrir, e é repartido entre as duas fases: assentar a mão e
   * depois contar. Assentar leva `DWELL_SETTLE_MS`, mas nunca mais do que o orçamento inteiro —
   * daí o `min`.
   *
   * Antes havia aqui um piso, porque o mínimo das definições (250ms) era maior que a fase de
   * assentar e nenhuma repartição podia dar negativo. Com a espera opcional isso deixou de ser
   * verdade: a 0ms um piso significaria a roda a prometer "instantâneo" e a esperar 90ms na mesma,
   * e a 50ms significaria esperar 90. Repartir em vez de aplicar um piso mantém o número das
   * definições honesto em todo o intervalo — a zero, as duas fases medem zero e a direção executa
   * assim que se compromete.
   */
  const dwellMsRef = useRef(0);
  dwellMsRef.current = clampDwellMs(config.radialInstantDwellMs);
  const dwellSettleMsRef = useRef(0);
  dwellSettleMsRef.current = Math.min(DWELL_SETTLE_MS, dwellMsRef.current);
  const dwellRunMsRef = useRef(0);
  dwellRunMsRef.current = Math.max(0, dwellMsRef.current - dwellSettleMsRef.current);
  /**
   * O interruptor da execução sem clique liga as DUAS metades do mesmo gesto: mirar por direção
   * com o ponteiro escondido, e executar ao fim do tempo de mira. Uma só expressão para as duas,
   * porque uma roda que esconde o cursor e continua a mirar por posição não tem como ser usada.
   *
   * O efeito de interação depende só de `[isOpen]`, portanto captura os seus callbacks uma vez por
   * abertura — o que muda com as definições tem de lá chegar por ref, não por closure.
   *
   * `swipe` é lido como desligado de propósito: o valor está reservado no tipo, não implementado.
   * MMB em modo segurar fica de fora porque já executa ao largar, e a sua mira vem da sondagem do
   * main (`mmb-cursor`), cujo primeiro ponto é onde o botão foi premido — alimentar um
   * temporizador com isso seria disparar num tique da sonda, não numa intenção. É também por isso
   * que o main não estaciona o cursor nesse caminho.
   */
  const directionMode =
    config.radialInstantActivate === 'dwell' && triggerSource !== 'mmb';
  const directionModeRef = useRef(false);
  directionModeRef.current = directionMode;
  const dwellEnabledRef = useRef(false);
  dwellEnabledRef.current = directionMode;
  /** Deslocamento que uma direção precisa para acender a fatia desse lado. */
  const directionCommitRef = useRef(0);
  directionCommitRef.current = directionCommitPx(config.radialInstantSensitivity);
  /** A janela do radial: é dela que sai o raio a partir do qual o cursor real é reencostado. */
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const radialHoverColor = normalizeHoverColor(config.radialHoverColor);
  const radialHoverForeground = getReadableForeground(radialHoverColor);
  const iconSizePx = config.iconSize || 64;
  const minGap = config.appSpacing || 0;
  const numberOfApps = currentLevelApps.length;

  // Intelligent Layout Calibration
  const { actualMenuRadius, actualIconSize } = React.useMemo(
    () =>
      computeRadialLayout({
        numberOfApps,
        iconSizePx,
        minGap,
        menuRadius: config.menuRadius,
        activationThreshold: config.activationThreshold,
        viewportSize,
      }),
    [config.menuRadius, config.activationThreshold, numberOfApps, iconSizePx, minGap, viewportSize.width, viewportSize.height],
  );

  // Sync root radial when workspace config / active workspace apps change while
  // menu stays open. Also pre-paint, for the same reason as the open reset:
  // in picker mode the root level is a synthetic workspace list, not `apps`, so
  // a passive effect showed one wheel and replaced it on the next frame.
  useLayoutEffect(() => {
    if (!isOpen || folderStack.length > 0) return;
    const next = getRootRadialApps(config, apps);
    setCurrentLevelApps((prev) => (sameRadialLevel(prev, next) ? prev : next));
  }, [isOpen, folderStack.length, apps, config.workspaceSwitchMode, config.workspaces, config]);

  /**
   * Dispara a saída das fatias: montam colapsadas no hub e o frame seguinte assume o estado final.
   * Corre também a cada troca de nível (pasta / workspace), por isso o mesmo movimento serve os dois.
   */
  useLayoutEffect(() => {
    if (!isOpen) {
      setBloom(false);
      paintReadyAtRef.current = null;
      return;
    }
    setBloom(false);
    /**
     * Marco de "a roda está mesmo à vista". As dependências deste efeito incluem
     * `currentLevelApps`, portanto a janela de assentamento de `INSTANT_ARM_DELAY_MS` é reganha a
     * cada NÍVEL e não só a cada abertura — que é exatamente a garantia de que uma execução por
     * tempo precisa quando uma pasta troca as fatias debaixo de um ponteiro parado.
     */
    paintReadyAtRef.current = null;
    cancelDwell();
    if (!animationReady) return;
    const raf = requestAnimationFrame(() => {
      paintReadyAtRef.current = Date.now();
      setBloom(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, currentLevelApps, animationReady, cancelDwell]);

  /** Lista vazia: manter foco visual no centro (volta / centro) — antes o rato não atualizava o hub. */
  useEffect(() => {
    if (!isOpen || currentLevelApps.length > 0) return;
    setActiveIndex(null);
    setIsCenterActive(true);
  }, [isOpen, currentLevelApps.length]);

  // The root hub carries the Rovyl identity; deeper levels keep the Back affordance.
  const isRoot = folderStack.length === 0;
  const centerLabel = !isRoot ? uiString('menu.back') : (config.centerButton?.label || uiString('menu.center'));


  // Reset state when menu opens.
  // This runs before paint: as a passive effect it landed one frame late, so
  // reopening after browsing into a folder painted the previous level first and
  // only then swapped to the root — read as the wheel rendering twice, the
  // first as a flash. The wheel it flashed had a different item count, hence a
  // different radius and icon size, which made the swap impossible to miss.
  useLayoutEffect(() => {
    if (isOpen) {
      openingTimeRef.current = Date.now();
      /** Abertura nova: nada herdado do gesto anterior pode executar seja o que for. */
      resetDwell();
      closingRef.current = false;
      levelGenRef.current += 1;
      setHasMoved(false);
      setIsCenterActive(false);
      setFolderStack([]);
      setCurrentLevelApps(getRootRadialApps(configRef.current, apps));
      setActiveIndex(null);
      setBloom(false);

      // CRITICAL: Focus window and body to ensure keyboard events are captured
      // This is especially important when menu is opened via MMB or after dashboard interaction
      window.focus();
      document.body.focus();
      if (menuRef.current) {
        menuRef.current.focus();
      }
    }
  }, [isOpen]);

  // Stable Interaction Logic (Performance Optimization)
  // We use refs to access current state inside stable event listeners
  // to avoid destroying/recreating listeners on every hover (index change).
  /**
   * Tamanho do centro: constante, vindo do `iconSize` das definições e NÃO do tamanho calculado
   * das fatias. O tamanho das fatias sobe com a quantidade de itens, portanto o hub encolhia num
   * workspace com 3 apps e crescia noutro com 8 — o mesmo botão, dois tamanhos, e o alvo mudava
   * de sítio conforme o workspace. Só encolhe se o anel não tiver espaço para ele.
   *
   * Diâmetro par: o hub centra-se com `translate(-50%)`, e metade de um ímpar cai em meio-pixel.
   */
  const hubDiameter = Math.max(
    32,
    Math.min(
      /**
       * O tamanho compacto — o que a roda tinha com poucas apps, que é o que se lê melhor. A rampa
       * de densidade (0.82 → 1.0) fica reservada às fatias; o centro não engorda com o número de
       * itens, senão o mesmo botão tem um tamanho por workspace.
       */
      Math.round((config.iconSize || 64) * 0.82 * 1.2),
      Math.round((actualMenuRadius - actualIconSize / 2 - 10) * 2),
    ),
  ) & ~1;

  /** O alvo cobre a caixa do hub já com a escala do estado ativo, mais 4px de folga. */
  const hubHitSize = Math.round(hubDiameter * 1.06) + 4;
  /**
   * Zona de cancelamento — tem de cobrir a CAIXA do hub, não a circunferência.
   *
   * O hub é um `<div>` quadrado com `rounded-full`, e o `border-radius` também recorta o teste de
   * acerto: um clique no canto da caixa cai fora do círculo, atravessa para o overlay e vira
   * direção. Só que esse canto está a `r × √2` do centro (41% mais longe que a aresta do círculo)
   * e o utilizador lê-o como "dentro do botão" — daí clicar no canto superior esquerdo do botão de
   * voltar e executar uma fatia. O `× 1.06` acompanha a escala que o hub ganha quando está ativo,
   * que é exatamente o estado em que este clique acontece.
   */
  const deadZoneRadius = Math.max(
    config.activationThreshold ?? 60,
    Math.ceil((hubDiameter / 2) * 1.06 * Math.SQRT2) + 4,
  );

  /**
   * Raio a partir do qual a mira deixa de ser "centro" e passa a ser uma fatia.
   *
   * Por direção quem manda é a sensibilidade, e não a zona de cancelamento: a zona morta é o
   * tamanho do BOTÃO do meio — mede um alvo de clique, e num gesto sem clique nem sequer há
   * ponteiro para lá acertar. Mantê-la aqui tornava a sensibilidade alta indistinguível da média,
   * porque nada acenderia antes dos ~60px do hub.
   */
  const aimGateRef = useRef(deadZoneRadius);
  aimGateRef.current = directionMode ? directionCommitRef.current : deadZoneRadius;

  /**
   * Diagnóstico da confirmação. Fica no log de persistência (`rovyl-persistence.log`) e diz, para
   * cada gesto que executa algo, de onde veio a decisão: ponto, centro assumido, distância, zona
   * morta e o item escolhido. Sem isto, um "abriu o que eu não cliquei" é impossível de atribuir.
   */
  const logRadialConfirm = useCallback(
    (
      origin: 'click' | 'mmb-release' | 'dwell',
      point: { x: number; y: number } | null,
      aim: { isCenter: boolean; index: number | null },
    ) => {
      const { position, currentLevelApps } = stateRef.current;
      const deadZoneRadius = aimGateRef.current;
      const distance = point
        ? Math.round(Math.hypot(point.x - position.x, point.y - position.y))
        : -1;
      const label = aim.index !== null ? currentLevelApps[aim.index]?.label ?? '?' : '—';
      /**
       * Execução por tempo não tem gesto humano a que se agarrar num relato — sem estes campos,
       * um "abriu o que eu não apontei" é impossível de distinguir de um clique mal-apontado.
       */
      const dwellForensics =
        origin === 'dwell'
          ? ` base=${
              dwellBaselineRef.current
                ? `${Math.round(dwellBaselineRef.current.x)},${Math.round(dwellBaselineRef.current.y)}`
                : 'null'
            } espera=${Date.now() - dwellStartedAtRef.current}ms nivel=${levelGenRef.current} ` +
            `alvo=${dwellTargetRef.current?.itemId ?? '?'}`
          : '';
      window.electron?.savePersistenceLog?.(
        `[RadialConfirm] ${origin} ponto=${point ? `${Math.round(point.x)},${Math.round(point.y)}` : 'null'} ` +
          `centro=${Math.round(position.x)},${Math.round(position.y)} dist=${distance} zonaMorta=${Math.round(deadZoneRadius)} ` +
          `→ ${aim.isCenter ? 'CENTRO' : `fatia ${aim.index} (${label})`}${dwellForensics}`,
      );
    },
    [],
  );

  /** Ação do centro: voltar um nível dentro de uma pasta, fechar na raiz. */
  const handleCenterActivate = useCallback(() => {
    /** Clique reflexo logo a seguir a uma execução por tempo — e o hub já mudou de nível. */
    if (Date.now() < quarantineUntilRef.current) return;
    const { folderStack, currentLevelApps: _ignored, apps, config, onClose } = stateRef.current;
    if (folderStack.length > 0) {
      const newStack = folderStack.slice(0, -1);
      setFolderStack(newStack);
      setCurrentLevelApps(
        newStack.length === 0 ? getRootRadialApps(config, apps) : newStack[newStack.length - 1].apps,
      );
      setHasMoved(false);
      setIsCenterActive(false);
      return;
    }
    onClose('__CENTER__');
  }, []);

  const stateRef = useRef({
    isOpen,
    position,
    activeIndex,
    onClose,
    currentLevelApps,
    config,
    isCenterActive,
    hasMoved,
    folderStack,
    apps,
    actualMenuRadius,
    actualIconSize,
    deadZoneRadius,
  });

  /** Layout: pointer math uses `position` — must match props before paint or first rAF sees stale center (fullscreen vs ilha small). */
  useLayoutEffect(() => {
    stateRef.current = {
      isOpen,
      position,
      activeIndex,
      onClose,
      currentLevelApps,
      config,
      isCenterActive,
      hasMoved,
      folderStack,
      apps,
      actualMenuRadius,
      actualIconSize,
      deadZoneRadius,
    };
  }, [isOpen, position, activeIndex, onClose, currentLevelApps, config, isCenterActive, hasMoved, folderStack, apps, actualMenuRadius, actualIconSize, deadZoneRadius]);

  /**
   * Ponto que a roda MIRA, escrito no próprio evento — sem passar por render. Por direção é o
   * ponteiro virtual (centro + vetor do gesto); nos outros modos é a posição real do cursor.
   */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * Onde a MÃO está, sempre real. A mira sustentada pergunta "a mão parou?", e por direção o
   * ponteiro virtual satura no teto do vetor: continuar a empurrar deixava-o imóvel e a contagem
   * concluía que a mão tinha assentado quando ela ainda ia a meio do gesto.
   */
  const lastAnchorPointRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * Traduz uma amostra real no ponto que a roda deve mirar.
   *
   * Fora do modo por direção é a identidade. Dentro dele acumula o delta desta amostra no vetor do
   * gesto, corta o salto do estacionamento e pede um reencosto antes de o cursor sair da janela —
   * fora dela não há `mousemove` nenhum e o ponteiro voltaria a ser desenhado.
   */
  const trackAimPoint = useCallback(
    (point: { x: number; y: number }): { x: number; y: number } => {
      if (!directionModeRef.current) return point;
      const { position } = stateRef.current;
      const previous = gestureSampleRef.current;
      gestureSampleRef.current = point;

      const virtual = () => ({
        x: position.x + gestureVectorRef.current.x,
        y: position.y + gestureVectorRef.current.y,
      });

      /**
       * A assinatura do nosso próprio `SetCursorPos`: um salto grande que ATERRA no centro da
       * roda. As duas metades juntas não descrevem mão nenhuma — uma mão que atravesse 120px num
       * só evento não pára em cima do centro — portanto isto identifica o teleporte pelo que ele
       * é, e não por estarmos à espera dele.
       *
       * Tem de ser incondicional. O `WARP` fica em fila enquanto o helper de PowerShell arranca
       * (`writeRadialCursorCommand` guarda-o até ao READY), e o primeiro radial de uma sessão pode
       * abrir antes disso: a bandeira de "estacionamento pendente" expira ao fim de
       * `PARK_TIMEOUT_MS` e o salto chegava DEPOIS, já a ser somado ao vetor como se fosse gesto —
       * a roda a saltar para o lado oposto ao da mão a meio de uma mira.
       */
      const teleported =
        !!previous &&
        Math.hypot(point.x - previous.x, point.y - previous.y) >= PARK_JUMP_PX &&
        Math.hypot(point.x - position.x, point.y - position.y) <= PARK_LANDING_PX;
      if (teleported) {
        gestureParkAtRef.current = 0;
        return virtual();
      }

      if (gestureParkAtRef.current !== 0) {
        /**
         * Estacionamento pedido por nós: a primeira amostra a aterrar no centro fecha a espera e o
         * delta dela morre aqui. Descartar tudo até à aterragem comia o arranque do movimento, que
         * é precisamente onde a sensibilidade alta se joga.
         */
        if (Math.hypot(point.x - position.x, point.y - position.y) <= PARK_LANDING_PX) {
          gestureParkAtRef.current = 0;
          return virtual();
        }
        /** Nenhuma aterragem — sem helper, ou noutro sistema: o gesto segue sem estacionamento. */
        if (Date.now() - gestureParkAtRef.current > PARK_TIMEOUT_MS) {
          gestureParkAtRef.current = 0;
        } else {
          return virtual();
        }
      }

      if (previous) {
        const next = {
          x: gestureVectorRef.current.x + (point.x - previous.x),
          y: gestureVectorRef.current.y + (point.y - previous.y),
        };
        /**
         * Teto do vetor. Só a direção conta — o ponteiro virtual nunca precisa de alcançar o anel
         * de ícones, porque por direção a mira é o setor e não o ícone.
         */
        const clamp = directionCommitRef.current * DIRECTION_CLAMP_FACTOR;
        const length = Math.hypot(next.x, next.y);
        gestureVectorRef.current =
          length > clamp
            ? { x: (next.x / length) * clamp, y: (next.y / length) * clamp }
            : next;
      }

      /**
       * O cursor real continua a andar mesmo depois de o vetor saturar. Reencostá-lo ao centro
       * mantém-no dentro da janela — que é a única superfície onde o conseguimos esconder — e o
       * gesto nem dá por isso, porque só soma deltas.
       */
      if (gestureParkAtRef.current === 0 && window.electron?.parkRadialCursor) {
        const { width, height } = viewportSizeRef.current;
        const strayRadius = Math.max(
          160,
          Math.min(width, height) / 2 - PARK_STRAY_MARGIN_PX,
        );
        if (Math.hypot(point.x - position.x, point.y - position.y) > strayRadius) {
          gestureParkAtRef.current = Date.now();
          window.electron.parkRadialCursor();
        }
      }

      return virtual();
    },
    [],
  );
  /**
   * Uma abertura confirma uma vez. Entre o `onClose` e o render que desmonta os listeners há uma
   * janela em que outro `mouseup` (ou o release do MMB a chegar logo a seguir ao clique) ainda é
   * entregue — e era isso que lançava uma app com o radial já a fechar.
   */
  const gestureConsumedRef = useRef(false);

  /**
   * Resolve o alvo a partir de um ponto concreto, com a mesma matemática do `mousemove`.
   *
   * A confirmação não pode ler `activeIndex`/`isCenterActive` do estado: esses valores percorrem
   * `mousemove` → rAF → `setState` → render → `stateRef`, e o botão pode ser largado antes de esse
   * ciclo fechar. Nesse caso o radial confirmava a fatia onde o cursor ESTEVE, não onde está — daí
   * abrir itens que não foram apontados, e a sensação de clique com atraso. Recalcular no momento
   * do release custa uma raiz quadrada e elimina a corrida por completo.
   */
  const resolveAimAtPoint = useCallback(
    (point: { x: number; y: number } | null): { isCenter: boolean; index: number | null } => {
      const { position, currentLevelApps, config, actualMenuRadius, actualIconSize } =
        stateRef.current;
      if (!point) return { isCenter: true, index: null };

      const deltaX = point.x - position.x;
      const deltaY = point.y - position.y;
      if (Math.hypot(deltaX, deltaY) < aimGateRef.current) {
        return { isCenter: true, index: null };
      }
      if (currentLevelApps.length === 0) return { isCenter: false, index: null };

      const sliceAngle = 360 / currentLevelApps.length;

      /**
       * Modo por cursor: o alvo é o ícone SOB o ponteiro, não a direção em que ele está.
       *
       * Na mira por ângulo, estar do lado direito do ecrã acende o item da direita mesmo com o
       * cursor a centenas de píxeis dele — rápido para quem já sabe onde as coisas estão, e
       * desconcertante para quem não sabe. Aqui nada acende fora do raio do ícone, e largar sem
       * estar sobre nenhum não abre nada.
       *
       * Não se aplica à execução sem clique, e essa exceção é a funcionalidade inteira: não há
       * ponteiro no ecrã para pousar em cima de nada. Aí a roda é uma torta de setores IGUAIS — com
       * dois itens, meio ecrã cada; com quatro, um quadrante cada — e apontar para o lado certo
       * basta, por muito longe que a mão vá. Deixar a definição de mira decidir aqui punha o
       * utilizador a caçar um ícone com um cursor que ele não consegue ver.
       */
      if (config.radialSelectionMode === 'cursor' && !directionModeRef.current) {
        const hitRadius = Math.max(actualIconSize * 0.85, 22);
        let nearest: number | null = null;
        let nearestDistance = Infinity;
        for (let i = 0; i < currentLevelApps.length; i += 1) {
          const itemRad = ((i * sliceAngle) - 90) * (Math.PI / 180);
          const distance = Math.hypot(
            deltaX - actualMenuRadius * Math.cos(itemRad),
            deltaY - actualMenuRadius * Math.sin(itemRad),
          );
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = i;
          }
        }
        return { isCenter: false, index: nearestDistance <= hitRadius ? nearest : null };
      }

      /**
       * Sem limite de distância: apontar é dar uma direção, e a fatia continua a ser o alvo com o
       * cursor no outro extremo do ecrã. Quem quer desistir usa o centro ou o Escape.
       */
      let angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI) + 90;
      if (angle < 0) angle += 360;
      const index = Math.floor(((angle + sliceAngle / 2) % 360) / sliceAngle);
      return {
        isCenter: false,
        index: index >= 0 && index < currentLevelApps.length ? index : null,
      };
    },
    [],
  );

  /**
   * Entrar ou sair de um nível (workspace, pasta, recentes) troca as fatias debaixo de um cursor
   * que não se mexeu — e como o realce só é recalculado em `mousemove`, o novo nível aparecia
   * inteiro apagado até se dar um toque no rato. Aqui a mira é reavaliada na posição real assim
   * que o nível muda, portanto a fatia sob o cursor já chega acesa.
   */
  useLayoutEffect(() => {
    if (!isOpen) return;
    /**
     * Entrar ou sair de um nível desarma a execução sem clique, sem exceção: voltar a armar custa
     * sempre `INSTANT_ARM_DISPLACEMENT_PX` de deslocamento novo e observado. É isto que impede uma
     * execução por tempo de cascatear por pastas encadeadas — e cobre também as trocas de nível
     * que ninguém gesticulou: o `setConfig` atrasado da mudança de workspace com a roda do rato, e
     * uma promessa de MRU a resolver depois de o utilizador já ter navegado para outro lado.
     *
     * `lastPointerRef` fica intocado de propósito: a reavaliação abaixo é o que faz o nível novo
     * chegar já com a fatia sob o cursor acesa.
     */
    levelGenRef.current += 1;
    disarmDwell();
    /** Mudar de nível é navegar, não confirmar: o gesto seguinte tem de voltar a valer. */
    gestureConsumedRef.current = false;
    /**
     * Por direção o nível novo tem de nascer neutro. A direção que abriu a pasta continuava a
     * apontar para o mesmo lado lá dentro, e a mira sustentada abria de imediato o item desse
     * lado — uma pasta encadeava-se na seguinte sem ninguém escolher nada. Zerar o vetor faz o
     * mesmo que a regra de armar já fazia por posição: exigir movimento NOVO.
     */
    if (directionModeRef.current) {
      resetDirectionGesture(false);
      lastPointerRef.current = null;
      lastAnchorPointRef.current = null;
    }
    const aim = resolveAimAtPoint(lastPointerRef.current);
    setIsCenterActive(aim.isCenter);
    setActiveIndex(aim.isCenter ? null : aim.index);
  }, [isOpen, currentLevelApps, folderStack.length, resolveAimAtPoint, disarmDwell, resetDirectionGesture]);

  useEffect(() => {
    if (!isOpen) return;

    /**
     * Abertura nova, ponteiro por conhecer. Sem isto sobrava a posição da abertura ANTERIOR, que
     * está longe do novo centro: largar o botão sem mexer no rato confirmaria uma fatia. `null`
     * resolve para o centro, ou seja, cancelar — o único padrão seguro.
     */
    lastPointerRef.current = null;
    lastAnchorPointRef.current = null;
    /**
     * Por direção o main já mandou o cursor para o centro antes deste `open-menu`. A aterragem
     * desse salto ainda vem a caminho como um `mousemove` — marcá-la como pendente é o que impede
     * o vetor de a somar e apontar para o lado oposto ao da mão.
     */
    resetDirectionGesture(directionModeRef.current);
    gestureConsumedRef.current = false;

    let rafId: number | null = null;

    const processMouseMove = () => {
      rafId = null;
      /**
       * O ponto já foi resolvido no próprio evento: por direção, o vetor do gesto tem de somar
       * TODAS as amostras, e um rAF coalesce-as. Aqui só se lê o resultado.
       */
      const aimPoint = lastPointerRef.current;
      const anchorPoint = lastAnchorPointRef.current;
      if (!aimPoint || !anchorPoint) return;
      const { position, currentLevelApps, hasMoved, activeIndex } = stateRef.current;

      const deltaX = aimPoint.x - position.x;
      const deltaY = aimPoint.y - position.y;
      const distance = Math.hypot(deltaX, deltaY);
      const MOVEMENT_BUFFER = 15;

      if (currentLevelApps.length === 0) {
        /** Nível vazio: não há fatia nenhuma para executar, e `resolveAimAtPoint` devolve índice nulo. */
        cancelDwell();
        if (!hasMoved && distance > MOVEMENT_BUFFER) {
          setHasMoved(true);
        }
        if (distance < aimGateRef.current) {
          if (activeIndex !== null) setActiveIndex(null);
          if (!stateRef.current.isCenterActive) setIsCenterActive(true);
        } else {
          if (stateRef.current.isCenterActive) setIsCenterActive(false);
          if (activeIndex !== null) setActiveIndex(null);
        }
        return;
      }

      if (!hasMoved && distance > MOVEMENT_BUFFER) {
        setHasMoved(true);
      }

      if (distance < aimGateRef.current) {
        /** Voltar ao hub é o gesto de desistir: mata a contagem, mas não o direito de recomeçar. */
        cancelDwell();
        if (activeIndex !== null) setActiveIndex(null);
        if (!stateRef.current.isCenterActive) setIsCenterActive(true);
        return;
      }

      if (stateRef.current.isCenterActive) setIsCenterActive(false);

      /**
       * Uma só matemática para o realce e para a confirmação.
       *
       * Estavam duplicadas, e qualquer divergência entre as duas significa acender um ícone e
       * abrir outro — o pior defeito possível num lançador. Agora ambas passam por aqui.
       */
      const aim = resolveAimAtPoint(aimPoint);
      if (activeIndex !== aim.index) setActiveIndex(aim.index);

      /**
       * Alimentado com o MESMO objeto `aim` que acabou de escrever o realce, no mesmo tique — daí
       * o alvo candidato nunca poder ser outro que não o que está aceso. Ainda assim, quem desenha
       * o anel e quem executa voltam a resolver a mira por sua conta (`startDwell`, `fireDwell`):
       * entre marcar um alvo e abri-lo passa quase meio segundo, e nesse intervalo o nível pode
       * mudar por baixo de um ponteiro que não se mexeu.
       */
      armAndTrackDwellRef.current(anchorPoint, aim);
    };

    const handleMouseMove = (e: MouseEvent) => {
      /** Síncrono: o realce pode esperar pelo próximo frame, a confirmação não. */
      const raw = { x: e.clientX, y: e.clientY };
      lastAnchorPointRef.current = raw;
      lastPointerRef.current = trackAimPoint(raw);
      if (rafId === null) {
        rafId = requestAnimationFrame(processMouseMove);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      /**
       * MMB é tratado exclusivamente pelo IPC `mmb-release` no modo segurar e pelo main no modo
       * clique. Aceitá-lo também aqui fazia o mesmo gesto confirmar a fatia e alternar o modal.
       */
      if (e.button === 1) return;
      if (e.button !== 0) return;
      /** Clique reflexo a chegar depois de uma execução por tempo já ter mudado o que está à vista. */
      if (Date.now() < quarantineUntilRef.current) return;
      if (gestureConsumedRef.current || !stateRef.current.isOpen) return;
      /**
       * Mesma regra do `handleAppClick`: um clique é uma escolha, e o que estava a ser contado
       * deixou de valer. Este caminho tem a sua própria cópia do ramo de recentes assíncrono — em
       * modo ângulo é ELE o caminho normal, porque a fatia é o alvo mesmo com o cursor longe do
       * ícone — e durante essa espera o nível não muda, portanto nada mais desarmaria: o arco
       * continuava a encher sobre um tile que já não vai abrir nada.
       */
      disarmDwell();
      gestureConsumedRef.current = true;
      const { folderStack, apps, currentLevelApps, onClose, config } = stateRef.current;

      /** O alvo é onde a mira está AGORA, não o que o último render chegou a registar. */
      const point = trackAimPoint({ x: e.clientX, y: e.clientY });
      const aim = resolveAimAtPoint(point);
      logRadialConfirm('click', point, aim);
      const selectedItemObj = aim.index !== null ? currentLevelApps[aim.index] : null;

      if (aim.isCenter) {
        if (folderStack.length > 0) {
          const newStack = [...folderStack];
          newStack.pop();
          setFolderStack(newStack);

          if (newStack.length === 0) {
            setCurrentLevelApps(getRootRadialApps(config, apps));
          } else {
            setCurrentLevelApps(newStack[newStack.length - 1].apps);
          }
          setHasMoved(false);
          setIsCenterActive(false);
        } else {
          onClose('__CENTER__');
        }
        return;
      }

      if (selectedItemObj && isWorkspacePickItem(selectedItemObj)) {
        const idx = parseWorkspacePickIndex(selectedItemObj.id);
        if (onWorkspaceSwitch) onWorkspaceSwitch(idx);
        const ws = config.workspaces[idx];
        if (ws?.enabled) {
          const list = ws.apps;
          setFolderStack([{ label: ws.name, apps: list }]);
          setCurrentLevelApps(list);
          setHasMoved(false);
          setActiveIndex(null);
        }
        return;
      }

      const selectedItem = selectedItemObj as any;
      if (!selectedItem) return;
        // Core Folder Integration Logic
        const isKnownIDE = (item: any) => {
          const l = item.label?.toLowerCase() || '';
          return l.includes('antigravity') || l.includes('cursor') || l.includes('vs code') || l.includes('vscode');
        };

        const hasRecentFetch = (selectedItem.hasRecents) && window.electron?.getAppRecents;
        const hasManualFolders = selectedItem.children && selectedItem.children.length > 0;

        if (selectedItem.type === 'folder' && selectedItem.children) {
          // Standard Folder Group
          setFolderStack([...folderStack, { label: selectedItem.label, apps: selectedItem.children }]);
          setCurrentLevelApps(selectedItem.children);
          setHasMoved(false);
          setActiveIndex(null);
        } else if (hasRecentFetch || hasManualFolders) {
          // App with Recents/QuickAccess
          setIsLoadingRecents(true);
          const manualFolders = selectedItem.children || [];

          if (hasRecentFetch) {
            window.electron!.getAppRecents(selectedItem.label, selectedItem.command).then(recents => {
              setIsLoadingRecents(false);
              const seenPathsMap = new Map();
              const seenLabels = new Set();
              manualFolders.forEach(c => {
                 const norm = normalizePathForDedup(c);
                 if (norm) seenPathsMap.set(norm, c.label || c.command);
                 if (c.label) seenLabels.add(c.label.toLowerCase());
              });
              
              const seenPaths = new Set(seenPathsMap.keys());
              
              const seenNormalized = new Set(seenPaths); // Start with manual folders
              const uniqueRecents = recents.filter(r => {
                const normalized = normalizePathForDedup(r);
                if (!normalized) return false;
                
                const isDuplicatePath = seenNormalized.has(normalized);
                const rLabelLower = (r.label || '').toLowerCase();
                const isDuplicateLabel = rLabelLower && seenLabels.has(rLabelLower);
                
                if (isDuplicatePath || isDuplicateLabel) {
                   return false;
                }
                
                seenNormalized.add(normalized);
                if (rLabelLower) seenLabels.add(rLabelLower);
                return true;
              });
              
              const combined = [...manualFolders, ...applyOpenTerminalForRecents(uniqueRecents, selectedItem)];

              if (combined.length > 0) {
                setFolderStack([...folderStack, { label: selectedItem.label, apps: combined }]);
                setCurrentLevelApps(combined);
                setHasMoved(false);
                setActiveIndex(null);
              } else if (selectedItem.hasRecents) {
                setIsLoadingRecents(false);
                const fallback = buildRecentsEmptyFallback(selectedItem);
                setFolderStack([...folderStack, { label: selectedItem.label, apps: fallback }]);
                setCurrentLevelApps(fallback);
                setHasMoved(false);
                setActiveIndex(null);
              } else {
                onClose(selectedItem.id, selectedItem);
              }
            }).catch(() => {
              setIsLoadingRecents(false);
              if (selectedItem.hasRecents) {
                const fallback = buildRecentsEmptyFallback(selectedItem);
                setFolderStack([...folderStack, { label: selectedItem.label, apps: fallback }]);
                setCurrentLevelApps(fallback);
                setHasMoved(false);
                setActiveIndex(null);
              } else {
                onClose(selectedItem.id, selectedItem);
              }
            });
          } else {
            // Only manual folders
            setIsLoadingRecents(false);
            setFolderStack([...folderStack, { label: selectedItem.label, apps: manualFolders }]);
            setCurrentLevelApps(manualFolders);
            setHasMoved(false);
            setActiveIndex(null);
          }
        } else {
          onClose(selectedItem.id, selectedItem);
        }
    };

    /**
     * Cancelar nunca pode executar nada. `closingRef` é escrito aqui, síncrono, porque o sinal
     * "isto está a fechar" só chega ao estado do React depois de `onClose` → `setIsMenuOpen` →
     * batching → render, e um temporizador de mira sustentada sobrevive a essa janela inteira:
     * dispararia contra uma roda que o utilizador já mandou embora.
     */
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        closingRef.current = true;
        cancelDwell();
        stateRef.current.onClose(null);
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      closingRef.current = true;
      cancelDwell();
      onClose(null);
    };

    /** Ver `handleMouseDown`: o trigger a alternar para fechado é um cancelamento como os outros. */
    const handleToggleClose = () => {
      closingRef.current = true;
      cancelDwell();
    };

    /**
     * O ponteiro saiu da janela, ou a janela perdeu o foco.
     *
     * Isto é a ÚNICA defesa contra um alvo abandonado, e tem de ser dirigida por eventos. A janela
     * do radial é uma caixa (~988px), não o ecrã: o ponteiro sai dela facilmente e, a partir daí,
     * `lastPointerRef` fica congelado num ponto que em modo ângulo ainda resolve para uma fatia
     * perfeitamente válida. Comparar carimbos de tempo não serve — uma mão parada também não
     * produz eventos, e estar parado é o gesto.
     */
    const handleWindowBlur = () => disarmDwell();
    const handleDocumentMouseOut = (e: MouseEvent) => {
      if (e.relatedTarget === null) disarmDwell();
    };
    const handleDocumentMouseLeave = () => disarmDwell();

    const handleWheel = (e: WheelEvent) => {
      if (!onWorkspaceSwitch) return;
      const { config, folderStack } = stateRef.current;
      if (config.workspaceSwitchMode === 'picker' && folderStack.length === 0) return;
      const numWorkspaces = config.workspaces.length;
      if (numWorkspaces <= 1) return;

      const currentIndex = config.activeWorkspaceIndex;
      let nextIndex = currentIndex;

      if (e.deltaY < 0) {
        nextIndex = (currentIndex - 1 + numWorkspaces) % numWorkspaces;
      } else if (e.deltaY > 0) {
        nextIndex = (currentIndex + 1) % numWorkspaces;
      }

      if (nextIndex !== currentIndex) {
        const nextWs = config.workspaces[nextIndex];
        if (!nextWs) return;
        const list = nextWs.apps;
        setFolderStack([]);
        setActiveIndex(null);
        setHasMoved(false);
        setCurrentLevelApps(list);
        onWorkspaceSwitch(nextIndex);
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('zenith-radial-toggle-close', handleToggleClose);
    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('mouseout', handleDocumentMouseOut);
    document.addEventListener('mouseleave', handleDocumentMouseLeave);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      cancelDwell();
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('mouseout', handleDocumentMouseOut);
      document.removeEventListener('mouseleave', handleDocumentMouseLeave);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('zenith-radial-toggle-close', handleToggleClose);
      window.removeEventListener('wheel', handleWheel);
    };
  }, [isOpen]);

  // Sync workspace shortcuts state with main process (Fix for initial focus issue)
  useEffect(() => {
    if (window.electron?.setWorkspaceShortcutsState) {
      window.electron.setWorkspaceShortcutsState(
        isOpen,
        config.workspaceSwitchMode === 'picker' ? 'picker' : 'hotkeys',
      );
    }
  }, [isOpen, config.workspaceSwitchMode]);

  // STABLE KEYBOARD LISTENER (Decoupled from interaction states to avoid missing events)
  // NOTE: Workspace switching (1-9) is handled exclusively by global shortcuts registered in
  // the backend (set-workspace-shortcuts IPC). Having a duplicate listener here caused double-firing.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // diagLog(`[RadialMenu.tsx] KeyDown detected: ${e.key}, Ctrl: ${e.ctrlKey}, Alt: ${e.altKey}, Shift: ${e.shiftKey}`);
      if (e.key === 'Escape') {
        e.preventDefault();
        /**
         * One Escape, one thing undone. With something typed, Escape gives back the whole ring —
         * closing the wheel as well would throw away the gesture that opened it over a typo.
         */
        if (typeAheadRef.current) {
          setTypeAhead('');
          return;
        }
        /** Ver `handleMouseDown`: cancelar tem de calar o temporizador antes de o React desmontar. */
        closingRef.current = true;
        cancelDwell();
        onClose(null);
        return;
      }

      if (e.key === 'Backspace') {
        if (!typeAheadRef.current) return;
        e.preventDefault();
        setTypeAhead((current) => current.slice(0, -1));
        return;
      }

      /**
       * A modifier means the key belongs to someone else — Alt+Z reopening the wheel, Ctrl+anything
       * — and a key name longer than one character is Tab, Shift, F5 or an arrow, none of which is
       * a letter someone meant to type.
       */
      const isTypedCharacter =
        e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== ' ';

      // Workspace Switching (1-9) — disabled in picker mode (user chooses workspace on the radial)
      if (
        onWorkspaceSwitch &&
        configRef.current.workspaceSwitchMode !== 'picker'
      ) {
        const num = parseInt(e.key);
        /**
         * The digits stay the workspace keys, and only while nothing has been typed. Once a filter
         * is running they are characters like any other: an app called "Photoshop 2024" cannot be
         * reached if the 2 keeps changing workspace.
         */
        if (!isNaN(num) && num >= 1 && num <= 9 && !typeAheadRef.current) {
          e.preventDefault();
          onWorkspaceSwitch(num - 1);
          return;
        }
      }

      if (isTypedCharacter) {
        e.preventDefault();
        setTypeAhead((current) => (current.length >= 24 ? current : current + e.key));
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, onClose, onWorkspaceSwitch]);

  /**
   * Modo "segurar": a janela abre com o botão do meio ainda premido, e no Windows a captura do rato
   * fica na janela que recebeu o clique — esta não recebe `mousemove` nenhum até ao release, por isso
   * o ângulo nunca atualizava e nada era selecionável. O main sonda o cursor (`mmb-cursor`) e aqui
   * reproduzimo-lo como um `mousemove` real, para alimentar exatamente o mesmo pipeline de mira.
   */
  useEffect(() => {
    if (!isOpen || triggerSource !== 'mmb' || !window.electron?.onMmbCursor) return;

    const cleanup = window.electron.onMmbCursor(({ x, y }) => {
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: x - window.screenX,
          clientY: y - window.screenY,
        }),
      );
    });

    return () => {
      if (cleanup) cleanup();
    };
  }, [isOpen, triggerSource]);

  // MMB Release Logic (Hold to Open -> Release to Execute)
  // Uses stateRef so the native listener is not torn down on every hover (activeIndex) update.
  useEffect(() => {
    if (!isOpen || triggerSource !== 'mmb' || !window.electron?.onMmbRelease) return;
    let delayedReleaseTimer: number | undefined;

    const handleMmbRelease = () => {
      const elapsed = Date.now() - openingTimeRef.current;
      const GRACE_PERIOD_MS = 250; // Ensure menu stays open for at least 250ms to prevent flickers

      const executeClose = () => {
        if (gestureConsumedRef.current || !stateRef.current.isOpen) return;
        gestureConsumedRef.current = true;
        const { folderStack, currentLevelApps, apps, onClose, config } = stateRef.current;

        /** Mesma regra do clique: o alvo sai da posição real, incluindo a sondada pelo main no MMB. */
        const aim = resolveAimAtPoint(lastPointerRef.current);
        logRadialConfirm('mmb-release', lastPointerRef.current, aim);
        const activeIndex = aim.index;

        if (aim.isCenter) {
          if (folderStack.length > 0) {
            const newStack = folderStack.slice(0, -1);
            setFolderStack(newStack);
            if (newStack.length === 0) setCurrentLevelApps(getRootRadialApps(config, apps));
            else setCurrentLevelApps(newStack[newStack.length - 1].apps);
            setHasMoved(false);
            setIsCenterActive(false);
          } else {
            onClose('__CENTER__');
          }
          return;
        }

        const selectedItem = activeIndex !== null ? currentLevelApps[activeIndex] : null;

        if (selectedItem && isWorkspacePickItem(selectedItem)) {
          const idx = parseWorkspacePickIndex(selectedItem.id);
          if (onWorkspaceSwitch) onWorkspaceSwitch(idx);
          const ws = config.workspaces[idx];
          if (ws?.enabled) {
            const list = ws.apps;
            setFolderStack([{ label: ws.name, apps: list }]);
            setCurrentLevelApps(list);
            setHasMoved(false);
            setActiveIndex(null);
          }
          return;
        }

        if (selectedItem) {
          const hasRecentFetch = (selectedItem.hasRecents) && window.electron?.getAppRecents;
          const hasManualFolders = selectedItem.children && selectedItem.children.length > 0;

          if (selectedItem.type === 'folder' && selectedItem.children) {
            setFolderStack(prev => [...prev, { label: selectedItem.label, apps: selectedItem.children! }]);
            setCurrentLevelApps(selectedItem.children);
            setHasMoved(false);
            setActiveIndex(null);
          } else if (hasRecentFetch || hasManualFolders) {
            setIsLoadingRecents(true);
            const manualFolders = selectedItem.children || [];

            if (selectedItem.hasRecents && window.electron?.getAppRecents) {
              window.electron!.getAppRecents(selectedItem.label, selectedItem.command).then(recents => {
                setIsLoadingRecents(false);
                const seenPaths = new Set(manualFolders.map(c => normalizePathForDedup(c)));
                const uniqueRecents = recents.filter(r => {
                  const normalized = normalizePathForDedup(r);
                  return normalized && !seenPaths.has(normalized);
                });
                const combined = [...manualFolders, ...applyOpenTerminalForRecents(uniqueRecents, selectedItem)];

                if (combined.length > 0) {
                  setFolderStack(prev => [...prev, { label: selectedItem.label, apps: combined }]);
                  setCurrentLevelApps(combined);
                  setHasMoved(false);
                  setActiveIndex(null);
                } else if (selectedItem.hasRecents) {
                  setIsLoadingRecents(false);
                  const fallback = buildRecentsEmptyFallback(selectedItem);
                  setFolderStack(prev => [...prev, { label: selectedItem.label, apps: fallback }]);
                  setCurrentLevelApps(fallback);
                  setHasMoved(false);
                  setActiveIndex(null);
                } else {
                  onClose(selectedItem.id, selectedItem);
                }
              }).catch(() => {
                setIsLoadingRecents(false);
                if (selectedItem.hasRecents) {
                  const fallback = buildRecentsEmptyFallback(selectedItem);
                  setFolderStack(prev => [...prev, { label: selectedItem.label, apps: fallback }]);
                  setCurrentLevelApps(fallback);
                  setHasMoved(false);
                  setActiveIndex(null);
                } else {
                  onClose(selectedItem.id, selectedItem);
                }
              });
            } else {
              setIsLoadingRecents(false);
              setFolderStack(prev => [...prev, { label: selectedItem.label, apps: manualFolders }]);
              setCurrentLevelApps(manualFolders);
              setHasMoved(false);
              setActiveIndex(null);
            }
          } else {
            onClose(selectedItem.id, selectedItem);
          }
        } else {
          onClose(null);
        }
      };

      const { hasMoved } = stateRef.current;
      if (!hasMoved && elapsed < GRACE_PERIOD_MS) {
        delayedReleaseTimer = window.setTimeout(executeClose, GRACE_PERIOD_MS - elapsed);
      } else {
        executeClose();
      }
    };

    const cleanup = window.electron.onMmbRelease(handleMmbRelease);
    return () => {
      if (cleanup) cleanup();
      if (delayedReleaseTimer !== undefined) window.clearTimeout(delayedReleaseTimer);
    };
  }, [isOpen, triggerSource, onWorkspaceSwitch]);

  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [weather, setWeather] = useState<{ temp: number; condition: string } | null>(null);

  // Battery & Weather Logic
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const weatherAbort = new AbortController();
    let batteryObj: ZenithBattery | null = null;
    const onBatteryLevel = () => {
      if (cancelled || !batteryObj) return;
      setBatteryLevel(Math.round(batteryObj.level * 100));
    };

    const nav = navigator as Navigator & { getBattery?: () => Promise<ZenithBattery> };
    if (config.showBattery && typeof nav.getBattery === 'function') {
      void nav.getBattery().then((battery) => {
        if (cancelled) return;
        batteryObj = battery;
        setBatteryLevel(Math.round(battery.level * 100));
        battery.addEventListener('levelchange', onBatteryLevel);
      });
    }

    // Real Weather Logic (wttr.in) with 10-minute cache
    if (config.showWeather) {
      const loc = config.weatherLocation || '';
      const now = Date.now();
      const cacheValid = weatherCache.data &&
        weatherCache.location === loc &&
        (now - weatherCache.lastFetch) < WEATHER_TTL_MS;

      if (cacheValid) {
        setWeather(weatherCache.data);
      } else {
        const fetchWeather = async () => {
          try {
            const response = await fetch(`https://wttr.in/${encodeURIComponent(loc)}?format=j1`, {
              signal: weatherAbort.signal,
            });
            if (!response.ok) throw new Error('Weather fetch failed');
            const data = await response.json();
            const current = data.current_condition[0];
            const result = { temp: parseInt(current.temp_C), condition: current.weatherDesc[0].value };
            weatherCache.data = result;
            weatherCache.lastFetch = Date.now();
            weatherCache.location = loc;
            if (!cancelled) setWeather(result);
          } catch (err) {
            if (weatherAbort.signal.aborted) return;
            console.error("Failed to fetch weather:", err);
            if (!cancelled && !weatherCache.data) setWeather({ temp: 0, condition: '---' });
          }
        };
        fetchWeather();
      }
    }

    return () => {
      cancelled = true;
      weatherAbort.abort();
      if (batteryObj) {
        try {
          batteryObj.removeEventListener('levelchange', onBatteryLevel);
        } catch {
          /* ignore */
        }
      }
    };
  }, [isOpen, config.showBattery, config.showWeather, config.weatherLocation]);

  const handleAppClick = React.useCallback((app: AppItem) => {
    /**
     * Este é o caminho do clique real num ícone: o tile trava a propagação, portanto o
     * `handleMouseUp` da janela — que também tem esta guarda — nunca chega a vê-lo.
     *
     * A quarentena é para o clique treinado que o utilizador dá ~200ms DEPOIS de uma execução por
     * tempo já ter descido um nível: sem ela, esse clique executa o que quer que tenha calhado na
     * mesma direção no nível novo. O motor de dwell chama esta função por ref e só marca a
     * quarentena DEPOIS — a guarda nunca bloqueia a sua própria execução, só um clique humano
     * seguinte.
     */
    if (Date.now() < quarantineUntilRef.current) return;
    /**
     * Desarmar aqui, e não só na mudança de nível.
     *
     * Todos os ramos abaixo trocam o nível de forma síncrona — e é o efeito de nível que desarma —
     * MENOS a busca de recentes, que só liga o spinner e espera pelo IPC. Nesse intervalo o nível é
     * o mesmo, a geração é a mesma e nada desarma: um temporizador já a contar sobre este mesmo
     * tile chegava ao fim e empilhava a pasta uma segunda vez, e o gesto continuava armado para
     * lançar o que quer que o ponteiro apanhasse enquanto o utilizador esperava pela pasta que
     * pediu. Um clique é uma escolha; o que estava a ser contado deixou de valer.
     */
    disarmDwell();
    const cfg = configRef.current;
    if (isWorkspacePickItem(app)) {
      const idx = parseWorkspacePickIndex(app.id);
      if (onWorkspaceSwitch) onWorkspaceSwitch(idx);
      const ws = cfg.workspaces[idx];
      if (ws?.enabled) {
        const list = ws.apps;
        setFolderStack([{ label: ws.name, apps: list }]);
        setCurrentLevelApps(list);
        setHasMoved(false);
        setActiveIndex(null);
      }
      return;
    }
    const hasRecentFetch = (app.hasRecents) && window.electron?.getAppRecents;
    const hasManualFolders = app.children && app.children.length > 0;

    if (app.type === 'folder' && app.children) {
      setFolderStack(prev => [...prev, { label: app.label, apps: app.children! }]);
      setCurrentLevelApps(app.children);
      setHasMoved(false);
      setActiveIndex(null);
    } else if (hasRecentFetch || hasManualFolders) {
      setIsLoadingRecents(true);
      const manualFolders = app.children || [];

      if (app.hasRecents && window.electron?.getAppRecents) {
        window.electron!.getAppRecents(app.label, app.command).then(recents => {
          setIsLoadingRecents(false);
          const seenPaths = new Set(manualFolders.map(c => c.command));
          const uniqueRecents = recents.filter(r => !seenPaths.has(r.command));
          const combined = [...manualFolders, ...applyOpenTerminalForRecents(uniqueRecents, app)];

          if (combined.length > 0) {
            setFolderStack(prev => [...prev, { label: app.label, apps: combined }]);
            setCurrentLevelApps(combined);
            setHasMoved(false);
            setActiveIndex(null);
          } else if (app.hasRecents) {
            setIsLoadingRecents(false);
            const fallback = buildRecentsEmptyFallback(app);
            setFolderStack(prev => [...prev, { label: app.label, apps: fallback }]);
            setCurrentLevelApps(fallback);
            setHasMoved(false);
            setActiveIndex(null);
          } else {
            onClose(app.id, app);
          }
        }).catch(() => {
          setIsLoadingRecents(false);
          if (app.hasRecents) {
            const fallback = buildRecentsEmptyFallback(app);
            setFolderStack(prev => [...prev, { label: app.label, apps: fallback }]);
            setCurrentLevelApps(fallback);
            setHasMoved(false);
            setActiveIndex(null);
          } else {
            onClose(app.id, app);
          }
        });
      } else {
        setIsLoadingRecents(false);
        setFolderStack(prev => [...prev, { label: app.label, apps: manualFolders }]);
        setCurrentLevelApps(manualFolders);
        setHasMoved(false);
        setActiveIndex(null);
      }
    } else {
      onClose(app.id, app);
    }
  }, [onClose, onWorkspaceSwitch, disarmDwell]);

  /** `handleAppClick` não é estável; o motor tem de chamar sempre a versão do render atual. */
  const handleAppClickRef = useRef(handleAppClick);
  handleAppClickRef.current = handleAppClick;

  /**
   * Motor da mira sustentada — três regras que não se leem do código.
   *
   * 1. O alvo é a TERNA `{ nível, índice, id }`, nunca só o índice. Uma troca de workspace com a
   *    roda do rato, ou um MRU a resolver tarde, substitui o nível debaixo de um ponteiro parado e
   *    mantém o índice: um temporizador preso ao índice completava e lançava o item N de um nível
   *    que o utilizador nunca chegou a apontar.
   * 2. Ao disparar, a mira é RESOLVIDA DE NOVO e comparada com a do arco. Não coincidindo,
   *    recomeça-se em vez de executar — a decisão é sempre do ponteiro de agora.
   * 3. A frescura mede-se contra o carimbo do evento cru: um ponteiro fora da janela do radial não
   *    produz eventos nenhuns, e em modo ângulo um ponto congelado continua a resolver para uma
   *    fatia perfeitamente válida.
   */
  const fireDwell = useCallback(() => {
    dwellTimerRef.current = null;
    const target = dwellTargetRef.current;
    if (!target) return;
    if (!dwellEnabledRef.current) return void cancelDwell();
    if (closingRef.current || !stateRef.current.isOpen) return void cancelDwell();
    if (paintReadyAtRef.current === null) return void cancelDwell();
    if (target.gen !== levelGenRef.current) return void cancelDwell();

    /**
     * NÃO há verificação de "há quanto tempo não chega um `mousemove`". Parece a defesa óbvia
     * contra um ponteiro que saiu da janela do radial e deixou `lastPointerRef` congelado num
     * ponto que, em modo ângulo, continua a resolver para uma fatia — mas é a defesa errada: uma
     * mão parada não produz eventos nenhuns, e estar parado é EXATAMENTE o gesto. Com essa
     * verificação o arco fechava e nada executava, sempre. Sair da janela é um evento
     * (`mouseout` com `relatedTarget` nulo, `mouseleave`, `blur`) e é aí que está tratado.
     */
    const aim = resolveAimAtPoint(lastPointerRef.current);
    if (aim.isCenter || aim.index === null || aim.index !== target.index) return void cancelDwell();
    const item = stateRef.current.currentLevelApps[aim.index];
    if (!item || item.id !== target.itemId) return void cancelDwell();
    if (gestureConsumedRef.current) return void cancelDwell();
    /**
     * A quarentena da execução ANTERIOR também trava esta.
     *
     * `handleAppClick` já a respeita, mas respeitá-la lá dentro é tarde: a linha abaixo consome o
     * gesto primeiro, e uma chamada que volta sem trocar de nível não deixa nada por trás que o
     * volte a libertar — `gestureConsumedRef` só é limpo na mudança de nível e na abertura. O
     * resultado era uma roda inerte: nem o tempo nem o clique voltavam a confirmar seja o que for.
     *
     * Com o mínimo de 250ms isto era inalcançável, porque a segunda execução mais cedo possível
     * caía em paint+120+250 = 370ms, já fora dos 300ms. Com a espera opcional a segunda execução
     * chega aos ~140ms, e o encadeamento passou a ser trivial: abrir uma pasta com um empurrão
     * deixa a mão ainda a travar, e essa travagem volta a atravessar o limiar lá dentro.
     */
    if (Date.now() < quarantineUntilRef.current) return void cancelDwell();

    gestureConsumedRef.current = true;
    logRadialConfirm('dwell', lastPointerRef.current, aim);
    cancelDwell();
    dwellArmedRef.current = false;
    dwellBaselineRef.current = null;
    /**
     * A quarentena é marcada DEPOIS de executar, nunca antes: `handleAppClick` abre com a mesma
     * guarda, e marcá-la primeiro fazia esta chamada bloquear-se a si própria — o dwell contava,
     * o arco fechava e não acontecia rigorosamente nada. Ela existe para o clique HUMANO seguinte.
     */
    handleAppClickRef.current(item);
    quarantineUntilRef.current = Date.now() + INSTANT_QUARANTINE_MS;
  }, [cancelDwell, disarmDwell, resolveAimAtPoint, logRadialConfirm]);

  /**
   * A mão assentou. Só agora a contagem visível arranca — e é o único ponto em que o arco aparece.
   */
  const startDwell = useCallback(() => {
    dwellSettleTimerRef.current = null;
    const pending = dwellPendingRef.current;
    if (!pending) return;
    if (!dwellEnabledRef.current) return void cancelDwell();
    if (closingRef.current || !stateRef.current.isOpen) return void cancelDwell();
    if (paintReadyAtRef.current === null) return void cancelDwell();
    if (isLoadingRecentsRef.current) return void cancelDwell();
    if (pending.gen !== levelGenRef.current) return void cancelDwell();

    /** Reavaliar: entre agendar e assentar, o nível pode ter mudado por baixo do ponteiro. */
    const aim = resolveAimAtPoint(lastPointerRef.current);
    if (aim.isCenter || aim.index === null || aim.index !== pending.index) return void cancelDwell();
    const item = stateRef.current.currentLevelApps[aim.index];
    if (!item || item.id !== pending.itemId) return void cancelDwell();

    /**
     * Reancorar no ponto em que a mão está AGORA. A âncora anterior é a última amostra em
     * movimento, até 90ms velha: mantê-la fazia a contagem começar já com o orçamento gasto.
     */
    if (lastAnchorPointRef.current) dwellAnchorRef.current = lastAnchorPointRef.current;
    dwellPendingRef.current = null;
    dwellTargetRef.current = pending;
    dwellStartedAtRef.current = Date.now();
    dwellSeqRef.current += 1;
    /** Sem arco não há commit do React nenhum nesta contagem — só o `setTimeout` que executa. */
    if (dwellRunMsRef.current >= DWELL_ARC_MIN_MS) {
      setDwellTick({ index: pending.index, key: dwellSeqRef.current });
    }
    dwellTimerRef.current = window.setTimeout(fireDwell, dwellRunMsRef.current);
  }, [cancelDwell, fireDwell, resolveAimAtPoint]);

  const armAndTrackDwell = useCallback(
    (point: { x: number; y: number }, aim: { isCenter: boolean; index: number | null }) => {
      if (!dwellEnabledRef.current) return void cancelDwell();
      if (closingRef.current || !stateRef.current.isOpen) return void cancelDwell();
      /** A roda ainda não passou por um paint: nenhum tile está clicável, nada pode executar. */
      if (paintReadyAtRef.current === null) return void cancelDwell();
      if (isLoadingRecentsRef.current) return void cancelDwell();

      /** A primeira amostra depois de abrir ou de mudar de nível só serve para pôr a referência. */
      if (dwellBaselineRef.current === null) {
        dwellBaselineRef.current = point;
        /**
         * Por direção esta amostra NÃO se engole. Só se chega aqui depois de o vetor já ter
         * passado o limiar (`processMouseMove` devolve antes disso), portanto esta é a primeira
         * amostra do gesto comprometido — e se a mão parar exatamente aqui, mais nenhuma chega.
         * Devolver deixava a fatia acesa para sempre e nada a executar.
         */
        if (!directionModeRef.current) return;
      }

      if (!dwellArmedRef.current) {
        if (Date.now() - paintReadyAtRef.current < INSTANT_ARM_DELAY_MS) return;
        /**
         * Armar é um facto observado — e por direção o facto já foi observado.
         *
         * O limiar existe porque, mirando por posição, um ponteiro PARADO longe do centro acende
         * uma fatia sem ninguém ter mexido em nada: era preciso ver deslocamento real antes de
         * deixar o tempo executar. Por direção esse estado não existe — o vetor nasce a zero em
         * cada abertura e em cada nível, e a única coisa que o faz passar o limiar da
         * sensibilidade é movimento real da mão. Exigir aqui outro tanto por cima significava
         * pedir o dobro do que a definição anuncia (36px no "alto", 108px no "baixo") e, pior,
         * nunca executar quando a mão comprometia a direção e parava — que é literalmente o gesto
         * que a funcionalidade descreve.
         */
        if (directionModeRef.current) {
          dwellArmedRef.current = true;
        } else {
          const baseline = dwellBaselineRef.current;
          if (Math.hypot(point.x - baseline.x, point.y - baseline.y) < INSTANT_ARM_DISPLACEMENT_PX) {
            return;
          }
          dwellArmedRef.current = true;
        }
      }

      /** O hub nunca executa por tempo: voltar ao centro é o gesto de desistir. */
      if (aim.isCenter || aim.index === null) return void cancelDwell();
      const level = stateRef.current.currentLevelApps;
      /**
       * Um único item em modo ângulo: a fatia é o plano inteiro, e não há direção nenhuma que
       * aponte para outra coisa. Apontar deixa de ser escolher, portanto nada aqui pode contar como
       * intenção — é o caso do nível de recurso do MRU vazio, que existe precisamente para nunca
       * lançar a IDE-mãe sozinho. Em modo cursor o teste é sobre o ícone e continua a valer.
       */
      if (
        level.length === 1 &&
        (directionModeRef.current || stateRef.current.config.radialSelectionMode !== 'cursor')
      ) {
        return void cancelDwell();
      }
      const item = level[aim.index];
      if (!item) return void cancelDwell();

      const next = { gen: levelGenRef.current, index: aim.index, itemId: item.id };
      const running = dwellTargetRef.current ?? dwellPendingRef.current;
      const anchor = dwellAnchorRef.current;
      const sameTarget =
        !!running &&
        running.gen === next.gen &&
        running.index === next.index &&
        running.itemId === next.itemId;
      /** A contar já: tolerância de manter (larga). Ainda a assentar: tolerância de parar (curta). */
      const holdRadius = dwellTargetRef.current !== null ? DWELL_HOLD_PX : DWELL_SETTLE_PX;
      const stillSettled =
        anchor !== null && Math.hypot(point.x - anchor.x, point.y - anchor.y) <= holdRadius;

      /** Mesmo alvo e mão quieta: a contagem em curso continua — o tremor não a faz recomeçar. */
      if (sameTarget && stillSettled) return;

      /**
       * Ainda em movimento, ou alvo novo: recomeça daqui. Enquanto o ponteiro anda, o que se
       * reagenda é só este `setTimeout`; o `cancelDwell` acima já não faz commit nenhum depois do
       * primeiro, por isso arrastar o rato pela roda não custa uma renderização por frame.
       */
      cancelDwell();
      dwellAnchorRef.current = point;
      dwellPendingRef.current = next;
      dwellSettleTimerRef.current = window.setTimeout(startDwell, dwellSettleMsRef.current);
    },
    [cancelDwell, startDwell],
  );

  armAndTrackDwellRef.current = armAndTrackDwell;

  /**
   * A janela Electron é maior que o menu para que gestos largos continuem a receber eventos do rato.
   * O fundo visual, porém, acompanha apenas a roda (ícones + uma pequena margem) e usa a posição real
   * do menu como centro — importante quando o radial abre perto da borda do monitor.
   */
  const bo = config.backdropOpacity;


  const backdropRadius = Math.ceil(
    actualMenuRadius + actualIconSize * 0.75 + Math.max(18, minGap),
  );

  /**
   * A janela é `transparent: true` sobre o desktop, por isso `backdrop-filter` não tem nada para
   * amostrar no Windows — só compomos alfa. Duas consequências de design:
   *
   * 1. A legibilidade NÃO depende do escurecimento: cada ícone e cada pílula já trazem o seu
   *    próprio fundo a 0.92 e borda. O escurecimento serve só para focar. Logo pode ser leve —
   *    e é o peso que produzia o borrão cinzento sobre desktops claros.
   * 2. Nada de alfa uniforme em `inset-0`: pinta o retângulo da janela e denuncia-o como um
   *    quadrado no ecrã. O escurecimento tem de ser só a poça radial, a chegar a zero real
   *    dentro dos limites da janela — sem aresta reta em lado nenhum.
   */
  /** Memoizado: reconstruir a string a cada hover obrigava o Chromium a repintar um gradiente de ecrã inteiro. */
  const overlayDim = React.useMemo(
    () => radialScrimGradient(position, bo, backdropRadius),
    [bo, backdropRadius, position.x, position.y],
  );

  return (
    <div
      data-zenith-radial-modal="true"
      className={`fixed inset-0 z-[70] ${config.performanceMode ? 'zn-radial--fast' : ''} ${isOpen ? '' : 'zn-radial--closing'} ${directionMode ? 'zn-radial--nocursor' : ''}`}
      style={{
        /* Sem atraso ao fechar — senão o HUD do radial ficava visível por cima/atrás da ilha compacta. */
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
      }}
    >
        <>
          {/* Escurecimento único (sem máscara radial — evita halo / “luz” à volta do radial) */}
          <div
            className="zn-radial-scrim fixed inset-0 z-[2]"
            style={{
              pointerEvents: isOpen ? 'auto' : 'none',
              background: overlayDim,
              ['--zn-op' as string]: isOpen && bloom ? 1 : 0,
              ['--zn-dur-op' as string]: isOpen ? '150ms' : '100ms',
              willChange: 'opacity',
            }}
          />

          <RadialHud
            isOpen={isOpen && bloom}
            config={config}
            batteryLevel={batteryLevel}
            weather={weather}
          />

          {/*
            What has been typed, and what it left. Fixed to the viewport rather than hung off the
            ring: the ring's radius changes with every keystroke that changes the match count, and
            a readout that moved while being read would be the one thing worse than no readout.
          */}
          {isOpen && typeAhead && (
            <div className="zn-radial-filter" role="status" aria-live="polite">
              <span className="zn-radial-filter-query">{typeAhead}</span>
              <span className="zn-radial-filter-count">
                {currentLevelApps.length === 0
                  ? 'no matches'
                  : `${currentLevelApps.length} of ${rawLevelApps.length}`}
              </span>
            </div>
          )}

          {/*
            An empty wheel that is empty ON PURPOSE, said in the same place and the same plate as
            the type-ahead readout — the two can never be on screen together, since a filter needs
            something to filter. Only at the root: an empty FOLDER is empty because it is empty.
          */}
          {isOpen && !typeAhead && discoveryPhase !== 'idle' && rawLevelApps.length === 0 && folderStack.length === 0 && (
            <div className="zn-radial-filter is-notice" role="status" aria-live="polite">
              <span className="zn-radial-filter-count">
                {discoveryPhase === 'scanning'
                  ? 'Looking through your Start menu…'
                  : 'Your apps are on their way — this wheel fills itself in a moment.'}
              </span>
            </div>
          )}

          {/* Menu Container */}
          <div
            ref={menuRef}
            style={{
              left: Math.round(position.x),
              top: Math.round(position.y),
              width: 0,
              height: 0,
            }}
            className="fixed z-[10] pointer-events-none"
            tabIndex={-1}
          >

            {/*
              Alvo do centro: um QUADRADO transparente por cima do hub, um pouco maior que ele.
              O hub é `rounded-full`, e o `border-radius` recorta também o teste de acerto — um
              clique no canto da caixa não lhe acerta, atravessa para o overlay e vira direção.
              Era isto que abria a fatia daquele lado com o cursor visivelmente dentro do botão.
              Aqui o alvo não depende de limiar nenhum: dentro do quadrado é sempre o centro.
            */}
            {isOpen && (
              <div
                data-zn-radial-center="true"
                className="absolute top-0 left-0 z-30 pointer-events-auto cursor-pointer"
                style={{
                  width: `${hubHitSize}px`,
                  height: `${hubHitSize}px`,
                  transform: 'translate(-50%, -50%)',
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCenterActivate();
                }}
                aria-hidden
              />
            )}

            {/* Central Hub */}
            <div
              className={`
                zn-radial-hub absolute top-0 left-0
                rounded-full flex items-center justify-center z-20
                ${isOpen ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none cursor-default'}
                ${isCenterActive ? '' : 'text-white/70'}
              `}
              style={{
                /** Lado par: `translate(-50%)` de um ímpar cai em meio-pixel e serrilha o círculo. */
                width: `${hubDiameter}px`,
                height: `${hubDiameter}px`,
                /**
                 * Sem borda e sem anel de 1px. Numa circunferência, uma linha fina de alto
                 * contraste é o que torna cada degrau do antialiasing visível: o olho segue a
                 * linha e vê-a engrossar e afinar. Aqui o disco define-se pelo próprio
                 * preenchimento — uma transição cheio→transparente, que é o caso que o
                 * rasterizador trata melhor — e a separação do desktop vem de sombras DIFUSAS,
                 * que não têm aresta para serrilhar. O fundo sobe de .78 para .90 porque deixou
                 * de haver anel a segurar o contorno sobre um wallpaper claro.
                 */
                backgroundColor: isCenterActive ? radialHoverColor : 'rgba(6,7,9,0.90)',
                /** A borda não é CSS — é um `<circle>` SVG lá dentro. Ver o comentário do anel. */
                border: 'none',
                color: isCenterActive ? radialHoverForeground : undefined,
                boxShadow: isCenterActive
                  ? `0 0 22px ${radialHoverColor}3d, 0 8px 22px rgba(0,0,0,0.55)`
                  : '0 1px 3px rgba(0,0,0,0.55), 0 8px 20px rgba(0,0,0,0.5)',
                ['--zn-tf' as string]: `translate(-50%, -50%) scale(${bloom ? (isCenterActive ? 1.06 : 1) : 0.82})`,
                ['--zn-op' as string]: bloom ? 1 : 0,
                ['--zn-dur' as string]: '130ms',
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
            >
              {/*
                Selo de atualização. Informativo, nunca clicável: o centro é o gesto de fechar, e
                um alvo colado a ele reintroduzia a classe de bugs de cliques trocados que custou
                uma sessão inteira a resolver. A ação vive nas Definições.

                A seta é desenhada, não é um glifo tipográfico: um glifo traz espaçamento lateral e
                linha de base próprios, e num círculo de 24px isso chega para o pôr torto. Os
                pontos abaixo saem dos limites da TINTA — traço de 1.7 com pontas redondas cresce
                0.85 além de cada extremo — e não da geometria nua.
              */}
              {updateReady && (
                <span
                  className="absolute pointer-events-none"
                  style={{
                    top: -Math.round(hubDiameter * 0.03),
                    right: -Math.round(hubDiameter * 0.03),
                    width: Math.round(hubDiameter * 0.32),
                    height: Math.round(hubDiameter * 0.32),
                    borderRadius: '50%',
                    background: '#0A84FF',
                    /** Anel na cor do fundo: separa do hub sem introduzir contorno novo. */
                    border: `${Math.max(2, Math.round(hubDiameter * 0.026))}px solid #0a0a0a`,
                    boxSizing: 'border-box',
                    zIndex: 40,
                  }}
                  aria-label="Update ready"
                >
                  <svg viewBox="0 0 24 24" fill="none" style={{ display: 'block', width: '100%', height: '100%' }}>
                    <path
                      d="M12 7.2V13.6M8.9 10.5L12 13.6l3.1-3.1M7.7 16.7h8.6"
                      stroke="#fff"
                      strokeWidth={1.7}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              )}

              {/*
                O anel é um `<circle>` SVG, não uma `border` CSS.
                São dois rasterizadores diferentes: a borda de uma caixa com `border-radius` é
                desenhada como quatro arcos de canto costurados à volta de um retângulo, e é nessas
                costuras — e na largura fracionária — que aparecem os degraus e a espessura a
                oscilar. Um `<circle>` é UM caminho vetorial, traçado de uma vez pelo Skia com
                `geometricPrecision`: a cobertura é calculada pela distância real ao arco, igual em
                todo o perímetro. `vectorEffect` mantém o traço com a mesma espessura quando o hub
                escala, em vez de o esticar com a textura.
              */}
              <svg
                className="absolute inset-0 pointer-events-none"
                width={hubDiameter}
                height={hubDiameter}
                viewBox={`0 0 ${hubDiameter} ${hubDiameter}`}
                shapeRendering="geometricPrecision"
                aria-hidden
              >
                <circle
                  cx={hubDiameter / 2}
                  cy={hubDiameter / 2}
                  /** Meio traço para dentro: assim o anel fica alinhado com o limite do disco. */
                  r={(hubDiameter - 1.5) / 2}
                  fill="none"
                  stroke={isCenterActive ? radialHoverColor : 'rgba(255,255,255,0.30)'}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>

              {isLoadingRecents ? (
                <div className="flex flex-col items-center justify-center animate-in fade-in duration-300">
                  <div className="w-6 h-6 border-2 border-white/10 border-t-white/60 rounded-full animate-spin" />
                </div>
              ) : isRoot ? (
                <div
                  className={`flex items-center justify-center transition-opacity duration-150 ${isCenterActive ? 'opacity-100' : 'opacity-70'}`}
                >
                  <RovylLogo
                    size={Math.round(actualIconSize * 0.64)}
                    color={isCenterActive ? radialHoverForeground : '#F4F2ED'}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-1">
                  {/* Inside a folder the center remains the explicit Back control. */}
                  <CornerUpLeft size={Math.round(actualIconSize * 0.45)} strokeWidth={1.5} />
                  {!isCenterActive && (
                      <div className="flex gap-0.5 mt-0.5">
                        {folderStack.map((_, i) => (
                          <div key={i} className="w-1 h-1 rounded-full bg-white/40" />
                        ))}
                      </div>
                  )}
                </div>
              )}
            </div>

            {/* Context pill: where you are in the wheel + the gesture that goes back. */}
            <div
              className="zn-radial-pill absolute left-0 top-0 pointer-events-none z-30"
              style={{
                ['--zn-tf' as string]: `translate(-50%, 0) translate3d(0, ${Math.round(
                  actualMenuRadius + actualIconSize * 0.75 + 34,
                )}px, 0)`,
                ['--zn-op' as string]: isOpen && bloom ? 1 : 0,
              }}
            >
              <div
                className="flex items-center gap-2 px-3 py-1.5 rounded-full whitespace-nowrap"
                style={{
                  /* Opaco por si: um wash branco translúcido desaparecia sobre desktops claros. */
                  background: 'rgba(4,5,7,0.92)',
                  border: '1px solid rgba(255,255,255,0.14)',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
                }}
              >
                {/* Inside a workspace its name is enough — "Rovyl" identifies the root. */}
                {(isRoot ? ['Rovyl'] : folderStack.map((level) => level.label)).map((label, i) => (
                  <React.Fragment key={`${label}-${i}`}>
                    {i > 0 && <span className="text-[11px] leading-none text-white/25">/</span>}
                    <span
                      className="text-[11px] leading-none text-white/60"
                      style={{ fontFamily: 'var(--font-radial)', fontWeight: 500 }}
                    >
                      {label}
                    </span>
                  </React.Fragment>
                ))}
                <span
                  className="text-[10px] leading-none text-white/45 px-1.5 py-1 rounded-[5px]"
                  style={{ background: 'rgba(255,255,255,0.09)' }}
                >
                  {isRoot ? centerLabel : uiString('menu.back')}
                </span>
              </div>
            </div>

            {/* App Icons — a troca entre níveis é o próprio bloom (ver efeito `bloom`). */}
            {currentLevelApps.map((app, index) => {
                const isActive = index === activeIndex;
                let angularDistance: number | null = null;
                if (activeIndex !== null) {
                  const raw = Math.abs(index - activeIndex);
                  angularDistance = Math.min(raw, currentLevelApps.length - raw);
                }
                /* Workspace slices carry the 1–9 global shortcut, which was previously invisible. */
                const shortcutHint = isWorkspacePickItem(app)
                  ? String(parseWorkspacePickIndex(app.id) + 1)
                  : undefined;
                return (
                  <RadialMenuItem
                    key={`${app.id}-${folderStack.length}-${index}`}
                    app={app}
                    index={index}
                    isActive={isActive}
                    angularDistance={angularDistance}
                    actualMenuRadius={actualMenuRadius}
                    actualIconSize={actualIconSize}
                    totalApps={currentLevelApps.length}
                    backdropOpacity={config.backdropOpacity}
                    hoverColor={radialHoverColor}
                    showLabels={config.showLabels}
                    alwaysShowAppLabels={config.alwaysShowAppLabels ?? false}
                    folderStackLength={folderStack.length}
                    bloom={isOpen && bloom}
                    shortcutHint={shortcutHint}
                    /** `undefined` em todos os outros tiles — o `React.memo` deles não é invalidado. */
                    dwellMs={dwellTick && dwellTick.index === index ? dwellRunMsRef.current : undefined}
                    dwellKey={dwellTick && dwellTick.index === index ? dwellTick.key : undefined}
                    onClick={handleAppClick}
                  />
                );
              })}
          </div>
        </>
    </div>
  );
};

export const RadialMenu = React.memo(RadialMenuInner);

/**
 * Limites da mira sustentada, partilhados pela roda e pelas definições.
 *
 * Vivem fora de `RadialMenu.tsx` porque o painel de definições é carregado em separado (lazy) e
 * importar a roda inteira só para ler três números arrastava-a para dentro desse pedaço. Terem uma
 * casa só também impede o deslize clássico: o slider a oferecer um intervalo que o motor recorta.
 */
export const DWELL_MS_DEFAULT = 400;
/**
 * Zero é um valor legítimo, não um piso acidental: a espera é opcional. A zero, a direção executa
 * no instante em que se compromete — o gesto passa a ser um empurrão e o tempo de mira sai do
 * caminho. Quem quer uma rede de segurança sobe o número; o topo dá dois segundos inteiros de
 * "aponta e pensa" antes de a roda fazer o que quer que seja.
 */
export const DWELL_MS_MIN = 0;
export const DWELL_MS_MAX = 2000;
export const DWELL_MS_STEP = 50;

/**
 * Um `config-v2.json` editado à mão (a app manda lá o utilizador na mensagem de erro da
 * hidratação) ou um backup de outra origem pode entregar aqui qualquer coisa.
 *
 * NÃO usar `Number(value)` para o decidir. Baixar o mínimo para zero mudou o que a coerção
 * significa: `Number(null)`, `Number('')`, `Number(false)` e `Number([])` são todos `0`, que
 * deixou de ser "fora do intervalo, sobe para o mínimo" e passou a ser a escolha mais agressiva
 * que a roda tem — lançar ao primeiro empurrão. Um ficheiro estragado não pode armar sozinho o
 * gatilho mais rápido do produto; só um número (ou uma string que seja mesmo um número) conta,
 * e tudo o resto volta ao meio-termo do `DWELL_MS_DEFAULT`.
 */
export function clampDwellMs(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return DWELL_MS_DEFAULT;
  return Math.min(DWELL_MS_MAX, Math.max(DWELL_MS_MIN, Math.round(numeric)));
}

/**
 * Sensibilidade da mira por direção.
 *
 * Com a execução sem clique ligada, o ponteiro é escondido e estacionado no centro da roda: o
 * gesto deixa de ser "onde está o cursor" e passa a ser "para onde a mão foi". Estes números são
 * o deslocamento acumulado a partir do centro que uma direção precisa para deixar de ser tremor e
 * passar a ser escolha — nada acende abaixo deles, e é isso que dá o arranque neutro.
 *
 * Vivem ao lado dos tempos de mira porque são a outra metade do mesmo gesto, e o painel de
 * definições (chunk separado) já importa este ficheiro sem arrastar a roda atrás.
 */
export const DIRECTION_SENSITIVITIES = ['low', 'medium', 'high'] as const;

export type DirectionSensitivity = (typeof DIRECTION_SENSITIVITIES)[number];

export const DIRECTION_SENSITIVITY_DEFAULT: DirectionSensitivity = 'medium';

/**
 * Alta é curta de propósito — mas não abaixo de ~16px: um rato de gaming a 1600 DPI produz uma
 * dezena de píxeis só a pousar a mão, e uma roda que escolhe com isso escolhe sozinha.
 */
const DIRECTION_COMMIT_PX: Record<DirectionSensitivity, number> = {
  high: 18,
  medium: 42,
  low: 84,
};

export function clampDirectionSensitivity(value: unknown): DirectionSensitivity {
  return DIRECTION_SENSITIVITIES.includes(value as DirectionSensitivity)
    ? (value as DirectionSensitivity)
    : DIRECTION_SENSITIVITY_DEFAULT;
}

/** Píxeis de deslocamento que a direção atual precisa para acender uma fatia. */
export function directionCommitPx(value: unknown): number {
  return DIRECTION_COMMIT_PX[clampDirectionSensitivity(value)];
}

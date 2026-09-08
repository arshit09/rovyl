/**
 * Limites da mira sustentada, partilhados pela roda e pelas definições.
 *
 * Vivem fora de `RadialMenu.tsx` porque o painel de definições é carregado em separado (lazy) e
 * importar a roda inteira só para ler três números arrastava-a para dentro desse pedaço. Terem uma
 * casa só também impede o deslize clássico: o slider a oferecer um intervalo que o motor recorta.
 */
export const DWELL_MS_DEFAULT = 400;
export const DWELL_MS_MIN = 250;
export const DWELL_MS_MAX = 1200;
export const DWELL_MS_STEP = 50;

/**
 * `??` só apanha `null`/`undefined`, e `Math.round`/`min`/`max` propagam `NaN` sem se queixarem —
 * um `config-v2.json` editado à mão (a app manda o utilizador lá, ver a mensagem de erro da
 * hidratação) ou um backup de outra origem podia entregar aqui uma string, e `setTimeout(fn, NaN)`
 * é especificado como `0`: a roda passava a lançar no primeiro movimento, sem anel e sem espera.
 */
export function clampDwellMs(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return DWELL_MS_DEFAULT;
  return Math.min(DWELL_MS_MAX, Math.max(DWELL_MS_MIN, Math.round(raw)));
}

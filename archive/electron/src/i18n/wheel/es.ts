import type { WheelStrings } from './types';

/** Fetched on demand — never import this from a module the wheel's entry can reach. */
const es: WheelStrings = {
  menuBack: 'Atrás',
  menuCenter: 'Centro',
  menuRecentsFallback: 'Abrir la app (sin carpetas recientes)',
  menuFetchingIcon: 'Obteniendo el icono',
  menuRestartToUpdate: 'Reiniciar para actualizar',
  menuNoMatches: 'sin coincidencias',
  menuFilterCount: '{shown} de {total}',
  menuDiscoveryScanning: 'Revisando tu menú Inicio…',
  menuDiscoveryPending: 'Tus apps están en camino: esta rueda se llena sola en un momento.',
  menuDirectionHint: 'Empuja hacia un objetivo para abrirlo, o pulsa %s para cerrar la rueda.',
  hudOpenSettings: 'Abrir los ajustes de Rovyl',
  hudSettingsTitle: 'Ajustes de Rovyl',
};

export default es;

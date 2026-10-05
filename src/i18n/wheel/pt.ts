import type { WheelStrings } from './types';

/** Fetched on demand — never import this from a module the wheel's entry can reach. */
const pt: WheelStrings = {
  menuBack: 'Voltar',
  menuCenter: 'Centro',
  menuRecentsFallback: 'Abrir o app (sem pastas recentes)',
  menuFetchingIcon: 'Obtendo o ícone',
  menuRestartToUpdate: 'Reiniciar para atualizar',
  menuNoMatches: 'sem resultados',
  menuFilterCount: '{shown} de {total}',
  menuDiscoveryScanning: 'Vasculhando seu menu Iniciar…',
  menuDiscoveryPending: 'Seus apps estão a caminho — esta roda se preenche sozinha em um instante.',
  menuDirectionHint: 'Empurre na direção de um alvo para abri-lo, ou pressione %s para fechar a roda.',
  hudOpenSettings: 'Abrir os ajustes do Rovyl',
  hudSettingsTitle: 'Ajustes do Rovyl',
  dockNetWired: 'Rede com fio',
  dockNetNone: 'Sem rede',
  dockNetOther: 'Conectado',
  dockNetWifiSignal: 'Wi-Fi — {percent}% de sinal',
  dockNetWifi: 'Wi-Fi',
  dockMute: 'Clique para silenciar',
  dockUnmute: 'Mudo — clique para reativar',
  dockVolumeNone: 'Sem dispositivo de áudio',
  dockVolumeLevel: 'Volume {percent}%',
  dockNetOpenSettings: '{name} — clique para as configurações de rede do Windows',
  dockBatteryLevel: 'Bateria {percent}%',
  dockBatteryCharging: 'Bateria {percent}% — carregando',
  dockBatteryAria: 'Bateria {percent} por cento',
  dockMuteAria: 'Silenciar',
  dockUnmuteAria: 'Reativar som',
};

export default pt;

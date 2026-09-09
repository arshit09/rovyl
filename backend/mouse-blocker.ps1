Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class ZenithRadialMouseBlocker {
    private const int WH_MOUSE_LL = 14;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_LBUTTONDBLCLK = 0x0203;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_RBUTTONDBLCLK = 0x0206;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_MBUTTONDBLCLK = 0x0209;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;
    private const int WM_XBUTTONDBLCLK = 0x020D;
    private const int WM_MOUSEHWHEEL = 0x020E;

    private const int MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const int MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const int MOUSEEVENTF_XDOWN = 0x0080;
    private const int MOUSEEVENTF_XUP = 0x0100;

    private const uint SYNCHRONIZE = 0x00100000;
    private const uint INFINITE = 0xFFFFFFFF;

    /** Assinatura dos eventos que nos proprios injetamos, para o hook nao os voltar a engolir. */
    private const uint SYNTHETIC_TAG = 0x524F5659;

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public MOUSEINPUT mi; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    private static readonly ConcurrentQueue<int> Passthroughs = new ConcurrentQueue<int>();
    private static readonly ConcurrentQueue<string> Outbound = new ConcurrentQueue<string>();
    private static readonly AutoResetEvent OutboundSignal = new AutoResetEvent(false);
    private static readonly LowLevelMouseProc Callback = HookCallback;
    private static IntPtr Hook = IntPtr.Zero;
    private static volatile bool Blocking;
    private static int Left, Top, Right, Bottom;
    private static int MonitorLeft, MonitorTop, MonitorRight, MonitorBottom;

    /**
     * Deslocamentos dos campos que o hook precisa de ler. `Marshal.PtrToStructure` encaixotava a
     * MSLLHOOKSTRUCT inteira a CADA evento; com um rato de 1000 Hz isso e lixo para o GC no unico
     * thread por onde passa todo o rato do sistema. Ler tres campos soltos nao aloca nada.
     */
    private static readonly int OffsetPoint = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "pt");
    private static readonly int OffsetMouseData = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "mouseData");
    private static readonly int OffsetExtraInfo = (int)Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "dwExtraInfo");

    /**
     * Captura do botao de disparo.
     *
     * O detetor era um poller de `GetAsyncKeyState` noutro processo, que so OBSERVAVA o botao. O
     * evento seguia intacto para a janela por baixo e, em qualquer superficie com scroll, o
     * Windows entrava em autoscroll: mirar na roda arrastava a pagina atras dela.
     *
     * Um hook que devolve 1 engole o evento -- mas isso tambem esconde o botao do
     * `GetAsyncKeyState`, portanto quem engole tem de ser tambem quem deteta.
     */
    private static volatile int TriggerButton;      // 0 = desligado, 4 = meio, 5 = X1, 6 = X2
    private static volatile bool TriggerHoldMode;   // no modo "click" nunca ha clique a devolver
    private static volatile int TriggerThreshold;   // px; abaixo disto o gesto nao mirou nada
    private static int DownX, DownY;
    private static long DownAt;

    /** Uma pressao mais longa que isto foi intencao de abrir a roda, nao um clique. */
    private const long PASSTHROUGH_MAX_MS = 250;

    /**
     * Modo "click": limiar acima do qual a pressao NAO e nossa.
     *
     * O DOWN foi engolido (ver acima porque tem de ser), logo a janela por baixo nunca soube que o
     * botao desceu -- e sem esse DOWN nao ha deslocamento por roda premida, nem colar do terminal,
     * nem pan em CAD. Passado o limiar premimos o botao por baixo nos proprios e largamo-lo quando
     * o utilizador largar o dele: o gesto chega ao sitio certo, so que com o atraso do limiar.
     *
     * Devolver so no fim (um DOWN+UP juntos na largada) nao serve: o deslocamento ancora no DOWN e
     * vive do movimento DEPOIS dele, portanto entregue no fim nao sobra movimento nenhum -- e no
     * Chrome/Edge um DOWN+UP parado e justamente o gesto que deixa o deslocamento colado ao
     * ponteiro depois de o utilizador ja ter largado.
     *
     * O valor vem do main (MMB_CLICK_MAX_MS) no comando TRIGGER; este e so o recurso.
     */
    private const int DEFAULT_CLICK_HOLD_MS = 400;
    private static volatile int ClickHoldMs = DEFAULT_CLICK_HOLD_MS;
    /**
     * Distancia que prova que a pressao NAO e um clique -- e o sinal que devolve o botao mais
     * depressa do que o tempo consegue.
     *
     * Esperar pelos 400 ms era a queixa: quem preme a roda para deslocar a pagina ficava com ela
     * parada ate o limiar passar. Mas deslocar E mover: no instante em que a mao sai do sitio, a
     * pressao deixou de poder ser um clique, e o botao pode ir para baixo ja. Na pratica o
     * deslocamento comeca assim que ha alguma coisa para deslocar.
     *
     * Bem acima do tremor de uma mao a clicar (abaixo de 10 px, mesmo com DPI alto) e bem abaixo
     * de qualquer gesto de deslocar. Nao e o TriggerThreshold de 6 px, que serve para decidir se um
     * clique curto e devolvido: 6 px aqui roubava cliques a maos tremidas.
     */
    private const int DEFAULT_CLICK_DRAG_PX = 30;
    private static volatile int ClickDragPx = DEFAULT_CLICK_DRAG_PX;
    /** Ha uma pressao em modo "click" a decorrer: DOWN visto, UP ainda por vir. */
    private static volatile bool ClickPressArmed;
    /** Botao cujo DOWN ja injetamos por baixo: devemos-lhe o UP. 0 = nada em divida. */
    private static volatile int ClickInjectedButton;

    /**
     * Que metades do botao a fila de devolucao deve injetar. O par continua a ser o caso do modo
     * "segurar"; as metades soltas sao o modo "click", onde o DOWN sai a meio da pressao e o UP so
     * quando o utilizador larga.
     */
    private const int PT_PAIR = 0;
    private const int PT_DOWN = 1000;
    private const int PT_UP = 2000;

    /**
     * Escrever no stdout a partir do hook e um risco real: se o pai parar de ler, o pipe enche e o
     * `Console.WriteLine` BLOQUEIA -- e o thread bloqueado e justamente o que serve o hook, ou seja,
     * congela o rato de todo o sistema ate ao `LowLevelHooksTimeout`. Enfileirar e devolver e sempre
     * O(1); um thread dedicado faz a escrita.
     */
    private static void Emit(string line) {
        Outbound.Enqueue(line);
        OutboundSignal.Set();
    }

    private static void DrainOutbound() {
        string line;
        while (Outbound.TryDequeue(out line)) {
            Console.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static bool IsBlockedMessage(int message) {
        return message == WM_LBUTTONDOWN || message == WM_LBUTTONUP || message == WM_LBUTTONDBLCLK ||
               message == WM_RBUTTONDOWN || message == WM_RBUTTONUP || message == WM_RBUTTONDBLCLK ||
               message == WM_MBUTTONDOWN || message == WM_MBUTTONUP || message == WM_MBUTTONDBLCLK ||
               message == WM_XBUTTONDOWN || message == WM_XBUTTONUP || message == WM_XBUTTONDBLCLK ||
               message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL;
    }

    /** Qual botao de disparo esta mensagem representa, se algum. 0 = nenhum. */
    private static int TriggerFor(int message, uint mouseData, out bool isDown) {
        isDown = false;
        if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP || message == WM_MBUTTONDBLCLK) {
            isDown = (message != WM_MBUTTONUP);
            return 4;
        }
        if (message == WM_XBUTTONDOWN || message == WM_XBUTTONUP || message == WM_XBUTTONDBLCLK) {
            isDown = (message != WM_XBUTTONUP);
            int which = (int)((mouseData >> 16) & 0xFFFF);
            return which == 2 ? 6 : 5;
        }
        return 0;
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode < 0) return CallNextHookEx(Hook, nCode, wParam, lParam);

        int message = wParam.ToInt32();

        /**
         * Todo o rato do sistema passa por aqui, serializado. O WM_MOUSEMOVE e a esmagadora maioria
         * dos eventos (um rato gaming de 1000 Hz gera mil por segundo) e NUNCA e acionavel: nao esta
         * em `IsBlockedMessage` nem em `TriggerFor`. Sair antes de tocar no lParam poupa o
         * marshalling em ~99% dos eventos.
         */
        if (message == WM_MOUSEMOVE) return CallNextHookEx(Hook, nCode, wParam, lParam);

        int trigger = TriggerButton;
        bool blocking = Blocking;
        /** Sem gatilho armado nem bloqueio ativo nao ha decisao nenhuma a tomar. */
        if (trigger == 0 && !blocking) return CallNextHookEx(Hook, nCode, wParam, lParam);

        ulong extraInfo = IntPtr.Size == 8
            ? (ulong)Marshal.ReadInt64(lParam, OffsetExtraInfo)
            : (ulong)(uint)Marshal.ReadInt32(lParam, OffsetExtraInfo);

        /** Os nossos proprios cliques devolvidos passam sem serem reinterpretados. */
        if ((uint)extraInfo == SYNTHETIC_TAG) {
            return CallNextHookEx(Hook, nCode, wParam, lParam);
        }

        int px = Marshal.ReadInt32(lParam, OffsetPoint);
        int py = Marshal.ReadInt32(lParam, OffsetPoint + 4);

        if (trigger != 0) {
            bool isDown;
            uint mouseData = (uint)Marshal.ReadInt32(lParam, OffsetMouseData);
            int which = TriggerFor(message, mouseData, out isDown);
            if (which == trigger) {
                if (isDown) {
                    DownX = px;
                    DownY = py;
                    DownAt = Environment.TickCount;
                    /** So o modo "click" adia a decisao; o "segurar" resolve tudo na largada. */
                    ClickPressArmed = !TriggerHoldMode;
                    Emit("TRIGGER_DOWN");
                } else {
                    int dx = px - DownX;
                    int dy = py - DownY;
                    long held = Environment.TickCount - DownAt;
                    /**
                     * Environment.TickCount e Int32 e da a volta as ~24.9 dias de uptime. DownAt
                     * guarda ainda o valor grande de antes da volta, portanto held sai a cerca de
                     * -4.29e9 e QUALQUER teste de "foi curto" passava a dar VERDADE: um segurar
                     * longo contava como clique. Uma duracao impossivel de medir conta como
                     * segurar, que e o lado seguro nos dois modos.
                     */
                    if (held < 0) held = int.MaxValue;
                    int threshold = TriggerThreshold;
                    if (TriggerHoldMode) {
                        Emit("TRIGGER_UP");
                        /**
                         * Clique curto e parado: o utilizador nao mirou nada, quis mesmo clicar com
                         * o botao do meio. Devolvemos o clique a janela por baixo -- mas fora do
                         * hook, porque injetar aqui reentraria nele.
                         */
                        if (held <= PASSTHROUGH_MAX_MS &&
                            (dx * dx + dy * dy) <= threshold * threshold) {
                            Passthroughs.Enqueue(PT_PAIR + trigger);
                        }
                    } else {
                        bool armed = ClickPressArmed;
                        ClickPressArmed = false;
                        int injected = ClickInjectedButton;
                        if (injected != 0) {
                            /** O DOWN ja saiu a meio da pressao: largar agora o que fica em divida. */
                            ClickInjectedButton = 0;
                            Passthroughs.Enqueue(PT_UP + injected);
                            Emit("TRIGGER_HOLD");
                        } else if (!armed || held >= ClickHoldMs ||
                                   (dx * dx + dy * dy) >= ClickDragPx * ClickDragPx) {
                            /**
                             * Segurar sem DOWN injetado. Acontece quando o tique de 15 ms ainda nao
                             * chegou a injetar (uma pressao curta mas ja arrastada larga dentro dos
                             * 15 ms), e quando nao houve DOWN emparelhado de todo (hook re-armado
                             * com o botao ja premido, ao mudar de botao ou de modo nas definicoes
                             * com o rato na mao): duracao desconhecida conta como segurar.
                             *
                             * Nao ha DOWN em divida, logo nao ha UP a injetar -- e nao se injeta um
                             * par agora: um arrasto rapido nao e um clique de ninguem, e devolve-lo
                             * no fim so poria um clique do meio num sitio onde a mao ja nao estava.
                             */
                            Emit("TRIGGER_HOLD");
                        } else {
                            Emit("TRIGGER_UP");
                        }
                    }
                }
                return new IntPtr(1);
            }
        }

        if (blocking && IsBlockedMessage(message)) {
            bool insideAllowed = px >= Left && px < Right && py >= Top && py < Bottom;
            bool insideMonitor = px >= MonitorLeft && px < MonitorRight &&
                                 py >= MonitorTop && py < MonitorBottom;
            if (insideMonitor && !insideAllowed) return new IntPtr(1);
        }

        return CallNextHookEx(Hook, nCode, wParam, lParam);
    }

    /**
     * Injeta o botao que engolimos, marcado para o hook o deixar passar. O codigo e PT_PAIR /
     * PT_DOWN / PT_UP somado ao botao, para uma fila so servir os tres casos.
     *
     * Sem MOUSEEVENTF_MOVE nem ABSOLUTE: sai onde o ponteiro estiver, que e o que se quer -- o
     * DOWN do modo "click" tem de ancorar onde a mao esta ao passar o limiar, nao onde ela estava
     * quando o botao desceu.
     */
    private static void SendPassthrough(int code) {
        int trigger = code % 1000;
        int kind = code - trigger;
        uint downFlag, upFlag, data;
        if (trigger == 4) { downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; data = 0; }
        else { downFlag = MOUSEEVENTF_XDOWN; upFlag = MOUSEEVENTF_XUP; data = (uint)(trigger == 6 ? 2 : 1); }

        bool wantDown = kind != PT_UP;
        bool wantUp = kind != PT_DOWN;
        int count = (wantDown ? 1 : 0) + (wantUp ? 1 : 0);
        if (count == 0) return;

        var inputs = new INPUT[count];
        int i = 0;
        if (wantDown) {
            inputs[i].type = 0;
            inputs[i].mi = new MOUSEINPUT { dwFlags = downFlag, mouseData = data, dwExtraInfo = new UIntPtr(SYNTHETIC_TAG) };
            i++;
        }
        if (wantUp) {
            inputs[i].type = 0;
            inputs[i].mi = new MOUSEINPUT { dwFlags = upFlag, mouseData = data, dwExtraInfo = new UIntPtr(SYNTHETIC_TAG) };
        }
        SendInput((uint)count, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    /**
     * Rede de seguranca do botao injetado.
     *
     * Sair, desarmar ou re-armar com o DOWN injetado ainda por baixo deixava o sistema com o botao
     * preso -- e o utilizador nao tem como o largar, porque o botao fisico dele ja foi solto. Toda
     * a saida passa por aqui. (Morto o processo a martelo, o hook morre com ele e ai o proximo
     * clique fisico resolve sozinho.)
     */
    private static void ReleaseInjectedButton() {
        int injected = ClickInjectedButton;
        ClickPressArmed = false;
        if (injected == 0) return;
        ClickInjectedButton = 0;
        SendPassthrough(PT_UP + injected);
    }

    private static void InstallHook() {
        if (Hook != IntPtr.Zero) return;
        using (var process = Process.GetCurrentProcess())
        using (var module = process.MainModule) {
            Hook = SetWindowsHookEx(WH_MOUSE_LL, Callback, GetModuleHandle(module.ModuleName), 0);
        }
    }

    /** O hook fica enquanto houver motivo: bloqueio do radial OU captura do botao de disparo. */
    private static void ReleaseHookIfIdle() {
        if (Blocking || TriggerButton != 0) return;
        if (Hook != IntPtr.Zero) {
            UnhookWindowsHookEx(Hook);
            Hook = IntPtr.Zero;
        }
    }

    private static void DisableBlocking() {
        Blocking = false;
        ReleaseHookIfIdle();
    }

    private static void Apply(string command, ApplicationContext context) {
        var parts = command.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return;

        if (parts.Length == 9 && parts[0] == "BLOCK") {
            int x, y, width, height, monitorX, monitorY, monitorWidth, monitorHeight;
            if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) &&
                int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out y) &&
                int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out width) &&
                int.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out height) &&
                int.TryParse(parts[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out monitorX) &&
                int.TryParse(parts[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out monitorY) &&
                int.TryParse(parts[7], NumberStyles.Integer, CultureInfo.InvariantCulture, out monitorWidth) &&
                int.TryParse(parts[8], NumberStyles.Integer, CultureInfo.InvariantCulture, out monitorHeight)) {
                Left = x; Top = y; Right = x + width; Bottom = y + height;
                MonitorLeft = monitorX; MonitorTop = monitorY;
                MonitorRight = monitorX + monitorWidth; MonitorBottom = monitorY + monitorHeight;
                InstallHook();
                Blocking = Hook != IntPtr.Zero;
            }
        } else if (parts[0] == "UNBLOCK") {
            DisableBlocking();
        } else if (parts[0] == "TRIGGER") {
            // TRIGGER <vk 4|5|6> <hold|click> <threshold px> [click hold ms] [click drag px]
            //   |   TRIGGER OFF
            /** Desarmar ou re-armar a meio de uma pressao nao pode deixar o botao preso. */
            ReleaseInjectedButton();
            if (parts.Length >= 2 && parts[1] == "OFF") {
                TriggerButton = 0;
                ReleaseHookIfIdle();
                Emit("TRIGGER_OFF");
                return;
            }
            int vk, threshold;
            /**
             * O 5.o campo e opcional de proposito: um comando de 4 campos continua a armar o
             * gatilho e cai no limiar por omissao, em vez de ser deixado cair em silencio -- que e
             * o que este parser faz a qualquer comando com um numero de campos inesperado.
             */
            if ((parts.Length >= 4 && parts.Length <= 6) &&
                int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out vk) &&
                int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out threshold)) {
                if (vk != 4 && vk != 5 && vk != 6) vk = 4;
                TriggerHoldMode = parts[2] != "click";
                TriggerThreshold = threshold > 0 ? threshold : 0;
                int clickHold;
                ClickHoldMs = (parts.Length >= 5 &&
                    int.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out clickHold) &&
                    clickHold > 0)
                    ? clickHold
                    : DEFAULT_CLICK_HOLD_MS;
                int clickDrag;
                ClickDragPx = (parts.Length >= 6 &&
                    int.TryParse(parts[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out clickDrag) &&
                    clickDrag > 0)
                    ? clickDrag
                    : DEFAULT_CLICK_DRAG_PX;
                InstallHook();
                TriggerButton = Hook != IntPtr.Zero ? vk : 0;
                Emit(TriggerButton != 0 ? "TRIGGER_READY" : "TRIGGER_FAILED");
            }
        } else if (parts.Length == 3 && parts[0] == "WARP") {
            /**
             * Estacionar o ponteiro (execucao sem clique). `SetCursorPos` nao passa pelo hook nem
             * injeta input -- nao ha reentrancia a proteger e nao acorda o gatilho. Corre no thread
             * do timer, nunca dentro do `HookCallback`, para o rato do sistema nao esperar por ele.
             */
            int wx, wy;
            if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out wx) &&
                int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out wy)) {
                SetCursorPos(wx, wy);
            }
        } else if (parts[0] == "EXIT") {
            ReleaseInjectedButton();
            TriggerButton = 0;
            DisableBlocking();
            context.ExitThread();
        }
    }

    public static void Run(int parentPid) {
        var context = new ApplicationContext();

        var output = new Thread(() => {
            while (true) {
                OutboundSignal.WaitOne();
                DrainOutbound();
            }
        });
        output.IsBackground = true;
        output.Start();

        var input = new Thread(() => {
            string line;
            while ((line = Console.ReadLine()) != null) Commands.Enqueue(line);
            Commands.Enqueue("EXIT");
        });
        input.IsBackground = true;
        input.Start();

        /**
         * Vigia do pai SEM sondagem.
         *
         * O tick do timer chamava `Process.GetProcessById(parentPid)`. No Windows PowerShell
         * (.NET Framework) essa chamada tira um retrato de TODA a tabela de processos: medidos
         * ~12 ms com 350 processos -- num timer de 15 ms, ou seja, 80% do tempo ocupado. E o timer
         * corre no MESMO thread que serve o hook WH_MOUSE_LL, por onde o Windows serializa todo o
         * rato do sistema. Resultado: o ecra inteiro engasgava, nao so o radial.
         *
         * Um handle SYNCHRONIZE mais `WaitForSingleObject` deteta a morte do pai instantaneamente e
         * nao custa absolutamente nada enquanto ele estiver vivo.
         */
        var parentWatch = new Thread(() => {
            IntPtr handle = OpenProcess(SYNCHRONIZE, false, parentPid);
            /** Se o handle falhar, o EOF do stdin continua a ser a rede de seguranca. */
            if (handle == IntPtr.Zero) return;
            WaitForSingleObject(handle, INFINITE);
            CloseHandle(handle);
            Commands.Enqueue("EXIT");
        });
        parentWatch.IsBackground = true;
        parentWatch.Start();

        /** So esvaziar filas: microssegundos por tick, ao contrario do retrato de processos. */
        var timer = new System.Windows.Forms.Timer();
        timer.Interval = 15;
        timer.Tick += (sender, args) => {
            string command;
            while (Commands.TryDequeue(out command)) Apply(command, context);
            /**
             * Modo "click": a pressao deixou de poder ser nossa -- premir o botao por baixo AGORA,
             * com o utilizador ainda a segurar, para que o movimento que se segue chegue a janela e
             * o deslocamento por roda premida funcione.
             *
             * Duas provas, e vale a que chegar primeiro. A do TEMPO cobre quem preme e fica quieto.
             * A da DISTANCIA e a que interessa a quem esta a deslocar: mover a mao ja diz que nao e
             * um clique, e nao ha razao para esperar pelo tempo todo. O ponteiro e lido aqui, com
             * GetCursorPos, e nao no hook -- o caminho do WM_MOUSEMOVE e ~99% dos eventos do
             * sistema e sai antes sequer de tocar no lParam; poe-se codigo la e paga-se em todo o
             * rato do Windows. Aqui custa uma chamada a cada 15 ms, e so enquanto o botao esta em
             * baixo.
             *
             * Este tique corre no MESMO thread que serve o hook (o pump onde ele foi instalado),
             * portanto nao ha concorrencia nenhuma com a largada: ou a injecao ja aconteceu quando
             * o UP chega, ou nao aconteceu de todo.
             */
            int armed = TriggerButton;
            if (armed != 0 && !TriggerHoldMode && ClickPressArmed && ClickInjectedButton == 0) {
                long pressed = Environment.TickCount - DownAt;
                bool overdue = pressed < 0 || pressed >= ClickHoldMs;
                if (!overdue) {
                    POINT now;
                    if (GetCursorPos(out now)) {
                        long ddx = now.x - DownX;
                        long ddy = now.y - DownY;
                        long drag = ClickDragPx;
                        overdue = (ddx * ddx + ddy * ddy) >= drag * drag;
                    }
                }
                if (overdue) {
                    ClickInjectedButton = armed;
                    Passthroughs.Enqueue(PT_DOWN + armed);
                }
            }
            int passthrough;
            while (Passthroughs.TryDequeue(out passthrough)) SendPassthrough(passthrough);
        };
        timer.Start();
        Emit("READY");
        Application.Run(context);
        timer.Stop();
        ReleaseInjectedButton();
        TriggerButton = 0;
        DisableBlocking();
        DrainOutbound();
    }
}
"@

[ZenithRadialMouseBlocker]::Run([int]$args[0])

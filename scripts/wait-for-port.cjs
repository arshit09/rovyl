const net = require('node:net');

/**
 * Waits for a TCP listener, and answers as soon as one accepts.
 *
 * `wait-on` did this job before, at a 250ms poll interval and behind its own 530ms of module
 * loading — so on a warm cache the wheel could sit waiting on a Vite that had been ready for a
 * fifth of a second. A connect attempt is the whole test, so the interval can be short enough
 * that the poll granularity stops being a term in the startup budget.
 */

/**
 * Both loopback families, every time.
 *
 * Vite is configured with the default host, `localhost`, and what that binds to is decided by the
 * resolver rather than by the config: observed here listening on `[::1]:5173` with nothing on
 * `127.0.0.1`, and on IPv4 in another run of the same command. Probing one family therefore fails
 * intermittently and for a reason that looks nothing like the cause — Vite prints its ready banner
 * and the wait times out anyway. Electron is unaffected either way, since it loads
 * `http://localhost:5173` and Chromium tries both.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

const probeHost = (port, host) =>
  new Promise((resolve) => {
    let socket;
    const done = (answered) => {
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(answered);
    };
    try {
      socket = net.connect({ port, host });
    } catch (_) {
      // An unsupported family (a machine with IPv6 disabled) throws rather than emitting 'error'.
      return resolve(false);
    }
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });

const probe = async (port, hosts) => {
  const answers = await Promise.all(hosts.map((host) => probeHost(port, host)));
  return answers.some(Boolean);
};

const hostsFor = (host) => (host ? [host] : LOOPBACK_HOSTS);

/** One round of attempts, for callers that want to know whether something is *already* there. */
const isPortOpen = (port, host) => probe(port, hostsFor(host));

const waitForPort = async (port, { host, interval = 40, timeout = 120000, signal } = {}) => {
  const hosts = hostsFor(host);
  const deadline = Date.now() + timeout;
  for (;;) {
    if (signal && signal.aborted) return false;
    if (await probe(port, hosts)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
};

module.exports = { waitForPort, isPortOpen, LOOPBACK_HOSTS };

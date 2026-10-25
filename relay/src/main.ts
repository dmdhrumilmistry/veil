import { DEFAULTS, startRelay } from './server.ts';

const env = process.env;
const relay = await startRelay({
  port: Number(env.PORT ?? DEFAULTS.port),
  dataDir: env.VEIL_RELAY_DATA ?? DEFAULTS.dataDir,
  trustProxy: env.VEIL_RELAY_TRUST_PROXY === '1',
  contact: env.VEIL_RELAY_CONTACT ?? DEFAULTS.contact,
  messageTtlDays: Number(env.VEIL_RELAY_TTL_DAYS ?? DEFAULTS.messageTtlDays),
});
console.log(`[relay] listening on :${relay.port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void relay.close().then(() => process.exit(0));
  });
}

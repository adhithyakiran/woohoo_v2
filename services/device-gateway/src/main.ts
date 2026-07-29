import { buildApp } from '@woohoo/core';
import { DeviceGateway } from './index.js';

const app = await buildApp();
const gateway = new DeviceGateway({
  app,
  port: Number(process.env.PORT ?? 8443),
});

const port = await gateway.start();
console.log(`device-gateway listening on ws://localhost:${port}  (llm=${app.llm.name})`);
console.log('send: {"type":"hello","deviceId":"d_412a"} then {"type":"turn","transcript":"turn on the lights"}');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void gateway.stop().then(() => process.exit(0));
  });
}

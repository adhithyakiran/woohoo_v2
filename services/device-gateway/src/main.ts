import { buildApp } from '@woohoo/core';
import { DeviceGateway, adminToken, adminTokenIsGenerated } from './index.js';

const app = await buildApp();
const gateway = new DeviceGateway({
  app,
  port: Number(process.env.PORT ?? 8443),
});

const port = await gateway.start();
console.log(`device-gateway listening on ws://localhost:${port}  (llm=${app.llm.name})`);
console.log('send: {"type":"hello","deviceId":"d_412a"} then {"type":"turn","transcript":"turn on the lights"}');
console.log(`room provisioning: POST /v1/admin/rooms   x-admin-token: ${adminToken()}`);
if (adminTokenIsGenerated) {
  // Printed prominently because it changes on every restart. Set WOOHOO_ADMIN_TOKEN to pin it.
  console.log('  (generated for this run - set WOOHOO_ADMIN_TOKEN to keep it stable)');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void gateway.stop().then(() => process.exit(0));
  });
}

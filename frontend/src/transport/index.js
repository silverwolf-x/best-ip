import { createLocalTransport } from "./local.js";
import { createGatewayTransport } from "./gateway.js";

export function createTransport(config = {}, dependencies = {}) {
  return config.mode === "local" ? createLocalTransport(config, dependencies) : createGatewayTransport(config, dependencies);
}
